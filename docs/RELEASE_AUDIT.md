# Pre-publication audit — 2026-09-26

The package is now a release candidate for the documented scope. This audit does not establish universal Swagger compatibility or guarantee product adoption. No npm publication was performed.

## Changes made

| Area | Finding | Resolution |
| --- | --- | --- |
| Ordinary search | Inline requests/responses and linked contracts were invisible when searching for their fields | Index contract terms under the owning operation; include enum values, response headers, reusable request bodies and Swagger 2.0 body/form parameters |
| Configuration | Only AI retrieval exposed vocabulary configuration | Add independent `search` options for synonyms, stop words, normalization, result limit and typo recovery |
| Configuration defaults | Enabling the assistant required a model list, and examples contained placeholder IDs | Support `ai: true` / `ai: {}` and partial overrides; use six free models with explicit reasoning settings and a zero-price provider ceiling; preserve explicit opt-out and full replacement by custom models |
| Real-project integration | A stricter candidate threshold excluded one result retained by the original implementation | Expose `ai.minScoreRatio` (default 0.45); the local host uses its original 0.2 threshold without changing package defaults |
| Search quality | Natural filler words and a faulty one-edit matcher caused avoidable misses/false positives | Handle common question words, correct trailing edit counting, preserve exact-name priority and direct-field ranking |
| AI retrieval | Missing `operationId` and punctuation in names could throw during normalization | Tokenize names before matching; add dedicated tests |
| AI retrieval | `remove a pet` missed the delete operation in Petstore | Share generic action synonyms between ordinary and AI retrieval; keep domain vocabulary configurable |
| OpenAPI handling | Boolean schemas could leave empty fragments; local reference handling differed between indexes | Share internal pointer resolution and parameter merging; support boolean fragments, tuple constraints, escaped pointers and bounded cycle handling |
| Context accuracy | Overridden path parameters and inherited security were not preserved correctly | Apply operation parameter overrides and include inherited/anonymous security requirements and scheme definitions |
| Catalog loading | Repeated attach calls could duplicate queued downloads; stalled downloads had no deadline | Reserve queued work, cap concurrency at four, forward credentials/interceptors/signals, add timeout and Retry recovery |
| Initial API failure | Other APIs were not indexed when the first selected document was invalid | Continue catalog loading and allow searching available documents |
| Lifecycle | No teardown, global listeners/observers survived removal, duplicate instances silently conflicted | Add idempotent `destroy()`, abort pending work, remove observers/listeners/popovers, support clean remount, reject duplicate active instances clearly |
| AI request lifecycle | Custom fetchers could ignore cancellation; key changes allowed stale connection status | Race requests against cancellation, configure deadlines/context size, invalidate requests when keys change, reject malformed keys before network access |
| Answer language | The system prompt forced English and appended an English truncation notice to answers | Follow the question language, preserve technical identifiers and place truncation notices in the separate status area |
| OpenRouter errors | HTTP 200 error envelopes lost detail, 403 could trigger fallback, and Retry-After was ignored | Normalize HTTP and provider errors, explain account/context/output limits, honor readable retry delays, preserve refusals, redact keys and avoid displaying raw metadata |
| Mobile layout | Search overlapped the brand and response tables caused page-wide horizontal scrolling | Stack mobile header elements and contain standalone response-table overflow |
| npm consumption | No TypeScript declarations or automated clean-package installation check | Add typed ESM/CommonJS exports, browser bundling/type checks against an installed archive and an automatic prepublication gate |
| Supply chain | Manually vendored libraries were absent from dependency audit; upstream bundled notices were omitted | Pin marked/MiniSearch in the lockfile, bundle from installed copies, ship both Swagger UI notices, clean generated dist before builds |
| Documentation | Quick start enabled AI with a placeholder model and underspecified compatibility/lifecycle | Show working default configuration and local-search opt-out; document configuration, cleanup, request costs and supported scope |

## Verification

