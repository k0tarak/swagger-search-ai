import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const common = { bundle: true, minify: true, sourcemap: false, legalComments: 'external', charset: 'ascii' };
for (const [entry, outfile, format, platform, globalName] of [
    ['src/index.js', 'dist/index.cjs', 'cjs', 'node'],
    ['src/index.mjs', 'dist/index.mjs', 'esm', 'browser'],
    ['src/index.js', 'dist/plugin.js', 'iife', 'browser', 'SwaggerSearchAI'],
    ['src/standalone.js', 'dist/standalone.cjs', 'cjs', 'node'],
    ['src/standalone.mjs', 'dist/standalone.mjs', 'esm', 'browser'],
    ['src/standalone.js', 'dist/standalone.js', 'iife', 'browser', 'SwaggerSearchAI']
]) {
    await build({ ...common, entryPoints: [entry], outfile, format, platform, globalName,
        ...(format === 'iife' ? { footer: { js: 'globalThis.SwaggerSearchAI = SwaggerSearchAI;' } } : {}) });
    if (outfile.endsWith('.js') || outfile.endsWith('.mjs') || outfile.endsWith('.cjs')) {
        // Preserve upstream internationalized domain strings without raw non-ASCII source text.
        const output = await readFile(outfile, 'utf8');
        await writeFile(outfile, output.replace(/[\u0400-\u04ff]/g,
            character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
    }
}
for (const entry of ['plugin', 'standalone']) {
    await build({ ...common, entryPoints: [`src/${entry}.css`], outfile: `dist/${entry}.css`,
        loader: { '.woff2': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl' } });
}
const notice = [
    '# Third-party notices',
    'The browser bundles include MiniSearch, marked, js-yaml, and (in standalone builds) Swagger UI.',
    'Their license texts follow.',
    ...await Promise.all([
        ['MiniSearch 7.2.0', 'node_modules/minisearch/LICENSE.txt'],
        ['marked 15.0.12', 'node_modules/marked/LICENSE.md'],
        ['js-yaml 4.3.2', 'node_modules/js-yaml/LICENSE'],
        ['Swagger UI 5.33.0', 'node_modules/swagger-ui-dist/LICENSE']
    ].map(async ([name, file]) => `## ${name}\n\n${await readFile(file, 'utf8')}`))
].join('\n\n');
await writeFile(join('dist', 'THIRD_PARTY_LICENSES.md'), notice);
// Upstream bundles reference these additional copyright and license notices.
for (const name of ['swagger-ui-bundle.js.LICENSE.txt', 'swagger-ui-standalone-preset.js.LICENSE.txt']) {
    await copyFile(join('node_modules/swagger-ui-dist', name), join('dist', name));
}
for (const entry of ['index', 'standalone']) {
    const declarations = await readFile(`src/${entry}.d.ts`, 'utf8');
    for (const [extension, target] of [['d.cts', 'cjs'], ['d.mts', 'mjs']]) {
        await writeFile(`dist/${entry}.${extension}`, declarations.replace("from './index'", `from './index.${target}'`));
    }
}
