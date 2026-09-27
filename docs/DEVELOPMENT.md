# Development

[Back to the README](../README.md)

## Run the examples

```sh
git clone https://github.com/k0tarak/swagger-search-ai.git
cd swagger-search-ai
npm ci
npm run build
python3 -m http.server 8000
```

Open [standalone](../examples/standalone.html), [multiple specifications](../examples/multiple-specs.html), [Swagger UI plugin](../examples/swagger-plugin.html), or [multi-document plugin](../examples/swagger-plugin-multiple.html) through `http://localhost:8000/examples/`. The examples use synthetic [Library](../fixtures/library.openapi.json) and [Pets](../fixtures/pets.openapi.json) APIs. The single-document examples enable the assistant with default models; enter your OpenRouter key to ask a question. Search works without a key.

## Package checks

```sh
npm ci
npm test
npm run check
npm pack --dry-run
npm pack
```

`npm test` builds and runs core, UI, OpenRouter, and real Swagger UI resolver checks. `npm run check` additionally packs and installs the actual `.tgz` into a clean temporary project offline, checks ESM/CommonJS imports, TypeScript under NodeNext and bundler resolution, browser bundling, exports, and the file allowlist. `prepublishOnly` runs this gate automatically. CI runs the same gate on Node 20, 22, and 24, plus Windows on Node 24. The `files` allowlist limits the archive to `dist`, `examples`, and synthetic `fixtures`. Bundled notices are in `dist/THIRD_PARTY_LICENSES.md` and the two upstream Swagger UI `.LICENSE.txt` files. MiniSearch and marked are pinned build dependencies, making them visible to `npm audit`; no runtime dependencies are installed for consumers.

## Evaluate search quality

The test suite includes labelled queries for natural wording, exact identifiers, nested fields, enum values, a typo, unrelated results, the assistant's context, and configured vocabulary. These cases protect known behavior; passing them is not a guarantee for a new API or an unseen user query.

Run the aggregate audit on any local OpenAPI JSON file:

```sh
npm run evaluate -- --spec path/to/openapi.json
```

It reports index size, build time, top-1/top-3 and mean reciprocal rank for a deterministic sample of operation and schema names, generated queries with spaced operation names or one transposed character, and query latency percentiles. Generated queries measure identifier handling and typo recovery; they are not representative user questions. To evaluate natural questions, prepare a separate JSON file following [the example](../examples/evaluation-cases.json), then run:

```sh
npm run evaluate -- --spec path/to/openapi.json --cases path/to/your-cases.json
```

Each labelled case has `query`, `kind`, `name`, and optional `top` (default 3). Set `mode: "assistant"` and optional `contextIncludes` to check retrieval context; the default mode checks ordinary search. The command fails if a labelled case misses its target. Keep any private specifications, vocabulary, and user queries outside the public repository. Before a release, evaluate a held-out set of representative questions, inspect false positives and empty results, and check cross-API navigation in a browser. Exact-name scores alone do not establish natural-language quality.