- `npm run check`: 70 tests plus an actual packed-archive install in a clean temporary project; ESM, CommonJS, TypeScript NodeNext/bundler resolution, browser bundle generation, asset exports and file allowlist. The installed entries support optional models, boolean AI configuration, and the OpenRouter result/error contract.
- Node 26.0.0 on macOS for the full local gate. The initial 46-test audit baseline also passed on Node 20.20.2; the follow-up tests ran on Node 26. CI is configured for Node 20/22/24 and Windows Node 24; remote GitHub CI has not been dispatched during this audit.
- Existing labelled corpus: 19/19 ordinary queries within target rank, MRR 1.000; 5/5 assistant queries within top three with expected context. The separate example evaluation has six labelled cases.
- Public [Swagger Petstore](https://petstore3.swagger.io/api/v3/openapi.json): 19 operations, six schemas; both indexes rank 25/25 exact identifiers first. Ordinary search ranks 19/19 spaced identifiers and 15/15 transposed-word queries first. These generated cases are smoke checks, not independent natural-language evaluation.
- Real in-app browser on macOS: standalone and plugin mounting, keyboard search, opening operations and schema fields with focus, returning to search, switching from Library to Pets through a search result, and a narrow mobile viewport. No console errors were observed in the plugin check. Firefox, other browser engines, screen readers and framework-specific deployments were not exercised.
- OpenRouter responses, errors, fallback, redaction, cancellation and timeouts use controlled fetch responses. The follow-up includes HTTP 200 error envelopes, normalized errors, HTML error pages, Retry-After seconds/dates, reserved budgets, refusals, malformed JSON, reasoning-only output limits, and UI recovery. A Russian-question DOM test verifies the outgoing language instruction and preservation of a Russian mock answer. No paid live-model requests were made, multilingual API-answer quality remains unverified beyond the documented connection smoke test.
- Default models: Laguna S 2.1 → Nemotron 3 Ultra → North Mini Code → Qwen3.8 27B → Gemma 4 31B → Gemma 4 26B A4B. All were in the free catalog on 2026-09-26. In a six-request browser connection smoke test, the first three answered; the other three returned upstream shared-pool 429 errors. These remain fallbacks because availability varies. This does not evaluate API-answer quality. Tests cover ordered fallback, zero-price routing, configuration overrides, provider-vs-platform rate limits (including HTTP 200 error envelopes), Retry-After, and unknown-scope handling.
- `npm audit`: zero reported vulnerabilities after adding the previously vendored libraries to the lockfile. This reflects the registry advisory result, not proof of security or an inventory of every transitive library hidden inside Swagger UI's upstream prebuilt bundle.
- Archive size is approximately 1.82 MiB. Browser plugin JS is approximately 162 KiB raw / 54 KiB gzip; standalone JS approximately 1.81 MiB raw / 552 KiB gzip. The tarball contains multiple module/browser builds; a browser downloads only its chosen assets.

## Performance and reproduction

```sh
npm ci
npm run check
npm run evaluate -- --cases examples/evaluation-cases.json
npm run benchmark -- 2000
npm run evaluate -- --spec /path/to/openapi.json --cases /path/to/held-out-queries.json
npm audit
npm pack
```

The final checked-in synthetic workload with 2,000 operations and a shared 30-field schema built the ordinary index in 99 ms and the AI index in 91 ms on this machine. Query p95 was 2.5 ms and 8 ms respectively. These are Node timings, sensitive to query choice, warm-up and machine state. The checked-in benchmark makes the workload reproducible; it does not impose fragile timing assertions in CI. Indexing remains synchronous, so substantially larger or deeper real specifications should be profiled in target browsers before introducing workers.

## Agreed direction and remaining release checks

1. **Target integrations and compatibility.** The owner chose backend-independent HTML/script integration. Both standalone mounting and plugin initialization are documented; no server-framework adapter is required. Adding a script after Swagger UI has already initialized does not register the plugin. Swagger UI 5.33.0 is the exercised integration; host pages with other pinned versions or custom layouts still need testing. The upstream [compatibility table](https://github.com/swagger-api/swagger-ui#compatibility) describes Swagger UI itself, not this extension.
2. **Representative search quality.** The owner will test real specifications and questions later. Current tests are regression coverage; the Petstore `remove` case was used to improve the implementation, so it is not held-out validation. For that later evaluation, use a separate corpus with expected empty results and choose acceptance criteria before tuning.
3. **Languages.** The owner requested answers in the question's language; the prompt now specifies this, including preserving code and identifiers. UI/status messages remain English. Unicode terms and custom normalization work, but automatic query translation, cross-language semantic matching and language-specific morphology are not provided by default. Verify language quality with the selected model and use aliases where retrieval needs vocabulary across languages.
4. **AI deployment model.** The owner chose OpenRouter only for now, retaining the user's key in the browser. URL/localStorage persistence remains opt-in. Error handling follows [OpenRouter's documented HTTP and provider error shapes](https://openrouter.ai/docs/api_reference/errors-and-debugging). Validate the selected model on real questions and document its operating cost before promoting answer quality.
5. **Feature boundary.** External references are not fetched by either index. Webhooks, callbacks, arbitrary JSON Schema dialects, all OpenAPI 3.2 features, simultaneous widgets in one document and shadow-root mounting are not guaranteed. Decide which of these is required for the first audience. The official [OpenAPI 3.1 Schema Object](https://spec.openapis.org/oas/v3.1.0.html#schema-object) is broader than the retrieval representation implemented here.
6. **Release ownership.** Confirm the package name/scope and npm account, verify that the public repository and issue URL are available, choose a private security-reporting contact and run the CI gate on the release commit. The repository had no commits at audit start. The owner subsequently authorized the initial commit and public 0.1.0 release, and confirmed npm account setup and 2FA. Release execution and registry/CDN verification are recorded separately.

A successful launch needs a clear supported scope, low-friction examples, documented limits and feedback from real API users. Additional features should follow the selected audience and observed misses rather than a promise to work in every possible case.
