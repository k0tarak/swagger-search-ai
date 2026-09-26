'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../dist/index.cjs');
const library = require('../fixtures/library.openapi.json');

const spec = {
    openapi: '3.1.0', info: { title: 'Contract variants', version: '1' },
    security: [{ bearer: [] }],
    paths: {
        '/payments': { parameters: [{ name: 'mode', in: 'query', description: 'obsoleteword' }], post: {
            operationId: 'SubmitPayment', parameters: [{ name: 'mode', in: 'query', description: 'replacementword' }],
            requestBody: { $ref: '#/components/requestBodies/Payment' },
            responses: { 200: { description: 'Success', content: { 'application/json': { schema: {
                properties: { receiptCode: { type: 'string', description: 'A receipt reference' } }
            } } } } }
        } },
        '/health': { get: { operationId: 'Health', security: [], responses: { 200: { description: 'OK' } } } },
        '/alias': { $ref: '#/paths/~1health' }
    },
    components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Access token' } },
        requestBodies: { Payment: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } } },
        schemas: {
            Payment: { type: 'object', properties: {
                merchantCode: { type: 'string', description: 'Merchant reference' },
                status: { enum: ['awaitingAuthorization', 'captured'] },
                note: { $ref: '#/components/schemas/Note' }
            } },
            Note: { type: 'string', description: 'Customer instructions' },
            AnyValue: true, ForbiddenValue: false,
            Extended: { allOf: [{ $ref: '#/components/schemas/Payment' }, { properties: { extra: true } }] },
            Tuple: { type: 'array', prefixItems: [{ const: 'pair' }, { type: 'integer', minimum: 1 }], items: false },
            'A/B~C': { properties: { escapedField: { description: 'Correct pointer target' } } },
            Escaped: { $ref: '#/components/schemas/A~1B~0C' }
        }
    }
};

test('ordinary search connects inline responses, request bodies, enums and shared schemas to operations', () => {
    const index = api.buildSearchIndex(spec);
    for (const query of ['receipt code', 'merchant reference', 'awaitingAuthorization', 'customer instructions']) {
        assert(api.search(index, query).entries.some(entry => entry.operationId === 'SubmitPayment'), query);
    }
    assert.equal(api.search(index, 'obsoleteword').total, 0);
    assert(api.search(index, 'replacementword').entries.some(entry => entry.operationId === 'SubmitPayment'));
    assert(index.some(entry => entry.path === '/alias' && entry.operationId === 'Health'));
    assert(index.some(entry => entry.model === 'Extended' && entry.name === 'merchantCode'));
    assert(index.some(entry => entry.model === 'Escaped' && entry.name === 'escapedField'));
});

test('OpenAPI 3.1 boolean schemas, tuples and constraints remain searchable and retrievable', () => {
    const ordinary = api.buildSearchIndex(spec), data = api.buildAssistantIndex(spec);
    assert.equal(api.search(ordinary, 'ForbiddenValue').entries[0].name, 'ForbiddenValue');
    assert.match(api.retrieve(data, 'AnyValue').context, /Any value is allowed/);
    assert.match(api.retrieve(data, 'ForbiddenValue').context, /No value is allowed/);
    const tuple = api.retrieve(data, 'Tuple').context;
    assert.match(tuple, /const: "pair"/);
    assert.match(tuple, /minimum: 1/);
    assert.match(tuple, /No value is allowed/);
});

test('assistant preserves inherited authentication and explicit anonymous operations', () => {
    const data = api.buildAssistantIndex(spec);
    const payment = api.retrieve(data, 'SubmitPayment').context;
    assert.match(payment, /Security scheme bearer/);
    assert.match(payment, /"scheme":"bearer"/);
    assert(!payment.includes('obsoleteword'));
    const health = api.retrieve(data, 'Health').context;
    assert.match(health, /Security requirements \(alternatives\): \[\]/);
    assert(!health.includes('Security scheme bearer'));
});

test('Swagger 2.0 body, form and response contracts are indexed', () => {
    const legacy = { swagger: '2.0', info: { title: 'Legacy', version: '1' }, paths: { '/upload': { post: {
        operationId: 'UploadDocument', parameters: [{ name: 'metadata', in: 'body', schema: { $ref: '#/definitions/Metadata' } },
            { name: 'attachment', in: 'formData', type: 'file' }],
        responses: { 200: { description: 'Uploaded', schema: { properties: { uploadTicket: { type: 'string' } } } } }
    } } }, definitions: { Metadata: { properties: { ownerName: { type: 'string' } } } } };
    for (const query of ['owner name', 'upload ticket', 'attachment']) {
        assert(api.search(api.buildSearchIndex(legacy), query).entries.some(entry => entry.kind === 'operation'), query);
    }
    assert.match(api.retrieve(api.buildAssistantIndex(legacy), 'UploadDocument').context, /ownerName/);
});

