'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../fixtures/library.openapi.json');
const api = require('../dist/index.cjs');

test('ES module entry exposes named exports', async () => {
    const module = await import('@k0tarak/swagger-search-ai');
    const standalone = await import('@k0tarak/swagger-search-ai/standalone');
    assert.equal(typeof module.buildAssistantIndex, 'function');
    assert.equal(typeof module.createSwaggerSearch, 'function');
    assert.equal(typeof standalone.mount, 'function');
});

test('ordinary search indexes operations, standalone schemas, fields, and nested fields', () => {
    const index = api.buildSearchIndex(spec);
    assert(api.search(index, 'listbooks').entries.some(entry => entry.kind === 'operation'));
    assert(api.search(index, 'realtimeevent').entries.some(entry => entry.kind === 'model'));
    assert(api.search(index, 'sequence').entries.some(entry => entry.kind === 'field'));
    assert.deepEqual(api.search(index, '   '), { total: 0, entries: [] });
});

test('retrieval keeps relevant operation details and schema-only recursive context within budget', () => {
    const data = api.buildAssistantIndex(spec);
    const page = api.retrieve(data, 'How do I list books with the next cursor?');
    assert(page.sources.some(source => source.name === 'ListBooks'));
    assert.match(page.context, /nextCursor/);
    assert(page.context.length <= 24000);
    const event = api.retrieve(data, 'What is RealtimeEvent.kind and its payload sequence?');
    assert(event.sources.some(source => source.name === 'RealtimeEvent'));
    assert.match(event.context, /connected/);
    assert.match(event.context, /sequence/);
    assert(event.context.length <= 24000);
    assert.deepEqual(api.retrieve(data, 'banana protocol').sources, []);
});

test('configured aliases add domain terms without changing package defaults', () => {
    const plain = api.retrieve(api.buildAssistantIndex(spec), 'shelf');
    const customized = api.retrieve(api.buildAssistantIndex(spec, { aliases: [['shelf', 'Book']] }), 'shelf');
    assert(!plain.sources.some(source => source.name === 'Book'));
    assert(customized.sources.length > 0);
    assert.match(customized.context, /Schema: Book/);
});

test('OpenRouter uses one request on success and sends only configured model options', async () => {
    const calls = [];
    const fetcher = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' } }], model: 'sample/model' }) };
    };
    const models = [{ id: 'sample/model', reasoning: { effort: 'low' }, maxTokens: 500 }];
    const result = await api.completeOpenRouter('test-key', [{ role: 'user', content: 'Question' }], undefined, fetcher, undefined, models);
    assert.equal(result.content, 'Answer');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        model: 'sample/model', messages: [{ role: 'user', content: 'Question' }], stream: false,
        reasoning: { effort: 'low' }, max_tokens: 500
    });
});

test('OpenRouter falls back sequentially on a retryable error and never on authentication errors', async () => {
    const models = [{ id: 'first' }, { id: 'second', name: 'Backup' }];
    const calls = [], fallback = [];
    const fetcher = async (_url, options) => {
        calls.push(JSON.parse(options.body).model);
        return calls.length === 1
            ? { ok: false, status: 503, json: async () => ({ error: { message: 'Unavailable' } }) }
            : { ok: true, json: async () => ({ choices: [{ message: { content: 'Done' } }] }) };
    };
    const result = await api.completeOpenRouter('test-key', [], undefined, fetcher, name => fallback.push(name), models);
    assert.equal(result.content, 'Done');
    assert.deepEqual(calls, ['first', 'second']);
    assert.deepEqual(fallback, ['Backup']);
    let attempts = 0;
    await assert.rejects(api.completeOpenRouter('test-key', [], undefined,
        async () => { attempts++; return { ok: false, status: 401, json: async () => ({ error: {} }) }; },
        undefined, models), /authenticate/);
    assert.equal(attempts, 1);
});
