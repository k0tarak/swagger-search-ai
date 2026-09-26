'use strict';

const abortable = require('./abortable.js');
const { validKey } = require('./key-persistence.js');
const defaultModels = require('./default-models.js');

// OpenRouter can report normalized provider errors inside an HTTP 200 response.
// Keep account/policy failures distinct from failures another model can resolve.
const errors = {
    authentication: [401, 'OpenRouter could not authenticate the request. Check your key.'],
    payment_required: [402, 'OpenRouter reports insufficient credits. Check your account and key limits.'],
    permission_denied: [403, 'OpenRouter denied access. Check key permissions, guardrails, and regional availability.'],
    not_found: [404, 'The configured model or endpoint is unavailable. Check the model ID and provider settings.', true],
    timeout: [408, 'OpenRouter or the model provider timed out. Try again later.', true],
    payload_too_large: [413, 'The request is too large. Reduce ai.contextBudget or shorten the question.'],
    unprocessable: [422, 'OpenRouter could not process the request. Check the model and its supported parameters.'],
    rate_limit_exceeded: [429, 'An OpenRouter or model rate limit was reached. Try again later.', true],
    server: [500, 'OpenRouter or the model provider encountered a server error. Try again later.', true],
    provider_unavailable: [502, 'The model provider is unavailable or returned an invalid response. Try again later.', true],
    provider_overloaded: [503, 'No provider is currently available for the configured model. Try again later.', true],
    invalid_request: [400, 'OpenRouter rejected the request. Check the model and its configured parameters.'],
    invalid_prompt: [400, 'The model could not accept the prompt. Shorten or rephrase the question.'],
    context_length_exceeded: [400, 'The prompt and requested answer exceed the model context window. Reduce ai.contextBudget or the model maxTokens.'],
    max_tokens_exceeded: [400, 'The requested answer exceeds the model output limit. Lower the model maxTokens.'],
    token_limit_exceeded: [402, 'An account or key token budget was exceeded. Check your OpenRouter limits and lower maxTokens.'],
    string_too_long: [400, 'A request field exceeds the model character limit. Shorten the question or reduce ai.contextBudget.'],
    precondition_failed: [412, 'The model requires a condition that this request does not meet. Check its OpenRouter requirements.'],
    content_policy_violation: [403, 'OpenRouter or the model provider blocked the request under its content policy. Rephrase the question.'],
    refusal: [403, 'The model provider declined to answer this request. Rephrase the question.']
};
const statusCodes = { 400: 'invalid_request', 401: 'authentication', 402: 'payment_required',
    403: 'permission_denied', 404: 'not_found', 408: 'timeout', 412: 'precondition_failed',
    413: 'payload_too_large', 422: 'unprocessable', 429: 'rate_limit_exceeded',
    500: 'server', 502: 'provider_unavailable', 503: 'provider_overloaded', 504: 'timeout', 529: 'provider_overloaded' };

function validateModels(models) {
    if (!Array.isArray(models) || !models.length || models.some(model =>
        !model || typeof model.id !== 'string' || !model.id.trim() ||
        (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens < 1)))) {
        throw new TypeError('ai.models must be a nonempty array of { id, name?, reasoning?, provider?, maxTokens? }; maxTokens must be a positive integer');
    }
}

function sanitize(value, key) {
    return typeof value === 'string' ? value.split(key).join('[key hidden]')
        .replace(/sk-or-[\w-]+/gi, '[key hidden]').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 500) : '';
}

function retryDelay(response) {
    const value = response?.headers?.get?.('Retry-After')?.trim();
    if (!value) return undefined;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000
        : /^[A-Za-z]{3},/.test(value) ? Date.parse(value) - Date.now() : NaN;
    return Number.isSafeInteger(delay) && delay >= 0 ? delay : undefined;
}