test('assistant supports operations without operationId and schema names containing punctuation', () => {
    const input = { paths: { '/accounts/{id}': { get: { summary: 'Read an account', responses: { 200: { description: 'OK' } } } } },
        components: { schemas: { 'Namespace.Account': { description: 'An account record' } } } };
    const data = api.buildAssistantIndex(input);
    assert(api.retrieve(data, 'GET /accounts/{id}').sources.some(source => source.name === 'GET /accounts/{id}'));
    assert(api.retrieve(data, 'Namespace.Account').sources.some(source => source.name === 'Namespace.Account'));
});

test('assistant understands generic action synonyms without a domain dictionary', () => {
    const input = { paths: { '/pets': {
        get: { operationId: 'ListPets', summary: 'Read pets' },
        post: { operationId: 'CreatePet', summary: 'Create a pet' },
        delete: { operationId: 'DeletePet', summary: 'Delete a pet' }
    } } };
    const data = api.buildAssistantIndex(input);
    assert.equal(api.retrieve(data, 'remove a pet').sources[0].name, 'DeletePet');
    assert.equal(api.retrieve(data, 'add a pet').sources[0].name, 'CreatePet');
});

test('cyclic objects and recursive references terminate without duplicating unbounded paths', () => {
    const recursive = { properties: { value: { type: 'string' } } };
    recursive.properties.child = recursive;
    const input = { components: { schemas: { Recursive: recursive } } };
    assert(api.buildSearchIndex(input).length < 10);
    const data = api.buildAssistantIndex(input);
    assert(data.fragments.size < 10);
    assert.match(api.retrieve(data, 'Recursive').context, /value/);
});

test('ordinary search vocabulary is configurable, Unicode aware and isolated between indexes', () => {
    const options = { synonyms: ['volume book'], stopWords: ['please'], limit: 1, fuzzy: false,
        normalizeTerm: word => word === 'ledger' ? 'book' : word.replace(/s$/, '') };
    const configured = api.buildSearchIndex(library, options);
    assert.equal(api.search(configured, 'please volume').entries[0].name, 'Book');
    assert.equal(api.search(configured, 'ledger').entries.length, 1);
    assert.equal(api.search(configured, 'lisst').total, 0);
    assert.equal(api.search(api.buildSearchIndex(library), 'ledger').total, 0);
    const international = api.buildSearchIndex({ components: { schemas: { Cafe: { description: 'Caf\u00e9 \u041a\u043d\u0438\u0433\u0430' } } } });
    assert.equal(api.search(international, 'cafe').entries[0].name, 'Cafe');
    assert.equal(api.search(international, '\u043a\u043d\u0438\u0433\u0430').entries[0].name, 'Cafe');
    for (const options of [{ limit: -1 }, { fuzzy: 'yes' }, { synonyms: 'book' }, { normalizeTerm: () => '' }]) {
        assert.throws(() => api.buildSearchIndex(library, options), TypeError);
    }
});

test('typo matching does not accept two edits as one', () => {
    const index = api.buildSearchIndex({ components: { schemas: { Zebra: { type: 'string' } } } });
    assert.equal(api.search(index, 'zebraa').total, 1);
    assert.equal(api.search(index, 'xebraa').total, 0);
});

test('retrieval enforces budgets and rejects invalid values', () => {
    const data = api.buildAssistantIndex(spec);
    for (const budget of [0, 199, 200, 1000, 24000]) assert(api.retrieve(data, 'Payment', budget).context.length <= budget);
    for (const budget of [NaN, Infinity, -1, 2.5]) assert.throws(() => api.retrieve(data, 'Payment', budget), TypeError);
});

test('OpenRouter handles empty success bodies, redacts provider errors and validates keys before fetch', async () => {
    const models = [{ id: 'sample/model' }];
    await assert.rejects(api.completeOpenRouter('test-key', [], undefined,
        async () => ({ ok: true, json: async () => null }), undefined, models), /no answer text/);
    await assert.rejects(api.completeOpenRouter('secret-key', [], undefined,
        async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad secret-key' } }) }), undefined, models),
    error => !error.message.includes('secret-key') && error.message.includes('[key hidden]'));
    await assert.rejects(api.completeOpenRouter('bad\nkey', [], undefined, () => { assert.fail('Must not send invalid key'); }, undefined, models), /API key/);
});

test('abort completes even when a custom fetcher ignores the signal', async () => {
    const controller = new AbortController();
    const result = api.completeOpenRouter('test-key', [], controller.signal, () => new Promise(() => {}), undefined, [{ id: 'sample/model' }]);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
});
