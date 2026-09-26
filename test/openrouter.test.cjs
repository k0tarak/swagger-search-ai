'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completeOpenRouter: complete } = require('../dist/index.cjs');
const models = [{ id: 'primary' }, { id: 'backup' }];
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }));
const response = (status, error, headers) => new Response(JSON.stringify({ error }), { status, headers });

test('omitted models use the documented free chain, reasoning and zero-price provider settings', async () => {
    const calls = [], fallbacks = [];
    const answer = await complete('test-key', [], undefined, async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return calls.length < 6 ? response(503, {}) : success();
    }, name => fallbacks.push(name));
    assert.equal(answer.content, 'Done');
    assert.deepEqual(calls.map(call => call.model), ['poolside/laguna-s-2.1:free',
        'nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free',
        'qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free']);
    assert.deepEqual(calls.map(call => call.reasoning), [{ enabled: true, exclude: true },
        { effort: 'high', exclude: true }, { enabled: true, exclude: true },
        { effort: 'medium', exclude: true }, { enabled: true, exclude: true }, { enabled: true, exclude: true }]);
    assert.deepEqual(fallbacks, ['Nemotron 3 Ultra', 'North Mini Code', 'Qwen3.8 27B', 'Gemma 4 31B', 'Gemma 4 26B A4B']);
    for (const call of calls) {
        assert.equal(call.max_tokens, 8192);
        assert.deepEqual(call.provider, { allow_fallbacks: true, sort: 'latency',
            max_price: { prompt: 0, completion: 0, request: 0 } });
    }
    let next;
    await complete('test-key', [], undefined, async (_url, options) => { next = JSON.parse(options.body); return success(); });
    assert.equal(next.model, 'poolside/laguna-s-2.1:free');
});

test('a custom model list completely replaces defaults without inheriting their provider or reasoning settings', async () => {
    const calls = [];
    await assert.rejects(complete('test-key', [], undefined, async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return response(503, {});
    }, undefined, [{ id: 'custom/model', maxTokens: 1000 }]), { status: 503 });
    assert.deepEqual(calls, [{ model: 'custom/model', messages: [], stream: false, max_tokens: 1000 }]);
    for (const models of [[], null]) await assert.rejects(complete('test-key', [], undefined,
        () => assert.fail('An invalid model list must not become a default request'), undefined, models), /ai.models/);
});

test('OpenRouter explains HTTP errors, even when the server returns an HTML error page', async () => {
    const cases = [[400, /configured parameters/], [401, /authenticate/], [402, /credits/],
        [403, /permissions.*guardrails/], [404, /model ID/], [408, /timed out/],
        [413, /contextBudget/], [422, /supported parameters/], [429, /rate limit/],
        [500, /server error/], [502, /provider is unavailable/], [503, /No provider/],
        [504, /timed out/], [418, /HTTP 418/]];
    for (const [status, explanation] of cases) {
        await assert.rejects(complete('test-key', [], undefined,
            async () => new Response('<html>DO NOT DISPLAY THIS</html>', { status }), undefined, [models[0]]), error => {
            assert.match(error.message, explanation);
            assert(!error.message.includes('DO NOT DISPLAY'));
            assert.equal(error.status, status);
            assert.equal(error.httpStatus, status);
            assert.equal(error.name, 'OpenRouterError');
            return true;
        });
    }
});

test('authentication, credits and forbidden responses never switch models', async () => {
    for (const status of [401, 402, 403]) {
        let attempts = 0;
        await assert.rejects(complete('test-key', [], undefined, async () => {
            attempts++;
            return response(status, { code: status, message: 'Denied' });
        }, () => assert.fail('Must not fall back'), models), { status, retryable: false });
        assert.equal(attempts, 1);
    }
});

test('provider rate limits fall back, including errors inside HTTP 200, and are retried on new questions', async () => {
    for (const status of [200, 429]) for (const metadata of [
        { limit_source: 'upstream_provider_shared_pool' }, { provider_name: 'Example Provider' }
    ]) {
        const calls = [];
        const fetcher = async (_url, options) => {
            const model = JSON.parse(options.body).model;
            calls.push(model);
            return model === 'primary' ? response(status, { code: 429, metadata }) : success();
        };
        for (let i = 0; i < 2; i++) assert.equal((await complete('test-key', [], undefined, fetcher, undefined, models)).content, 'Done');
        assert.deepEqual(calls, ['primary', 'backup', 'primary', 'backup']);
    }
});

