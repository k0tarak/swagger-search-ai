'use strict';
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const api = require('../dist/index.cjs');

const args = process.argv.slice(2);
function argument(name, fallback) {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1]) throw new Error(`${name} needs a file path`);
    return args[index + 1];
}
const specFile = argument('--spec', 'fixtures/library.openapi.json');
const casesFile = argument('--cases');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const sample = (items, count) => Array.from({ length: Math.min(items.length, count) }, (_, i) =>
    items[Math.floor(i * items.length / Math.min(items.length, count))]);
const percentile = (values, fraction) => values.length
    ? Number([...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1].toFixed(1)) : 0;
const first = performance.now();
const ordinary = api.buildSearchIndex(spec);
const ordinaryBuildMs = performance.now() - first;
const second = performance.now();
const assistant = api.buildAssistantIndex(spec);
const assistantBuildMs = performance.now() - second;
const exact = sample(ordinary.filter(entry => entry.kind === 'operation' && entry.operationId), 50)
    .concat(sample(ordinary.filter(entry => entry.kind === 'model'), 50));
const namedOperations = exact.filter(entry => entry.kind === 'operation');
const splitName = name => name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2');
function generatedScore(transform) {
    const cases = namedOperations.map(entry => ({ entry, query: transform(entry.name) }))
        .filter(item => item.query && item.query !== item.entry.name);
    return score(cases, item => api.search(ordinary, item.query).entries,
        (found, item) => found.kind === item.entry.kind && found.name === item.entry.name);
}
function score(items, run, expected) {
    const latency = [], ranks = [];
    for (const item of items) {
        const begin = performance.now();
        const results = run(item);
        latency.push(performance.now() - begin);
        ranks.push(results.findIndex(entry => expected(entry, item)));
    }
    return { cases: items.length, top1: ranks.filter(rank => rank === 0).length,
        top3: ranks.filter(rank => rank >= 0 && rank < 3).length,
        mrr: Number((ranks.reduce((sum, rank) => sum + (rank < 0 ? 0 : 1 / (rank + 1)), 0) /
            Math.max(1, ranks.length)).toFixed(3)),
        p50Ms: percentile(latency, 0.5), p95Ms: percentile(latency, 0.95),
        maxMs: percentile(latency, 1) };
}
const report = {
    spec: { operations: ordinary.filter(entry => entry.kind === 'operation').length,
        schemas: ordinary.filter(entry => entry.kind === 'model').length,
        searchEntries: ordinary.length, assistantFragments: assistant.fragments.size,
        indexWarnings: assistant.warnings.length },
    buildMs: { search: Math.round(ordinaryBuildMs), assistant: Math.round(assistantBuildMs) },
    exactNames: {
        search: score(exact, item => api.search(ordinary, item.name).entries,
            (entry, item) => entry.kind === item.kind && entry.name === item.name),
        assistant: score(exact, item => api.retrieve(assistant, item.name).sources,
            (entry, item) => entry.kind === item.kind && entry.name === item.name)
    },
    generatedQueries: {
        spacedOperationNames: generatedScore(splitName),
        oneTransposition: generatedScore(name => {
            const parts = splitName(name).split(' ');
            const index = parts.findIndex(part => part.length >= 5 && part[2] !== part[3]);
            if (index < 0) return name;
            const part = parts[index];
            parts[index] = part.slice(0, 2) + part[3] + part[2] + part.slice(4);
            return parts.join(' ');
        })
    }
};
if (casesFile) {
    const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    if (!Array.isArray(cases) || cases.some(item => !item || typeof item.query !== 'string' ||
        typeof item.name !== 'string' || !['operation', 'model', 'field'].includes(item.kind) ||
        (item.mode && !['search', 'assistant'].includes(item.mode)) ||
        (item.mode === 'assistant' && item.kind === 'field') ||
        (item.top !== undefined && (!Number.isInteger(item.top) || item.top < 1)) ||
        (item.contextIncludes !== undefined && (!Array.isArray(item.contextIncludes) ||
            item.contextIncludes.some(fragment => typeof fragment !== 'string'))))) {
        throw new TypeError('Cases must be an array of { query, kind, name, mode?, top?, contextIncludes? }');
    }
    const misses = [];
    for (const item of cases) {
        const result = item.mode === 'assistant' ? api.retrieve(assistant, item.query) : api.search(ordinary, item.query);
        const rank = (item.mode === 'assistant' ? result.sources : result.entries)
            .findIndex(entry => entry.kind === item.kind && entry.name === item.name);
        const contextOk = item.mode !== 'assistant' || (item.contextIncludes || [])
            .every(fragment => result.context.includes(fragment));
        if (rank < 0 || rank >= (item.top || 3) || !contextOk) misses.push({ query: item.query,
            expected: `${item.kind}:${item.name}`, rank, contextOk });
    }
    report.labelledCases = { passed: cases.length - misses.length, total: cases.length, misses };
    if (misses.length) process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
