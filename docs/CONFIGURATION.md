# Configuration reference

[Back to the README](../README.md)

- [Search and assistant options](#search-and-assistant-options)
- [Default models](#default-models)
- [Retrieval vocabulary](#retrieval-vocabulary)
- [OpenRouter errors and model fallback](#openrouter-errors-and-model-fallback)
- [API key persistence](#api-key-persistence)
- [Browser behavior and limits](#browser-behavior-and-limits)
- [Multiple OpenAPI documents](#multiple-openapi-documents)

## Search and assistant options

Ordinary search has its own optional configuration, independent of the assistant:

```js
const extension = createSwaggerSearch({
  element: document.getElementById('search-controls'),
  search: {
    limit: 40,                       // 1-200 visible results
    fuzzy: true,                     // try typo recovery if literal search is empty
    synonyms: ['purchase procurement', 'book volume'],
    stopWords: ['please'],
    // Optional: map a lowercase word to a single stable term.
    normalizeTerm: word => word
  },
  catalogTimeoutMs: 30000            // deadline per background specification download
});
```

The same options work with `mount`. Omit `normalizeTerm` to keep the built-in English plural handling and accent-insensitive matching; providing a function replaces plural handling. `synonyms` groups individual interchangeable words, not phrases. Defaults include common action equivalents such as delete/remove. Search matches operations, schema names, field names and descriptions, parameters, inline request/response contracts, enum values, and internal references. Inline contract matches open their owning operation. Literal names and direct fields rank above indirect contract matches. Results require all meaningful query terms, so add API-specific vocabulary for words absent from the document.

For a custom UI, `buildSearchIndex(spec, searchOptions)` retains these options on the returned index. `search(index, query, limit?)` returns `{ total, entries }`; `total` counts all matches before the result limit. Keep the original index array to retain its configuration.

All search and assistant settings are optional. `ai: true` and `ai: {}` enable the same defaults; an options object overrides only the settings you supply. Omitted `ai` or `ai: false` disables the assistant. For example, `ai: { contextBudget: 16000 }` keeps the default models and changes only the retrieved context limit.

| Setting | Default |
| --- | --- |
| `search.limit` | 40 results |
| `search.fuzzy` | `true`, one-edit recovery when literal search is empty |
| `ai.contextBudget` | 24000 characters |
| `ai.minScoreRatio` | 0.45, minimum candidate score relative to the best match |
| `ai.timeoutMs` | 120000 ms, including fallbacks |
| Model `maxTokens` | 8192 tokens |
| API key persistence | Memory only |

### Default models

The default chain tries these models in order. Temporary provider failures may advance to the next model as described below:

| OpenRouter model ID | Reasoning |
| --- | --- |
| `poolside/laguna-s-2.1:free` | `{ enabled: true, exclude: true }` |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `{ effort: 'high', exclude: true }` |
| `cohere/north-mini-code:free` | `{ enabled: true, exclude: true }` |
| `qwen/qwen3.8-27b:free` | `{ effort: 'medium', exclude: true }` |
| `google/gemma-4-31b-it:free` | `{ enabled: true, exclude: true }` |
| `google/gemma-4-26b-a4b-it:free` | `{ enabled: true, exclude: true }` |

Each default model uses `maxTokens: 8192` and `provider: { allow_fallbacks: true, sort: 'latency', max_price: { prompt: 0, completion: 0, request: 0 } }`. This requests free endpoints with a zero-price ceiling, without switching to paid variants or a random model router. Default settings are fixed in the package version; opening the page does not fetch a model catalog. Free model availability and rate limits can change.

Free providers can retain or use submitted data. Laguna's free endpoint may use inputs and outputs for training; NVIDIA's free endpoint prohibits confidential and personal data. Review the [Laguna](https://openrouter.ai/poolside/laguna-s-2.1:free) and [Nemotron](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free) terms before using private specifications, and configure appropriate providers for your data.

For HTTP 429, the client uses structured error metadata and exposed rate-limit headers. Explicit upstream limits (or legacy provider attribution without a conflicting limit source) may fall back to the next configured model. OpenRouter account/platform limits stop the chain. Unknown limit scopes also stop rather than repeatedly consume requests. A positive `Retry-After` stops automatic fallback and is shown to the user. Each new question starts at the first model; temporary failures do not permanently blacklist a model.

To use your own models, provide `ai.models`. It **replaces the entire default chain**; it must be a nonempty ordered array. Each entry requires an OpenRouter `id`; optional fields are `name`, `reasoning`, `provider`, and `maxTokens`. Custom entries do not inherit the default models' reasoning or free-provider restrictions. Omitted `maxTokens` still means 8192. Set provider restrictions explicitly if your custom chain must remain free:

```js
ai: {
  models: [{
    id: 'your-provider/model-id',
    maxTokens: 4096,
    reasoning: { enabled: false }
  }]
}
```

### Retrieval vocabulary

The optional `ai.synonyms` and `ai.aliases` add vocabulary from **your** API:

```js
ai: {
  synonyms: ['purchase order order procurement'],
  aliases: [
    ['purchase order|PO', 'PurchaseOrder|OrderRecord']
  ]
}
```

`synonyms` is a list of groups of interchangeable words. Each `aliases` entry is `[query phrases, technical names, related names?]`; use `|` between alternatives. Keep domain vocabulary in the application configuration. The package includes no project-specific dictionary.

These options affect the assistant's retrieval. For applications with different word forms or writing systems, `ai.normalizeTerm(word)` can map a lowercased word to a stable search term. `ai.stopWords` and `ai.actionTerms` extend the built-in query categories; `ai.technicalTermKey(word)` can map a query term to a key formed from technical names in the OpenAPI document. Keep these functions deterministic and return one nonempty word. Ordinary search uses `search` configuration and does not apply the assistant's vocabulary settings. The assistant understands common action equivalents such as delete/remove, but includes no API-specific dictionary.

`ai.minScoreRatio` accepts a value from 0 to 1 (default 0.45). Lower values include weaker candidates alongside the best match, which can help ambiguous terminology at the cost of more unrelated context. The source count and context budget remain bounded. Use representative queries to choose this value; the same option is accepted by `buildAssistantIndex`.

`ai.timeoutMs` sets the deadline for an answer, including fallbacks (default 120000). `ai.contextBudget` caps retrieved context in characters (default 24000, minimum 200). `ai.fetch` optionally supplies a fetch-compatible function. Context characters are not model tokens. Ensure the chosen model can accommodate the question, context, and output allowance. **Check connection** uses the same model chain and makes a model request; custom paid models can incur a charge.

The assistant is instructed to answer in the language of the question, unless the user explicitly requests another language. Technical names, paths, enum values, and code remain as documented. The controls and status messages are English. Retrieval does not translate queries: questions in a different language from the documentation may need technical identifiers or configured aliases to find relevant fragments. The selected model still determines language quality.

### OpenRouter errors and model fallback

OpenRouter is the supported provider. The client checks both HTTP errors and error objects inside HTTP 200 responses, including per-choice errors and normalized provider error types. It displays an explanation and a bounded, redacted provider message as text; it does not display raw provider metadata or flagged input. See [OpenRouter error handling](https://openrouter.ai/docs/api_reference/errors-and-debugging).

| Failure | Behavior |
| --- | --- |
| Invalid key / 401 | Ask the user to check the key; do not switch models |
| Credits, key budgets / 402 | Explain account limits; distinguish temporarily reserved in-flight budgets; do not switch models |
| Access, guardrails, moderation / 403 or a refusal | Explain the restriction; do not switch models |
| Invalid parameters, context/output limits, oversized requests | Explain which configuration or question size to adjust; do not retry automatically |
| Model unavailable, timeout or transient provider/server failure | Try the next configured model, if any, within the original deadline |
| Provider-scoped 429 | Try the next model unless a platform limit or positive Retry-After is also present |
| Account/platform 429 or unknown limit scope | Explain the limit and stop; do not try the remaining models |
| A positive `Retry-After` header | Display the requested wait and stop automatic fallback; no retry is scheduled |
| Network, CORS or CSP failure | Explain browser connectivity checks; do not automatically repeat a request whose delivery is uncertain |
| Empty or malformed successful response | Try the next configured model, except when the output budget was exhausted |

`Retry-After` supports both seconds and HTTP dates when the header is readable by the browser (cross-origin responses must expose it). Each fallback is a separate request and can incur a charge for custom paid models. A new question starts with the primary model again.

When an answer hits its output limit, the client preserves the original answer text and shows a separate warning. The model's `maxTokens` defaults to 8192; with reasoning models, reasoning may consume this allowance before any answer text is returned. Adjust the model's output/reasoning settings rather than repeatedly sending the same request.

For custom UIs, `completeOpenRouter` returns `{ content, model, truncated }` and uses the same default chain when its `models` argument is omitted. OpenRouter errors have `name: 'OpenRouterError'`, `code`, `status` (including a provider error inside HTTP 200), `httpStatus`, `retryable`, and optional `retryAfterMs`. Network errors omit the statuses. Invalid configuration or keys throw `TypeError`; cancellation preserves the abort signal's reason. TypeScript exports the `OpenRouterResult` and `OpenRouterError` interfaces.

### API key persistence

The API key is kept only until the page closes by default. A host can offer explicit persistence choices in the connection UI:

```js
ai: {
  keyPersistence: { url: true, localStorage: true }
}
```

Both settings default to `false`. Enabling one only makes that choice available; the browser user must select it. `url` uses the legacy `ORT` query parameter, encoded as Base64URL. This is reversible encoding, not encryption: the key can appear in copied links, browser history, logs, or referrer data. `localStorage` keeps the key in plain text for this site's origin across browser restarts; any script on the same origin can read it. We recommend leaving both disabled unless users need them and understand those risks. Selecting another mode removes saved copies from enabled modes, and **Remove key** clears the input and enabled storage modes. Browser privacy settings may prevent URL or local storage writes; the UI reports failures.

To omit the assistant entirely, leave out `ai` or set it to `false`. The plain search remains available. For custom UIs, the root entry also exports `buildSearchIndex`, `search`, `buildAssistantIndex`, `retrieve`, and `completeOpenRouter`.

## Browser behavior and limits

The integration is tested with **Swagger UI 5.33.0**, HTTP operations from Swagger 2.0 and OpenAPI 3.0/3.1, and JSON/YAML documents. Support for all OpenAPI 3.2 features, webhooks, callbacks, external reference resolution, or customized Swagger layouts is not claimed. Test a host's pinned Swagger UI version before rollout. Internal schemas with recursive references are supported; traversal of deeply nested schemas is bounded.

- Search covers HTTP operations, schemas that are not referenced by any operation, fields, compositions, and recursive internal references. Multiple APIs are indexed in the browser, up to four concurrently; the assistant sends only selected fragments from the active API, capped at 24,000 characters by default.
- A browser user enters their own OpenRouter key. By default, the key stays in the page's input while the page is open. It is sent directly to OpenRouter with `fetch`. Other scripts running on the same page can access the DOM, so host only trusted scripts. Optional URL and browser storage modes are described above.
- Serve the page and OpenAPI document over HTTP(S). The OpenAPI URL must be reachable under the browser's CORS rules. If you use a restrictive CSP, allow your script and style sources, the OpenAPI URL, and `https://openrouter.ai` in `connect-src` when AI is enabled.
- Retrieval is lexical and heuristic. It is not semantic search or proof that an operation or feature is absent. The model may still make mistakes; verify answers against the linked contracts.
- Internal `#/...` references are supported. External referenced documents are not fetched by the retrieval index. The Swagger UI resolver workaround for `file://` applies only to a single already loaded document with internal references; browsers can still block loading a local OpenAPI file.
- The UI is currently English. Browser support targets modern browsers with Unicode regex, `ResizeObserver`, `fetch`, and `AbortController`.

Use one extension per browser document. A second active instance throws a clear error. On route changes or component unmount, call `extension.destroy()` (or the result of `mount(...).destroy()`). It cancels extension requests, releases event listeners and observers, clears the in-memory key, removes controls, and permits a clean remount. It does not delete keys the user explicitly saved in URL or browser storage; use **Remove key** for that. Standalone cleanup also removes its Swagger UI content. A plugin host remains responsible for its own Swagger UI instance and requests.

For React, call `mount` in an effect after attaching a DOM ref, and return `() => mounted.destroy()` as the effect cleanup. Do not mount during rendering. On server-rendered pages, load CSS through your framework's global stylesheet entry.

## Multiple OpenAPI documents

Pass a list of named URLs to the standalone entry. Swagger UI shows a selector. Search indexes every document in the background, while the assistant uses the selected document:

```js
mount({
  element: document.getElementById('docs'),
  openapi: [
    { name: 'Catalog', url: '/catalog/openapi.yaml' },
    { name: 'Billing', url: '/billing/openapi.json' }
  ],
  primaryName: 'Catalog',
  ai: true
});
```

Names and URLs must be unique. Multi-document mode accepts reachable JSON or YAML URLs; the single-document form also accepts an already loaded OpenAPI object. Ordinary search covers **all configured APIs** and marks every result with its API name. Selecting a result from another API switches Swagger UI to that document and opens the operation or schema. Results appear as each API finishes indexing. The assistant uses **only the selected API**, avoiding unrelated fragments and ambiguity between identical names. A previous answer and any in-flight AI request are cleared when the document changes.

If one document cannot be indexed, search stays available for the others and shows how many APIs are indexed. Use **Retry** to load unavailable documents again. If the selected document cannot open, choose another from the Swagger UI selector or select a search result from an available API. The background catalog uses Swagger UI's fetch function and configured request and response interceptors; protected specification endpoints still need browser access and appropriate CORS settings.

Swagger UI fetches each selected URL, so its `requestInterceptor` and `withCredentials` options work for protected specification endpoints. Pass Swagger UI options through `swagger: { ... }` on `mount`; the package owns `url`, `urls`, `spec`, and the mount node. The standalone entry disables Swagger UI's remote validator by default (`validatorUrl: null`). You can opt in through `swagger.validatorUrl`.

For an existing Swagger UI configured with `urls`, include its Standalone preset and `StandaloneLayout`, and call `extension.attach(ui)` in `onComplete` for **every** loaded document. The plugin reads Swagger UI's `urls` list and shows the current specification name automatically. You can also pass `specifications: [{ name, url }, ...]` to `createSwaggerSearch` when another component manages the list. See the [multi-document plugin example](../examples/swagger-plugin-multiple.html). The [Swagger UI configuration reference](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/) describes `urls`, `urls.primaryName`, and `onComplete`.