test('account, platform and unknown rate limits stop without exhausting the model chain', async () => {
    for (const status of [200, 429]) for (const metadata of [
        { limit_source: 'openrouter_free_models_per_day', provider_name: 'Example Provider' },
        { limit_source: 'openrouter_free_models_per_minute' },
        { limit_source: 'unrecognized_scope', provider_name: 'Example Provider' }, {}
    ]) {
        let calls = 0;
        await assert.rejects(complete('test-key', [], undefined, async () => {
            calls++;
            return response(status, { code: 429, metadata });
        }, () => assert.fail('Must not fall back'), models), error => {
            assert.equal(error.status, 429);
            assert.equal(error.retryable, false);
            assert.match(error.message, metadata.limit_source?.startsWith('openrouter_') ? /switching models will not help/ : /scope is unknown/);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('platform headers and Retry-After override provider rate-limit fallback', async () => {
    for (const headers of [{ 'X-RateLimit-Remaining': '0' }, { 'X-RateLimit-Limit': '20' },
        { 'X-RateLimit-Reset': '1900000000' }, { 'Retry-After': '30' }]) {
        let calls = 0;
        await assert.rejects(complete('test-key', [], undefined, async () => {
            calls++;
            return response(429, { metadata: { limit_source: 'upstream_provider_shared_pool' } }, headers);
        }, undefined, models), error => {
            assert.equal(error.retryable, false);
            assert.match(error.message, headers['Retry-After'] ? /wait at least 30 seconds/ : /switching models will not help/);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('HTTP 200 errors retain their status, normalized type and redacted detail', async () => {
    for (const envelope of ['top', 'choice']) {
        let attempts = 0;
        const providerError = { code: '403', message: 'Blocked secret-key <script>test</script>',
            metadata: { error_type: 'permission_denied', raw: 'PRIVATE PROVIDER PAYLOAD', flagged_input: 'PRIVATE PROMPT' } };
        await assert.rejects(complete('secret-key', [], undefined, async () => {
            attempts++;
            return new Response(JSON.stringify(envelope === 'top' ? { error: providerError }
                : { choices: [{ error: providerError, finish_reason: 'error' }] }));
        }, undefined, models), error => {
            assert.equal(error.status, 403);
            assert.equal(error.httpStatus, 200);
            assert.equal(error.code, 'permission_denied');
            assert.equal(error.retryable, false);
            assert.match(error.message, /Blocked \[key hidden\]/);
            assert(!error.message.includes('secret-key'));
            assert(!error.message.includes('PRIVATE'));
            return true;
        });
        assert.equal(attempts, 1);
    }
});

test('normalized errors explain how to fix context, output and account limits without model fallback', async () => {
    const cases = [['context_length_exceeded', /context window.*contextBudget/],
        ['max_tokens_exceeded', /Lower the model maxTokens/], ['token_limit_exceeded', /account or key token budget/],
        ['string_too_long', /character limit/], ['invalid_request', /configured parameters/],
        ['invalid_prompt', /rephrase/], ['content_policy_violation', /content policy/], ['refusal', /declined/]];
    for (const [type, explanation] of cases) {
        let calls = 0;
        await assert.rejects(complete('test-key', [], undefined, async () => {
            calls++;
            return response(200, { metadata: { error_type: type } });
        }, undefined, models), error => {
            assert.equal(error.code, type);
            assert.match(error.message, explanation);
            assert.equal(error.retryable, false);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('transient failures inside HTTP 200 can fall back, with fresh priority on the next question', async () => {
    const calls = [], fallbacks = [];
    const fetcher = async (_url, options) => {
        const model = JSON.parse(options.body).model;
        calls.push(model);
        return model === 'primary' ? response(200, { metadata: { error_type: 'provider_overloaded' } }) : success();
    };
    for (let i = 0; i < 2; i++) {
        assert.equal((await complete('test-key', [], undefined, fetcher, name => fallbacks.push(name), models)).content, 'Done');
    }
    assert.deepEqual(calls, ['primary', 'backup', 'primary', 'backup']);
    assert.deepEqual(fallbacks, ['backup', 'backup']);
});

test('Retry-After stops automatic fallback and supplies the requested wait for 429, 503 and reserved budgets', async () => {
    for (const status of [429, 503, 402]) {
        let calls = 0;
        await assert.rejects(complete('test-key', [], undefined, async () => {
            calls++;
            return response(status, { metadata: { limit_source: 'openrouter_in_flight_budget' } }, { 'Retry-After': '60' });
        }, undefined, models), error => {
            assert.equal(error.retryAfterMs, 60000);
            assert.equal(error.retryable, false);
            assert.match(error.message, /wait at least 60 seconds/);
            if (status === 402) assert.match(error.message, /requests already in progress/);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('Retry-After supports HTTP dates and ignores malformed values', async () => {
    const future = new Date(Date.now() + 120000).toUTCString();
    await assert.rejects(complete('test-key', [], undefined,
        async () => response(503, {}, { 'Retry-After': future }), undefined, models), error => {
        assert(error.retryAfterMs > 110000 && error.retryAfterMs <= 120000);
        assert.equal(error.retryable, false);
        return true;
    });
    for (const value of ['nonsense', '-1', '999999999999999999999999', '0']) {
        let calls = 0;
        const result = await complete('test-key', [], undefined,
            async () => ++calls === 1 ? response(503, {}, { 'Retry-After': value }) : success(), undefined, models);
        assert.equal(result.content, 'Done');
        assert.equal(calls, 2);
    }
});

test('refusal and content filters in successful responses never fall back', async () => {
    for (const choice of [{ finish_reason: 'content_filter', message: { content: 'Partial answer' } },
        { finish_reason: 'stop', message: { content: '', refusal: 'Sensitive refusal detail' } },
        { finish_reason: 'content_filter', error: { code: 502, message: 'Provider failed' } }]) {
        let calls = 0;
        await assert.rejects(complete('test-key', [], undefined, async () => {
            calls++;
            return new Response(JSON.stringify({ choices: [choice] }));
        }, undefined, models), error => {
            assert.equal(error.code, 'refusal');
            assert.equal(error.retryable, false);
            assert(!error.message.includes('Sensitive'));
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('unserializable model configuration fails clearly before network access', async () => {
    const provider = {};
    provider.circular = provider;
    await assert.rejects(complete('test-key', [], undefined, () => assert.fail('Must not send invalid configuration'),
        undefined, [{ id: 'primary', provider }, models[1]]), { name: 'TypeError', message: /serialized as JSON/ });
});

test('malformed success payloads can recover with the next model', async () => {
    for (const body of ['not json', 'null', '{}', '{"choices":[{"finish_reason":"error"}]}']) {
        let calls = 0;
        const result = await complete('test-key', [], undefined,
            async () => ++calls === 1 ? new Response(body) : success(), undefined, models);
        assert.equal(result.content, 'Done');
        assert.equal(calls, 2);
    }
});

test('truncated answer text keeps its language, while an exhausted reasoning budget explains the problem', async () => {
    const text = 'Используйте `ListBooks`.';
    const result = await complete('test-key', [], undefined, async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: text } }]
    })), undefined, models);
    assert.equal(result.content, text);
    assert.equal(result.truncated, true);
    let calls = 0;
    await assert.rejects(complete('test-key', [], undefined, async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
    }, undefined, models), error => {
        assert.equal(error.code, 'output_limit');
        assert.match(error.message, /reasoning budget/);
        assert.equal(error.retryable, false);
        return true;
    });
    assert.equal(calls, 1);
});

test('network failures and provider details cannot expose a key through the error message', async () => {
    let calls = 0;
    await assert.rejects(complete('secret-key', [], undefined, async () => {
        calls++;
        throw new TypeError('Authorization: Bearer secret-key');
    }, undefined, models), error => {
        assert.equal(error.code, 'network');
        assert.match(error.message, /CORS.*Content Security Policy/);
        assert(!error.message.includes('secret-key'));
        return true;
    });
    assert.equal(calls, 1);
    await assert.rejects(complete('secret-key', [], undefined, async () => response(400, {
        message: 'secret-key\nSK-OR-another-key\u0000' + 'x'.repeat(1000)
    }), undefined, models), error => {
        assert(!error.message.includes('secret-key'));
        assert(!error.message.includes('SK-OR-another-key'));
        assert(!/[\n\u0000]/.test(error.message));
        assert(error.message.length < 650);
        return true;
    });
});

test('cancellation while reading the response releases the caller without falling back', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = complete('test-key', [], controller.signal, async () => {
        calls++;
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
    }, undefined, models);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 1);
});
