# Swagger Search AI

[![npm version](https://img.shields.io/npm/v/%40k0tarak%2Fswagger-search-ai)](https://www.npmjs.com/package/@k0tarak/swagger-search-ai)
[![Package checks](https://github.com/k0tarak/swagger-search-ai/actions/workflows/check.yml/badge.svg)](https://github.com/k0tarak/swagger-search-ai/actions/workflows/check.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/k0tarak/swagger-search-ai/blob/main/LICENSE)

**Find operations, schemas, and fields in Swagger UI. Ask questions about your API with an optional OpenRouter assistant.**

Add search to an existing Swagger UI page, or use the included standalone viewer. Everything runs in the browser, independently of your backend language. Ordinary search needs no API key or search server.

- **Search your documentation:** operation names, paths, descriptions, parameters, fields, and enum values, with typo tolerance and keyboard navigation.
- **Jump to the result:** open the matching operation or schema directly in Swagger UI.
- **Use your vocabulary:** configure synonyms, phrase aliases for AI retrieval, and word normalization.
- **Search multiple APIs:** index several OpenAPI documents and switch to the matching specification.
- **Ask about an API:** the optional assistant uses relevant documentation fragments and links its answers back to Swagger UI.

![Searching for cursor finds both the nextCursor field and the ListBooks operation in Swagger UI.](https://raw.githubusercontent.com/k0tarak/swagger-search-ai/main/docs/images/search.png)

*Search on the sample Library API. Use the arrow keys to select a result and Enter to open it.*

## Contents

- [Quick start: existing Swagger UI](#quick-start-existing-swagger-ui)
- [Standalone viewer](#standalone-viewer)
- [Install with npm](#install-with-npm)
- [Configuration and vocabulary](#configuration-and-vocabulary)
- [AI assistant](#ai-assistant)
- [Compatibility](#compatibility)
- [Examples and support](#examples-and-support)

## Quick start: existing Swagger UI

Add the package's CSS and script, create the controls outside Swagger UI's container, and register the extension when Swagger UI starts. This complete HTML example uses the CDN; no npm installation or build step is needed.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.33.0/swagger-ui.css">
  <link rel="stylesheet" href="https://unpkg.com/@k0tarak/swagger-search-ai@0.1.1/plugin.css">
</head>
<body>
  <div id="search-controls"></div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.33.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/@k0tarak/swagger-search-ai@0.1.1/plugin.js"></script>
  <script>
    const extension = SwaggerSearchAI.createSwaggerSearch({
      element: document.getElementById('search-controls'),
      title: 'My API',
      ai: true
    });
    const ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      validatorUrl: null,
      plugins: [extension.plugin],
      onComplete: () => extension.attach(ui)
    });
  </script>
</body>
</html>
```

Serve this page over HTTP(S) and change `/openapi.json` to your specification URL. Keep your existing Swagger UI options and plugins when adding the extension. Search works immediately after the specification loads. Set `ai: false` or omit `ai` to show search alone.

**Updates:** the example pins version `0.1.1`. To follow new releases automatically, replace `@0.1.1` with `@latest` in **both** package URLs. The next page load picks up the latest release after CDN caches refresh; it does not update an already open page. Keep JavaScript and CSS on the same version or tag. [UNPKG version and cache behavior](https://unpkg.com/#cache-performance).

FastAPI, Swashbuckle/.NET, springdoc, and other servers can use this integration wherever they allow customizing the Swagger HTML and initialization. Loading the script after Swagger UI has already initialized is not enough: register `extension.plugin` during initialization and call `extension.attach(ui)` after each specification loads.

## Standalone viewer

If you are creating a documentation page from scratch, the standalone script includes Swagger UI:

```html
<link rel="stylesheet" href="https://unpkg.com/@k0tarak/swagger-search-ai@0.1.1/standalone.css">
<div id="docs"></div>
<script src="https://unpkg.com/@k0tarak/swagger-search-ai@0.1.1/standalone.js"></script>
<script>
  SwaggerSearchAI.mount({
    element: document.getElementById('docs'),
    openapi: '/openapi.json',
    title: 'My API',
    ai: true
  });
</script>
```

For several APIs, pass `openapi: [{ name: 'Catalog', url: '/catalog/openapi.yaml' }, { name: 'Billing', url: '/billing/openapi.json' }]`. Ordinary search covers all configured APIs; the assistant uses the selected API. See [multiple-document configuration](https://github.com/k0tarak/swagger-search-ai/blob/main/docs/CONFIGURATION.md#multiple-openapi-documents).

## Install with npm

```sh
npm install @k0tarak/swagger-search-ai
```

For an application with a bundler:

```js
import { mount } from '@k0tarak/swagger-search-ai/standalone';
import '@k0tarak/swagger-search-ai/standalone.css';

const docs = mount({
  element: document.getElementById('docs'),
  openapi: '/openapi.json',
  ai: true
});

// On component unmount or when leaving the page:
// docs.destroy();
```

For an existing Swagger UI, import `createSwaggerSearch` from `@k0tarak/swagger-search-ai` and its styles from `@k0tarak/swagger-search-ai/plugin.css`, then use the initialization shown above. Both entries support ESM, CommonJS, and TypeScript. Imports are safe during server rendering; mount only after the element is connected to the browser document. In React, mount in an effect and call `destroy()` in its cleanup.

## Configuration and vocabulary

Defaults are provided for search, retrieval, and models. Override only what your API needs:

```js
const extension = SwaggerSearchAI.createSwaggerSearch({
  element: document.getElementById('search-controls'),
  search: {
    limit: 40,
    synonyms: ['book volume', 'purchase procurement']
  },
  ai: {
    contextBudget: 16000,
    aliases: [['purchase order|PO', 'PurchaseOrder|OrderRecord']]
  }
});
```

These options also work with `mount`. `search` configures ordinary search; `ai` configures the assistant and its retrieval. Keep API-specific dictionaries in your application. `ai.models` optionally replaces the entire default model chain.

| Option | Default |
| --- | --- |
| `search.limit` | 40 results |
| `search.fuzzy` | Typo recovery when literal search finds nothing |
| `ai` | Disabled; `true` enables the assistant with defaults |
| `ai.contextBudget` | 24,000 characters |
| `ai.timeoutMs` | 120 seconds, including model fallbacks |
| API key persistence | Memory only |

See the [configuration reference](https://github.com/k0tarak/swagger-search-ai/blob/main/docs/CONFIGURATION.md) for model IDs, custom models and provider preferences, synonyms, aliases, normalization, key persistence, error handling, and the programmatic search API.

## AI assistant

Enable `ai: true`, enter an OpenRouter key in **Connection**, and ask a question. The assistant sends relevant fragments from the selected specification to OpenRouter and is instructed to answer in the language of your question. Operation and schema references in the answer open the corresponding Swagger UI documentation.

![The AI assistant explains cursor pagination and links ListBooks, BookPage, and nextCursor to their Swagger UI definitions.](https://raw.githubusercontent.com/k0tarak/swagger-search-ai/main/docs/images/assistant.png)

*Actual interface on the sample Library API, with a simulated response for illustration. No live model request was used for this screenshot.*

- Opening the page and using ordinary search make no model requests. **Ask** and **Check connection** do.
- The default models request free endpoints with a zero-price ceiling. Availability and rate limits vary; eligible provider failures can try the next configured model. Account limits and non-retryable errors stop the request.
- Questions and selected API fragments are sent to OpenRouter and its provider. Check provider data policies before using private documentation. Custom models can incur charges. See [default models and provider considerations](https://github.com/k0tarak/swagger-search-ai/blob/main/docs/CONFIGURATION.md#default-models).
- Keys stay in memory by default. Hosts can offer optional persistence; see [key storage and its tradeoffs](https://github.com/k0tarak/swagger-search-ai/blob/main/docs/CONFIGURATION.md#api-key-persistence).
- Retrieval does not translate queries. Use technical names or configure vocabulary when questions and documentation use different languages. Verify generated answers against the linked contracts.

## Compatibility

- Tested integration: **Swagger UI 5.33.0**, Swagger 2.0 and OpenAPI 3.0/3.1 HTTP operations, JSON and YAML documents.
- Supports operations, schemas, fields, inline contracts, enums, and recursive internal references. External references are not fetched by the search index.
- Targets modern browsers. The UI is English; vocabulary can be configured for other languages.
- Serve specifications over HTTP(S) with appropriate CORS permissions. When AI is enabled, allow `https://openrouter.ai` in your CSP `connect-src`.
- Use one extension per document and call `destroy()` when unmounting. Other Swagger UI versions, customized layouts, webhooks, callbacks, and full OpenAPI 3.2 support need separate validation.

See [browser behavior and limits](https://github.com/k0tarak/swagger-search-ai/blob/main/docs/CONFIGURATION.md#browser-behavior-and-limits) for authentication, CSP, lifecycle, and integration details.

## Examples and support

- [Standalone example](https://github.com/k0tarak/swagger-search-ai/blob/main/examples/standalone.html) and [existing Swagger UI example](https://github.com/k0tarak/swagger-search-ai/blob/main/examples/swagger-plugin.html).
- [Multiple APIs](https://github.com/k0tarak/swagger-search-ai/blob/main/examples/multiple-specs.html) and [multi-document plugin](https://github.com/k0tarak/swagger-search-ai/blob/main/examples/swagger-plugin-multiple.html).
- [Development, local examples, and search evaluation](https://github.com/k0tarak/swagger-search-ai/blob/main/docs/DEVELOPMENT.md).
- [Report a bug or request a feature](https://github.com/k0tarak/swagger-search-ai/issues). Include a small, sanitized example; keep API keys and private specifications out of public issues.
- [Changelog](https://github.com/k0tarak/swagger-search-ai/blob/main/CHANGELOG.md) · [MIT license](https://github.com/k0tarak/swagger-search-ai/blob/main/LICENSE).