function failure(code, message, status, httpStatus, retryable = false, retryAfterMs) {
    return Object.assign(new Error(message), { name: 'OpenRouterError', code, status, httpStatus,
        retryable: retryable && !(retryAfterMs > 0),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}

function responseError(response, error, key) {
    const httpStatus = response.status || 200;
    const providerStatus = typeof error?.code === 'number' || typeof error?.code === 'string' ? Number(error.code) : NaN;
    const type = error?.metadata?.error_type;
    const normalized = typeof type === 'string' && Object.hasOwn(errors, type) ? type : undefined;
    const status = httpStatus >= 400 ? httpStatus
        : Number.isInteger(providerStatus) && providerStatus >= 400 && providerStatus <= 599 ? providerStatus
        : normalized ? errors[normalized][0] : 502;
    const code = normalized || statusCodes[status] || 'unknown';
    const retryAfterMs = retryDelay(response);
    let message = errors[code]?.[1] || `OpenRouter returned HTTP ${status}. Check the request and try again later.`;
    let providerRateLimit = false;
    if (status === 429) {
        const source = error?.metadata?.limit_source;
        const platformHeaders = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']
            .some(name => response?.headers?.get?.(name) != null);
        // Explicit platform limits take precedence over incidental provider metadata.
        providerRateLimit = !platformHeaders && (typeof source === 'string' && source.startsWith('upstream_') ||
            !source && typeof error?.metadata?.provider_name === 'string' && !!error.metadata.provider_name.trim());
        message = providerRateLimit
            ? 'The model provider is temporarily rate limited. Another configured model may be available.'
            : platformHeaders || typeof source === 'string' && source.startsWith('openrouter_')
                ? 'An OpenRouter account or platform rate limit was reached. Wait for the limit to reset; switching models will not help.'
                : 'A rate limit was reached, but its scope is unknown. Wait before retrying; automatic model fallback was stopped.';
    }
    const detail = sanitize(typeof error === 'string' ? error : error?.message, key);
    if (status === 401 && /missing\s+authentication\s+header/i.test(detail)) {
        message = 'OpenRouter did not receive the Authorization header. Check your network and retry.';
    } else if (status === 402 && error?.metadata?.limit_source === 'openrouter_in_flight_budget') {
        message = 'OpenRouter temporarily reserved the available budget for requests already in progress. Wait for them to finish.';
    }
    if (detail) message += ` Details: ${detail}`;
    if (retryAfterMs > 0) message += ` OpenRouter asks you to wait at least ${Math.ceil(retryAfterMs / 1000)} seconds before retrying.`;
    // Never move around an account or policy restriction by changing models.
    const retryable = ![401, 402, 403].includes(status) && errors[code]?.[2] === true &&
        (status !== 429 || providerRateLimit);
    return failure(code, message, status, httpStatus, retryable, retryAfterMs);
}

async function completeModel(key, messages, signal, fetcher, model) {
    let body;
    try {
        body = JSON.stringify({ model: model.id, messages, stream: false,
            ...(model.provider ? { provider: model.provider } : {}),
            ...(model.reasoning ? { reasoning: model.reasoning } : {}), max_tokens: model.maxTokens || 8192 });
    } catch {
        throw new TypeError('The model options or messages cannot be serialized as JSON. Check the OpenRouter configuration.');
    }
    const options = {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body
    };
    let response;
    try {
        response = await fetcher('https://openrouter.ai/api/v1/chat/completions', options);
    } catch (error) {
        if (signal?.aborted) throw error;
        // Do not echo custom-fetch errors: they can contain request headers or keys.
        throw failure('network', 'The browser could not reach OpenRouter. Check your connection, CORS, and the page Content Security Policy.', undefined, undefined);
    }
    let data;
    try { data = await response.json(); }
    catch (error) { if (signal?.aborted) throw error; }
    if (response && !response.ok) throw responseError(response, data?.error, key);
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
        throw responseError(response, { metadata: { error_type: 'refusal' } }, key);
    }
    if (data?.error || choice?.error || choice?.finish_reason === 'error') {
        throw responseError(response, data?.error || choice?.error, key);
    }
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
        if (choice?.finish_reason === 'length') {
            throw failure('output_limit', 'The model reached its output limit before returning answer text. Increase maxTokens within the model limit or reduce its reasoning budget.', 502, response.status || 200);
        }
        throw failure('invalid_response', 'OpenRouter returned no answer text or an invalid response. Check model availability.', 502, response?.status || 200, true);
    }
    // Keep notices outside the answer, so its language is entirely the model's.
    return { content: choice.message.content, model: typeof data.model === 'string' ? sanitize(data.model, key) : null,
        truncated: choice.finish_reason === 'length' };
}

async function complete(key, messages, signal, fetcher = globalThis.fetch.bind(globalThis), onFallback = () => {}, models = defaultModels()) {
    validateModels(models);
    if (!validKey(key)) throw new TypeError('The API key must contain up to 512 printable ASCII characters without spaces.');
    // Each question starts with the primary model and uses model-specific options.
    for (let offset = 0; offset < models.length; offset++) {
        if (signal?.aborted) throw signal.reason;
        try { return await abortable(completeModel(key, messages, signal, fetcher, models[offset]), signal); }
        catch (error) {
            if (signal?.aborted || error.retryable !== true || offset + 1 >= models.length) throw error;
            onFallback(models[offset + 1].name || models[offset + 1].id);
        }
    }
}

module.exports = { complete, validateModels };
