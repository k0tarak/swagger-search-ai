'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../dist/index.cjs');
const library = require('../fixtures/library.openapi.json');
const pets = require('../fixtures/pets.openapi.json');

const orders = {
    paths: {
        '/orders/{orderId}': { get: {
            operationId: 'GetPurchaseOrder', summary: 'Get a purchase order by its identifier',
            parameters: [{ name: 'orderId', in: 'path', description: 'Stable purchase order identifier' }]
        } },
        '/orders/{orderId}/cancel': { post: { operationId: 'CancelOrder', summary: 'Cancel a purchase order' } }
    },
    components: { schemas: {
        Order: { properties: { delivery: { properties: { address: { properties: {
            postalCode: { type: 'string', description: 'Delivery postal code' }
        } } } } } },
        PaymentStatus: { type: 'string', description: 'Payment lifecycle state', enum: ['queued', 'settled'] }
    } }
};
const noisy = structuredClone(orders);
for (let i = 0; i < 80; i++) noisy.paths[`/records/${i}`] = { get: {
    operationId: `GetRecord${i}`, summary: 'Get a record', description: 'General record details and metadata.'
} };

test('ordinary search quality corpus ranks natural queries, fields, enum values, and typo recovery', () => {
    const catalogs = {
        library: api.buildSearchIndex(library), pets: api.buildSearchIndex(pets), orders: api.buildSearchIndex(noisy)
    };
    const cases = [
        ['library', 'ListBooks', 'operation', 'ListBooks', 1],
        ['library', 'list books', 'operation', 'ListBooks', 1],
        ['library', 'How can I list books?', 'operation', 'ListBooks', 1],
        ['library', 'Could you please list books for me?', 'operation', 'ListBooks', 1],
        ['library', 'Does the API list books?', 'operation', 'ListBooks', 1],
        ['library', 'create book', 'operation', 'CreateBook', 1],
        ['library', 'next cursor', 'field', 'nextCursor', 3],
        ['library', 'WebSocket event', 'model', 'RealtimeEvent', 3],
        ['library', 'event payload sequence', 'field', 'sequence', 3],
        ['library', 'book title', 'field', 'title', 3],
        ['pets', 'list pets', 'operation', 'ListPets', 1],
        ['pets', 'lisst pets', 'operation', 'ListPets', 3],
        ['pets', 'pet name', 'field', 'name', 3],
        ['pets', 'GET /pets', 'operation', 'ListPets', 1],
        ['orders', 'purchase order by identifier', 'operation', 'GetPurchaseOrder', 3],
        ['orders', 'orderId', 'operation', 'GetPurchaseOrder', 1],
        ['orders', 'postal code', 'field', 'delivery.address.postalCode', 3],
        ['orders', 'settled', 'model', 'PaymentStatus', 3],
        ['orders', 'cancel order', 'operation', 'CancelOrder', 1]
    ];
    const misses = [];
    let reciprocalRank = 0;
    for (const [catalog, query, kind, name, top] of cases) {
        const results = api.search(catalogs[catalog], query).entries;
        const rank = results.findIndex(entry => entry.kind === kind && entry.name === name);
        if (rank < 0 || rank >= top) misses.push({ query, expected: `${kind}:${name}`, rank, top });
        reciprocalRank += rank < 0 ? 0 : 1 / (rank + 1);
    }
    assert.deepEqual(misses, []);
    assert.equal(api.search(catalogs.orders, 'banana protocol').total, 0);
    assert.deepEqual(api.search(catalogs.orders, 'GetPurchaseOrder'),
        api.search(catalogs.orders, 'GetPurchaseOrder'));
    console.log(`Ordinary search: ${cases.length - misses.length}/${cases.length} within target rank; MRR ${(reciprocalRank / cases.length).toFixed(3)}.`);
});

test('assistant retrieval quality corpus keeps relevant contracts and ignores unrelated records', () => {
    const combined = { paths: { ...library.paths, ...noisy.paths },
        components: { schemas: { ...library.components.schemas, ...noisy.components.schemas } } };
    const data = api.buildAssistantIndex(combined);
    const cases = [
        ['How do I list books with the next cursor?', 'ListBooks', 'nextCursor'],
        ['What is RealtimeEvent.kind?', 'RealtimeEvent', 'connected'],
        ['How do I cancel an order?', 'CancelOrder', 'Cancel a purchase order'],
        ['What is a settled payment?', 'PaymentStatus', 'settled'],
        ['How do I find a purchase order by its ID?', 'GetPurchaseOrder', 'orderId']
    ];
    const misses = [];
    for (const [question, name, contextText] of cases) {
        const result = api.retrieve(data, question);
        if (!result.sources.slice(0, 3).some(source => source.name === name) ||
            !result.context.includes(contextText) || result.context.length > 24000) misses.push(question);
    }
    assert.deepEqual(misses, []);
    assert.deepEqual(api.retrieve(data, 'banana protocol').sources, []);
    assert.deepEqual(data.warnings, []);
    console.log(`Assistant retrieval: ${cases.length - misses.length}/${cases.length} within top 3 with expected context.`);
});

test('vocabulary is explicit, validated, and does not silently widen the package defaults', () => {
    const defaultIndex = api.buildAssistantIndex(library);
    assert.equal(api.retrieve(defaultIndex, 'shelf').sources.length, 0);
    const aliased = api.buildAssistantIndex(library, { aliases: [['shelf|bookshelf', 'Book']] });
    assert.match(api.retrieve(aliased, 'shelf').context, /Schema: Book/);
    assert.match(api.retrieve(aliased, 'bookshelf').context, /Schema: Book/);
    const synonym = api.buildAssistantIndex(library, { synonyms: ['volume book'] });
    assert.match(api.retrieve(synonym, 'volume').context, /Schema: Book/);
    const normalized = api.buildAssistantIndex(library, {
        normalizeTerm: word => word === 'ledger' ? 'book' : word,
        stopWords: ['please'], actionTerms: ['locate'], technicalTermKey: word => word
    });
    assert.match(api.retrieve(normalized, 'please locate ledger').context, /Schema: Book/);
    for (const configuration of [
        { synonyms: 'book volume' }, { synonyms: ['---'] },
        { aliases: [['', 'Book']] }, { aliases: [['shelf|', 'Book']] },
        { aliases: [['shelf', 'Book', '|']] }, { normalizeTerm: 'lowercase' },
        { stopWords: 'please' }, { actionTerms: null }, { technicalTermKey: 'identity' },
        { normalizeTerm: () => '' }, { minScoreRatio: -0.1 }, { minScoreRatio: 1.1 },
        { minScoreRatio: NaN }, { minScoreRatio: '0.2' }
    ]) assert.throws(() => api.buildAssistantIndex(library, configuration), TypeError);
});

test('a lower relative score threshold can retain supporting candidates without changing other indexes', () => {
    const strict = api.buildAssistantIndex(library);
    const broad = api.buildAssistantIndex(library, { minScoreRatio: 0.2 });
    assert.deepEqual(api.retrieve(strict, 'list books').sources.map(source => source.name), ['ListBooks']);
    const result = api.retrieve(broad, 'list books');
    assert.equal(result.sources[0].name, 'ListBooks');
    assert(result.sources.some(source => source.name === 'Book'));
    assert(result.context.length <= 24000);
    assert.deepEqual(api.retrieve(strict, 'list books').sources.map(source => source.name), ['ListBooks']);
});
