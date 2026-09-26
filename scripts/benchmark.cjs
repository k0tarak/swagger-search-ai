'use strict';
const { performance } = require('node:perf_hooks');
const api = require('../dist/index.cjs');
const count = Number(process.argv[2] || 2000);
if (!Number.isInteger(count) || count < 1 || count > 20000) throw new TypeError('Operation count must be 1-20000');
const paths = {};
for (let i = 0; i < count; i++) paths[`/resources/${i}`] = { get: {
    operationId: `GetResource${i}`, summary: `Get resource ${i}`,
    responses: { 200: { description: 'Resource details', content: {
        'application/json': { schema: { $ref: '#/components/schemas/Resource' } }
    } } }
} };
const spec = { paths, components: { schemas: { Resource: { properties: Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`field${i}`, { type: 'string', description: `Resource attribute ${i}` }]))
} } } };
function measure(build, query) {
    const start = performance.now();
    const index = build(spec), buildMs = performance.now() - start, times = [];
    for (let i = 0; i < 50; i++) {
        const id = Math.floor(i * count / 50), begin = performance.now();
        query(index, `GetResource${id}`);
        times.push(performance.now() - begin);
    }
    times.sort((a, b) => a - b);
    return { buildMs: Math.round(buildMs), p50Ms: +times[24].toFixed(1), p95Ms: +times[47].toFixed(1), maxMs: +times[49].toFixed(1) };
}
console.log(JSON.stringify({ operations: count, node: process.version,
    search: measure(api.buildSearchIndex, api.search), assistant: measure(api.buildAssistantIndex, api.retrieve),
    note: 'Synthetic shared-schema workload on this machine; not a browser or real-user latency guarantee.'
}, null, 2));
