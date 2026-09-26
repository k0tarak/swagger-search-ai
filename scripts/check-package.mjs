import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'swagger-search-package-'));
const npm = (args, cwd = root) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(temporary, 'cache') }
});
try {
    const [archive] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
    assert(archive.files.every(file => /^(dist|examples|fixtures)\//.test(file.path) ||
        ['README.md', 'LICENSE', 'package.json'].includes(file.path)), 'Unexpected file in npm archive');
    for (const asset of ['dist/index.d.mts', 'dist/standalone.d.cts', 'dist/swagger-ui-bundle.js.LICENSE.txt',
        'dist/swagger-ui-standalone-preset.js.LICENSE.txt']) assert(archive.files.some(file => file.path === asset), asset);
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
        join(temporary, archive.filename)], temporary);
    const test = `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        import * as esm from '@k0tarak/swagger-search-ai';
        import { mount } from '@k0tarak/swagger-search-ai/standalone';
        const require = createRequire(import.meta.url);
        const cjs = require('@k0tarak/swagger-search-ai');
        assert.equal(typeof mount, 'function');
        assert.equal(typeof require('@k0tarak/swagger-search-ai/standalone').mount, 'function');
        for (const api of [esm, cjs]) {
            const index = api.buildSearchIndex({ paths: { '/items': { get: { operationId: 'ListItems' } } } });
            assert.equal(api.search(index, 'list items').entries[0].name, 'ListItems');
            const answer = await api.completeOpenRouter('test-key', [], undefined,
                async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Answer' } }] })),
                undefined, [{ id: 'test/model' }]);
            assert.equal(answer.content, 'Answer');
            assert.equal(answer.truncated, true);
        }
        for (const path of ['plugin.css', 'standalone.css', 'plugin.js', 'standalone.js']) {
            assert(require.resolve('@k0tarak/swagger-search-ai/' + path));
        }
    `;
    await writeFile(join(temporary, 'smoke.mjs'), test);
    execFileSync(process.execPath, ['smoke.mjs'], { cwd: temporary, stdio: 'pipe' });
    const consumer = `
        import { buildSearchIndex, search, createSwaggerSearch, buildAssistantIndex, retrieve } from '@k0tarak/swagger-search-ai';
        import { completeOpenRouter, type OpenRouterResult, type OpenRouterError } from '@k0tarak/swagger-search-ai';
        import { mount } from '@k0tarak/swagger-search-ai/standalone';
        const spec = { openapi: '3.1.0', info: { title: 'Typed API', version: '1' }, paths: {} };
        const results = search(buildSearchIndex(spec, { synonyms: ['book volume'], fuzzy: false }), 'book');
        results.entries.forEach(entry => { if (entry.kind === 'operation') entry.method.toUpperCase(); });
        retrieve(buildAssistantIndex(spec, { aliases: [['volume', 'Book']] }), 'Book', 2000);
        const element = document.createElement('div');
        const extension = createSwaggerSearch({ element, search: { limit: 10 }, ai: { models: [{ id: 'test/model' }] } });
        extension.destroy();
        mount({ element, openapi: spec, swagger: { deepLinking: true } }).destroy();
        mount({ element, openapi: spec, ai: true }).destroy();
        createSwaggerSearch({ element, ai: {} }).destroy();
        createSwaggerSearch({ element, ai: { contextBudget: 1000 } }).destroy();
        createSwaggerSearch({ element, ai: false }).destroy();
        async function requestAnswer() {
            const result: OpenRouterResult = await completeOpenRouter('test-key', [], undefined, undefined, undefined, [{ id: 'test/model' }]);
            const truncated: boolean = result.truncated;
            return { text: result.content, truncated };
        }
        function retryDelay(error: OpenRouterError): number | undefined { return error.retryAfterMs; }
        // @ts-expect-error configuration errors must be caught for consumers
        createSwaggerSearch({ element, search: { fuzzy: 'yes' } });
        // @ts-expect-error model IDs are required
        createSwaggerSearch({ element, ai: { models: [{}] } });
    `;
    for (const extension of ['mts', 'cts']) await writeFile(join(temporary, `consumer.${extension}`), consumer);
    const compiler = resolve('node_modules/typescript/bin/tsc');
    for (const mode of ['nodenext', 'bundler']) {
        execFileSync(process.execPath, [compiler, '--noEmit', '--strict', '--target', 'es2022',
            '--module', mode === 'nodenext' ? 'nodenext' : 'esnext', '--moduleResolution', mode,
            'consumer.mts', ...(mode === 'nodenext' ? ['consumer.cts'] : [])], { cwd: temporary, stdio: 'pipe' });
    }
    await build({ absWorkingDir: temporary, entryPoints: ['consumer.mts'], bundle: true, platform: 'browser',
        write: false, logLevel: 'silent' });
    const manifest = JSON.parse(await readFile(join(temporary, 'node_modules/@k0tarak/swagger-search-ai/package.json')));
    assert.equal(Object.keys(manifest.dependencies || {}).length, 0);
    console.log(`Package verified: ${archive.files.length} files, ${(archive.size / 1024).toFixed(0)} KiB packed. Clean offline install, ESM, CommonJS, TypeScript and browser bundling passed.`);
} catch (error) {
    if (error.stdout?.length) console.error(error.stdout.toString());
    if (error.stderr?.length) console.error(error.stderr.toString());
    throw error;
} finally {
    await rm(temporary, { recursive: true, force: true });
}
