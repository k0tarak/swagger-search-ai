'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const yaml = require('js-yaml');
const spec = require('../fixtures/library.openapi.json');
const pets = require('../fixtures/pets.openapi.json');

function browser(html = '<div id="controls"></div><div id="swagger-ui"></div>', url = 'https://example.test/docs') {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const win = dom.window;
    win.ResizeObserver = class { observe() {} disconnect() {} };
    win.HTMLElement.prototype.scrollIntoView = function () {};
    win.scrollTo = () => {};
    win.requestAnimationFrame = callback => win.setTimeout(callback, 0);
    win.cancelAnimationFrame = id => win.clearTimeout(id);
    win.eval(fs.readFileSync('dist/plugin.js', 'utf8'));
    return dom;
}

test('assistant requests the question language and leaves a truncated non-English answer intact', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    let request;
    const reply = 'Используйте `ListBooks` для получения списка книг.';
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }], fetch: async (_url, options) => {
            request = JSON.parse(options.body);
            return { ok: true, status: 200, json: async () => ({ choices: [{
                finish_reason: 'length', message: { content: reply }
            }] }) };
        } } });
    try {
        extension.attach({ specSelectors: { specJson: () => ({ toJS: () => spec }) } });
        doc.getElementById('assistant-key').value = 'test-key';
        const question = 'Как работает ListBooks?';
        doc.getElementById('assistant-question').value = question;
        doc.getElementById('assistant-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(request, 'A technical identifier must find context even in a question in another language');
        assert.match(request.messages[0].content, /Answer in the language of the user question/);
        assert.match(request.messages[0].content, /Preserve operation names/);
        assert(!request.messages[0].content.includes('Answer in English'));
        assert(request.messages[1].content.includes(question));
        assert.match(doc.getElementById('assistant-answer').textContent, /Используйте ListBooks/);
        assert(!doc.getElementById('assistant-answer').textContent.includes('truncated'));
        assert.match(doc.getElementById('assistant-status').textContent, /Answer truncated/);
        assert.equal(doc.getElementById('assistant-submit').disabled, false);
    } finally { extension.destroy(); win.close(); }
});

test('assistant displays redacted OpenRouter errors as text and recovers on the next request', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    let calls = 0;
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'primary' }, { id: 'backup' }], fetch: async () => {
            calls++;
            return calls === 1
                ? { ok: true, status: 200, json: async () => ({ error: { code: 403,
                    message: 'Denied secret-key <img src=x onerror=alert(1)>', metadata: { error_type: 'permission_denied' } } }) }
                : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
        } } });
    try {
        doc.getElementById('assistant-key').value = 'secret-key';
        doc.getElementById('assistant-check').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const status = doc.getElementById('assistant-status');
        assert.equal(calls, 1);
        assert.match(status.textContent, /permissions.*guardrails/);
        assert.match(status.textContent, /\[key hidden\]/);
        assert(!status.textContent.includes('secret-key'));
        assert.equal(status.querySelector('img'), null);
        assert.equal(status.dataset.error, 'true');
        assert.equal(doc.getElementById('assistant-check').disabled, false);
        doc.getElementById('assistant-check').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(calls, 2);
        assert.match(status.textContent, /Connection works/);
        assert.equal(status.dataset.error, 'false');
    } finally { extension.destroy(); win.close(); }
});

test('assistant explains malformed keys before making a request', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }], fetch: () => assert.fail('Invalid key must not reach fetch') } });
    try {
        doc.getElementById('assistant-key').value = 'invalid key';
        doc.getElementById('assistant-check').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.match(doc.getElementById('assistant-status').textContent, /API key.*without spaces/);
        assert.equal(doc.getElementById('assistant-settings').open, true);
        assert.equal(doc.getElementById('assistant-check').disabled, false);
    } finally { extension.destroy(); win.close(); }
});

test('API keys stay in memory unless the host enables persistence', () => {
    const dom = browser(undefined, 'https://example.test/docs?ORT=dGVzdC1rZXk');
    const win = dom.window, doc = win.document;
    win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }] } });
    assert.equal(doc.getElementById('assistant-key-persistence').hidden, true);
    assert.equal(doc.getElementById('assistant-key').value, '');
    const input = doc.getElementById('assistant-key');
    input.value = 'new-key';
    input.dispatchEvent(new win.Event('input'));
    assert.equal(win.location.search, '?ORT=dGVzdC1rZXk');
    assert.equal(win.localStorage.length, 0);
    win.close();
});

test('an enabled URL choice restores the legacy ORT parameter and can remove it', () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const ai = { models: [{ id: 'sample/model' }], keyPersistence: { url: true } };
    win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), ai });
    assert.equal(doc.getElementById('assistant-key-persistence').hidden, false);
    assert.equal(doc.getElementById('assistant-key-local-option').hidden, true);
    const input = doc.getElementById('assistant-key');
    input.value = 'test-key';
    input.dispatchEvent(new win.Event('input'));
    assert.equal(win.location.search, '');
    const choice = doc.getElementById('assistant-key-mode-url');
    choice.checked = true;
    choice.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.match(win.location.search, /ORT=/);
    assert(!win.location.href.includes('test-key'));
    const savedUrl = win.location.href;
    win.close();

    const reopened = browser(undefined, savedUrl), next = reopened.window, nextDoc = next.document;
    next.SwaggerSearchAI.createSwaggerSearch({ element: nextDoc.getElementById('controls'), ai });
    assert.equal(nextDoc.getElementById('assistant-key').value, 'test-key');
    assert.equal(nextDoc.getElementById('assistant-key-mode-url').checked, true);
    nextDoc.getElementById('assistant-forget').click();
    assert.equal(next.location.search, '');
    assert.equal(nextDoc.getElementById('assistant-key').value, '');
    next.close();
});

test('an enabled browser storage choice survives reopening and can be cleared', () => {
    const ai = { models: [{ id: 'sample/model' }], keyPersistence: { localStorage: true } };
    const dom = browser(), win = dom.window, doc = win.document;
    win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), ai });
    assert.equal(doc.getElementById('assistant-key-url-option').hidden, true);
    const input = doc.getElementById('assistant-key');
    input.value = 'test-key';
    input.dispatchEvent(new win.Event('input'));
    const choice = doc.getElementById('assistant-key-mode-local');
    choice.checked = true;
    choice.dispatchEvent(new win.Event('change', { bubbles: true }));
    const storageKey = 'swagger-search-ai:openrouter-key';
    assert.equal(win.localStorage.getItem(storageKey), 'test-key');
    assert.equal(win.location.search, '');
    win.close();

    const reopened = browser(), next = reopened.window, nextDoc = next.document;
    next.localStorage.setItem(storageKey, 'test-key');
    next.SwaggerSearchAI.createSwaggerSearch({ element: nextDoc.getElementById('controls'), ai });
    assert.equal(nextDoc.getElementById('assistant-key').value, 'test-key');
    assert.equal(nextDoc.getElementById('assistant-key-mode-local').checked, true);
    const memory = nextDoc.getElementById('assistant-key-mode-memory');
    memory.checked = true;
    memory.dispatchEvent(new next.Event('change', { bubbles: true }));
    assert.equal(next.localStorage.getItem(storageKey), null);
    assert.equal(nextDoc.getElementById('assistant-key').value, 'test-key');
    next.close();
});

test('switching between URL and browser storage removes the earlier copy', () => {
    const dom = browser(), win = dom.window, doc = win.document;
    win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }], keyPersistence: { url: true, localStorage: true } } });
    const input = doc.getElementById('assistant-key');
    input.value = 'test-key';
    input.dispatchEvent(new win.Event('input'));
    const choose = id => {
        const radio = doc.getElementById(id);
        radio.checked = true;
        radio.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    choose('assistant-key-mode-url');
    assert.match(win.location.search, /ORT=/);
    choose('assistant-key-mode-local');
    assert.equal(win.location.search, '');
    assert.equal(win.localStorage.getItem('swagger-search-ai:openrouter-key'), 'test-key');
    choose('assistant-key-mode-url');
    assert.match(win.location.search, /ORT=/);
    assert.equal(win.localStorage.length, 0);
    win.close();
});

test('unavailable browser storage leaves the key in memory and reports failed removal', () => {
    const dom = browser(), win = dom.window, doc = win.document;
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('Storage blocked'); } });
    win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }], keyPersistence: { localStorage: true } } });
    const input = doc.getElementById('assistant-key');
    input.value = 'test-key';
    input.dispatchEvent(new win.Event('input'));
    const choice = doc.getElementById('assistant-key-mode-local');
    choice.checked = true;
    choice.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.equal(doc.getElementById('assistant-key-mode-memory').checked, true);
    assert.equal(input.value, 'test-key');
    assert.equal(doc.getElementById('assistant-status').dataset.error, 'true');
    doc.getElementById('assistant-forget').click();
    assert.equal(input.value, '');
    assert.match(doc.getElementById('assistant-status').textContent, /could not be verified or fully cleared/);
    win.close();
});

test('browser plugin mounts English controls and attaches a loaded specification', () => {
    const dom = browser(), { document: doc } = dom.window;
    const extension = dom.window.SwaggerSearchAI.createSwaggerSearch({
        element: doc.getElementById('controls'),
        title: 'Example API',
        ai: { models: [{ id: 'sample/model' }] }
    });
    assert.equal(doc.querySelector('.api-search-brand').textContent, 'Example API');
    assert.equal(doc.querySelector('#assistant-key').type, 'password');
    const fake = { specSelectors: { specJson: () => ({ toJS: () => spec }) } };
    extension.attach(fake);
    const input = doc.getElementById('api-search-input');
    assert.equal(input.disabled, false);
    input.value = 'RealtimeEvent';
    input.dispatchEvent(new dom.window.Event('input'));
    assert.match(doc.querySelector('#api-search-results').textContent, /RealtimeEvent/);
    input.value = 'Book';
    input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(doc.querySelector('.api-search-option .api-search-badge').textContent, 'MODEL');
    assert.match(doc.querySelector('#assistant-status').textContent, /Ready for questions/);
    assert.equal(doc.querySelector('[data-ready="true"]'), null);
    dom.window.close();
});

test('assistant stays optional and model configuration is validated', () => {
    const dom = browser(), doc = dom.window.document;
    assert.throws(() => dom.window.SwaggerSearchAI.createSwaggerSearch({
        element: doc.getElementById('controls'), ai: { models: [] }
    }), /ai.models/);
    assert.throws(() => dom.window.SwaggerSearchAI.createSwaggerSearch({
        element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }], aliases: [['', 'Book']] }
    }), /aliases/);
    for (const ai of [null, 0, 'yes', []]) {
        assert.throws(() => dom.window.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), ai }), /ai must be/);
        assert.equal(doc.querySelector('.swagger-search-ai'), null);
    }
    for (const ai of [undefined, false]) {
        const extension = dom.window.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), ai });
        assert.equal(doc.querySelector('.api-assistant'), null);
        extension.destroy();
    }
    dom.window.close();
});

test('ai true and empty options work without model configuration and make no requests until asked', async () => {
    for (const ai of [true, {}]) {
        const dom = browser(), win = dom.window, doc = win.document;
        const calls = [];
        win.fetch = async (_url, options) => {
            calls.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
        };
        const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), ai });
        try {
            extension.attach({ specSelectors: { specJson: () => ({ toJS: () => spec }) } });
            assert.equal(doc.getElementById('assistant-submit').disabled, false);
            assert.equal(doc.getElementById('assistant-key-persistence').hidden, true);
            assert.equal(calls.length, 0);
            doc.getElementById('assistant-key').value = 'test-key';
            doc.getElementById('assistant-check').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(calls.length, 1);
            assert.equal(calls[0].model, 'poolside/laguna-s-2.1:free');
            assert.match(doc.getElementById('assistant-status').textContent, /Connection works/);
        } finally { extension.destroy(); win.close(); }
    }
});

test('partial assistant settings keep default models, apply vocabulary and budget, and leave caller options untouched', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    let sent;
    const ai = Object.freeze({ contextBudget: 1000, aliases: [['shelf', 'Book']], fetch: async (_url, options) => {
        sent = JSON.parse(options.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'The Book schema.' } }] }) };
    } });
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), ai });
    try {
        extension.attach({ specSelectors: { specJson: () => ({ toJS: () => spec }) } });
        doc.getElementById('assistant-key').value = 'test-key';
        doc.getElementById('assistant-question').value = 'shelf';
        doc.getElementById('assistant-form').dispatchEvent(new win.Event('submit', { cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(sent.model, 'poolside/laguna-s-2.1:free');
        const context = sent.messages[1].content.split('OpenAPI fragments:\n')[1];
        assert.match(context, /Schema: Book/);
        assert(context.length <= 1000);
        assert.equal(ai.models, undefined);
        assert.match(doc.getElementById('assistant-status').textContent, /Answer ready/);
    } finally { extension.destroy(); win.close(); }
});

test('an answer started for one specification cannot appear after switching to another', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    let release;
    const extension = win.SwaggerSearchAI.createSwaggerSearch({
        element: doc.getElementById('controls'),
        ai: { models: [{ id: 'sample/model' }], fetch: () => new Promise(resolve => { release = resolve; }) }
    });
    const uiFor = value => ({ specSelectors: { specJson: () => ({ toJS: () => value }) } });
    extension.attach(uiFor(spec));
    doc.getElementById('assistant-key').value = 'test-key';
    doc.getElementById('assistant-question').value = 'What is Book?';
    doc.getElementById('assistant-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; !release && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(typeof release, 'function');
    extension.attach(uiFor(pets));
    release({ ok: true, json: async () => ({ choices: [{ message: { content: 'Outdated answer' } }] }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(!doc.getElementById('assistant-answer').textContent.includes('Outdated answer'));
    assert.match(doc.getElementById('assistant-status').textContent, /Ready for questions/);
    win.close();
});

test('Markdown refuses arbitrary HTML, model URLs, and images while preserving contract links', () => {
    const dom = browser('<div id="answer"></div>');
    const win = dom.window, doc = win.document;
    win.marked = require('marked');
    win.eval(fs.readFileSync('src/assistant-rich-text.js', 'utf8'));
    const entries = [{ kind: 'model', name: 'Book', model: 'Book', specPath: ['components', 'schemas', 'Book'] }];
    const view = win.SwaggerAssistantRichText.create(doc, () => {});
    view.render(doc.getElementById('answer'),
        '# Result\n\n`Book` <img src=x onerror=alert(1)> [unsafe](javascript:alert(1)) ![pixel](https://example.test/pixel)',
        entries, []);
    assert.equal(doc.querySelector('#answer h3').textContent, 'Result');
    assert.equal(doc.querySelectorAll('#answer button.assistant-reference').length, 1);
    assert.equal(doc.querySelectorAll('#answer img, #answer a, #answer script, #answer [onerror]').length, 0);
    win.close();
});

test('touch opens a stable contract preview; only the explicit option navigates', () => {
    const dom = browser('<div id="answer"></div>');
    const win = dom.window, doc = win.document;
    win.marked = require('marked');
    win.eval(fs.readFileSync('src/assistant-rich-text.js', 'utf8'));
    let navigations = 0;
    const view = win.SwaggerAssistantRichText.create(doc, () => navigations++);
    view.render(doc.getElementById('answer'), '`Book`', [
        { kind: 'model', name: 'Book', model: 'Book', specPath: ['components', 'schemas', 'Book'] }
    ], []);
    const link = doc.querySelector('.assistant-reference');
    const event = new win.Event('pointerdown');
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    link.dispatchEvent(event);
    link.click();
    assert.equal(navigations, 0);
    const card = doc.querySelector('.assistant-reference-card');
    assert.equal(card.hidden, false);
    card.querySelector('.assistant-reference-option').click();
    assert.equal(navigations, 1);
    assert.equal(card.hidden, true);
    win.close();
});

test('standalone bundle mounts a real Swagger UI and enables search after loading', async () => {
    const dom = new JSDOM('<div id="docs"></div>', { url: 'https://example.test/docs', runScripts: 'outside-only' });
    const win = dom.window;
    win.ResizeObserver = class { observe() {} disconnect() {} };
    win.HTMLElement.prototype.scrollIntoView = function () {};
    win.scrollTo = () => {};
    win.requestAnimationFrame = callback => win.setTimeout(callback, 0);
    win.cancelAnimationFrame = id => win.clearTimeout(id);
    win.eval(fs.readFileSync('dist/standalone.js', 'utf8'));
    const mounted = win.SwaggerSearchAI.mount({ element: win.document.getElementById('docs'), openapi: spec, ai: true });
    assert(mounted.ui.getSystem());
    assert(win.document.getElementById('swagger-ui'));
    const input = win.document.getElementById('api-search-input');
    for (let i = 0; input.disabled && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(input.disabled, false);
    assert.equal(win.document.getElementById('assistant-submit').disabled, false);
    assert.match(win.document.getElementById('assistant-status').textContent, /Ready for questions/);
    mounted.destroy();
    win.close();
});

test('searches every API, labels results, switches Swagger UI on selection, and keeps AI on the active API', async () => {
    const dom = new JSDOM('<div id="docs"></div>', { url: 'https://example.test/docs', runScripts: 'outside-only' });
    const win = dom.window;
    // Use Node's signal for Node's fetch; DOM event listeners retain jsdom's signal.
    win.fetch = (url, options) => {
        const controller = new AbortController();
        if (options?.signal?.aborted) controller.abort();
        else options?.signal?.addEventListener('abort', () => controller.abort(), { once: true });
        return fetch(url, { ...options, signal: controller.signal });
    };
    win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {} });
    win.ResizeObserver = class { observe() {} disconnect() {} };
    win.HTMLElement.prototype.scrollIntoView = function () {};
    win.scrollTo = () => {};
    win.requestAnimationFrame = callback => win.setTimeout(callback, 0);
    win.cancelAnimationFrame = id => win.clearTimeout(id);
    win.eval(fs.readFileSync('dist/standalone.js', 'utf8'));
    const url = value => 'data:application/json,' + encodeURIComponent(JSON.stringify(value));
    const petsWithDuplicate = structuredClone(pets);
    petsWithDuplicate.components.schemas.Book = { type: 'object', description: 'A pet reading log.' };
    const documents = [{ name: 'Library', url: url(spec) },
        { name: 'Pets', url: 'data:application/yaml,' + encodeURIComponent(yaml.dump(petsWithDuplicate)) },
        { name: 'Broken', url: 'data:application/json,not-json' }];
    const intercepted = [];
    const mounted = win.SwaggerSearchAI.mount({
        element: win.document.getElementById('docs'), openapi: documents,
        ai: { models: [{ id: 'sample/model' }] },
        swagger: { requestInterceptor(request) { intercepted.push(request.url); return request; } }
    });
    assert(mounted.ui.getSystem());
    const doc = win.document;
    const input = doc.getElementById('api-search-input');
    async function until(condition) {
        for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert(condition(), 'The selected specification did not finish loading');
    }
    await until(() => !input.disabled && doc.querySelector('.api-spec-current').textContent === 'Library API');
    await until(() => doc.querySelector('.api-search-catalog').textContent.includes('2/3 APIs indexed'));
    assert(intercepted.includes(documents[1].url));
    input.value = 'ListPets';
    input.dispatchEvent(new win.Event('input'));
    assert.match(doc.getElementById('api-search-results').textContent, /API: Pets/);
    const selector = doc.querySelector('select');
    assert.deepEqual([...selector.options].map(option => option.textContent), ['Library', 'Pets', 'Broken']);
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(input.disabled, true);
    await until(() => !input.disabled && doc.querySelector('.api-spec-current').textContent === 'Pets API');
    assert.equal(selector.value, documents[1].url);
    input.value = 'Book';
    input.dispatchEvent(new win.Event('input'));
    assert.match(doc.getElementById('api-search-results').textContent, /API: Library/);
    assert.match(doc.getElementById('api-search-results').textContent, /API: Pets/);
    assert.match(doc.querySelector('.api-assistant-scope').textContent, /Current API: Pets API/);
    assert.match(doc.getElementById('assistant-status').textContent, /Ready for questions/);
    doc.querySelector('.api-search-option').click();
    await until(() => !input.disabled && doc.querySelector('.api-spec-current').textContent === 'Library API');
    assert.equal(selector.value, documents[0].url);
    selector.value = documents[2].url;
    selector.dispatchEvent(new win.Event('change', { bubbles: true }));
    await until(() => doc.querySelector('.api-spec-current').textContent.startsWith('Could not load'));
    assert.equal(input.disabled, false);
    assert.match(doc.getElementById('api-search-results').textContent, /API: Library/);
    assert.equal(doc.getElementById('assistant-status').dataset.error, 'true');
    selector.value = documents[0].url;
    selector.dispatchEvent(new win.Event('change', { bubbles: true }));
    await until(() => !input.disabled && doc.querySelector('.api-spec-current').textContent === 'Library API');
    input.value = 'Book';
    input.dispatchEvent(new win.Event('input'));
    assert.match(doc.getElementById('api-search-results').textContent, /Book/);
    win.close();
});

test('multiple specification configuration requires distinct named URLs', () => {
    const dom = new JSDOM('<div id="docs"></div>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(fs.readFileSync('dist/standalone.js', 'utf8'));
    const element = win.document.getElementById('docs');
    assert.throws(() => win.SwaggerSearchAI.mount({ element, openapi: [{ name: 'One', url: '/a' }, { name: 'One', url: '/b' }] }),
        /unique/);
    assert.throws(() => win.SwaggerSearchAI.mount({ element, openapi: [{ name: 'One', url: '/a' }], primaryName: 'Missing' }),
        /primaryName/);
    win.close();
});

test('destroy releases global controls and allows a clean remount, including CommonJS consumers', () => {
    const dom = browser(), win = dom.window, doc = win.document;
    let disconnected = 0;
    win.ResizeObserver = class { observe() {} disconnect() { disconnected++; } };
    const api = require('../dist/index.cjs');
    const element = doc.getElementById('controls');
    const first = api.createSwaggerSearch({ element, ai: { models: [{ id: 'test/model' }] } });
    assert.throws(() => api.createSwaggerSearch({ element }), /one.*instance/);
    first.destroy(); first.destroy();
    assert.equal(disconnected, 1);
    assert.equal(doc.querySelectorAll('.api-search-return, .assistant-reference-card, .swagger-search-ai').length, 0);
    assert.equal(first.attach({}), false);
    const next = api.createSwaggerSearch({ element });
    next.attach({ specSelectors: { specJson: () => ({ toJS: () => spec }) } });
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true }));
    assert.equal(doc.activeElement, doc.getElementById('api-search-input'));
    next.destroy(); win.close();
});

test('standalone can be destroyed before loading and remounted without duplicate IDs', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    win.eval(fs.readFileSync('dist/standalone.js', 'utf8'));
    const element = doc.getElementById('controls');
    const first = win.SwaggerSearchAI.mount({ element, openapi: spec });
    first.destroy(); first.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(element.children.length, 0);
    const next = win.SwaggerSearchAI.mount({ element, openapi: spec });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(doc.querySelectorAll('#swagger-ui').length, 1);
    assert.equal(doc.getElementById('api-search-input').disabled, false);
    next.destroy(); win.close();
});

test('search options reach the widget and invalid configuration leaves no partial UI', () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const element = doc.getElementById('controls');
    assert.throws(() => win.SwaggerSearchAI.createSwaggerSearch({ element, search: { limit: 0 } }), /limit/);
    assert.equal(element.children.length, 0);
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element,
        search: { synonyms: ['volume book'], limit: 1 } });
    extension.attach({ specSelectors: { specJson: () => ({ toJS: () => spec }) } });
    const input = doc.getElementById('api-search-input');
    input.value = 'volume'; input.dispatchEvent(new win.Event('input'));
    assert.equal(doc.querySelectorAll('[role="option"]').length, 1);
    assert.match(doc.getElementById('api-search-results').textContent, /Book/);
    extension.destroy(); win.close();
});

test('catalog reserves queued documents once and forwards credentials and cancellation', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const documents = Array.from({ length: 9 }, (_, i) => ({ name: `API ${i}`, url: `https://example.test/${i}.json` }));
    const calls = [], releases = [];
    const system = { getConfigs: () => ({ urls: documents, withCredentials: true }),
        specSelectors: { url: () => documents[0].url }, fn: { fetch(options) {
            calls.push(options);
            return new Promise(resolve => releases.push(() => resolve({ status: 200, text: JSON.stringify(pets) })));
        } } };
    const ui = { getSystem: () => system, specSelectors: { specJson: () => ({ toJS: () => spec }) } };
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls') });
    extension.attach(ui); extension.attach(ui);
    assert.equal(calls.length, 4);
    for (const call of calls) { assert.equal(call.credentials, 'include'); assert(call.signal); }
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 8);
    extension.attach(ui);
    assert.equal(calls.length, 8);
    extension.destroy();
    assert(calls.slice(4).every(call => call.signal.aborted));
    releases.forEach(release => release());
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(doc.querySelector('.swagger-search-ai'), null);
    win.close();
});

test('unresponsive catalog requests time out, expose Retry, and recover', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const documents = [{ name: 'Library', url: '/library' }, { name: 'Pets', url: '/pets' }];
    let fail = true;
    const system = { getConfigs: () => ({ urls: documents }), specSelectors: { url: () => '/library' },
        fn: { fetch: () => fail ? new Promise(() => {}) : Promise.resolve({ status: 200, text: JSON.stringify(pets) }) } };
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'), catalogTimeoutMs: 10 });
    extension.attach({ getSystem: () => system, specSelectors: { specJson: () => ({ toJS: () => spec }) } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(doc.querySelector('.api-search-catalog-text').textContent, /1 unavailable/);
    assert.equal(doc.querySelector('.api-search-retry').hidden, false);
    fail = false; doc.querySelector('.api-search-retry').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(doc.querySelector('.api-search-catalog-text').textContent, /Search all 2 APIs/);
    extension.destroy(); win.close();
});

test('other APIs remain discoverable when the initial selected specification is invalid', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const system = { getConfigs: () => ({ urls: [{ name: 'Broken', url: '/broken' }, { name: 'Pets', url: '/pets' }] }),
        specSelectors: { url: () => '/broken' },
        fn: { fetch: async () => ({ status: 200, text: JSON.stringify(pets) }) } };
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls') });
    assert.equal(extension.attach({ getSystem: () => system, specSelectors: { specJson: () => ({ toJS: () => ({}) }) } }), false);
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = doc.getElementById('api-search-input');
    assert.equal(input.disabled, false);
    input.value = 'ListPets'; input.dispatchEvent(new win.Event('input'));
    assert.match(doc.getElementById('api-search-results').textContent, /API: Pets/);
    assert.match(doc.querySelector('.api-search-catalog-text').textContent, /1\/2 APIs indexed/);
    extension.destroy(); win.close();
});

test('assistant cancellation and timeout recover even when fetch ignores AbortSignal', async () => {
    const dom = browser(), win = dom.window, doc = win.document;
    const extension = win.SwaggerSearchAI.createSwaggerSearch({ element: doc.getElementById('controls'),
        ai: { models: [{ id: 'test/model' }], timeoutMs: 20, fetch: () => new Promise(() => {}) } });
    extension.attach({ specSelectors: { specJson: () => ({ toJS: () => spec }) } });
    doc.getElementById('assistant-key').value = 'test-key';
    doc.getElementById('assistant-check').click();
    doc.getElementById('assistant-cancel').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(doc.getElementById('assistant-status').textContent, /canceled/);
    assert.equal(doc.getElementById('assistant-check').disabled, false);
    doc.getElementById('assistant-check').click();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.match(doc.getElementById('assistant-status').textContent, /did not respond/);
    assert.equal(doc.getElementById('assistant-check').disabled, false);
    extension.destroy(); win.close();
});

test('Swagger resolver handles recursive internal references from a file base without hiding missing targets', async () => {
    const dom = new JSDOM('<div id="swagger-ui"></div>', { url: 'https://example.test/docs', runScripts: 'outside-only' });
    const win = dom.window;
    win.scrollTo = () => {};
    win.HTMLElement.prototype.scrollIntoView = function () {};
    win.eval(fs.readFileSync('dist/standalone.js', 'utf8'));
    const ui = win.SwaggerSearchAI.mount({ element: win.document.getElementById('swagger-ui'), openapi: spec }).ui;
    const resolver = ui.getSystem().fn;
    const valid = await resolver.resolveSubtree(spec, ['components', 'schemas', 'Book'],
        { baseDoc: 'file:///example/library.openapi.json' });
    assert.equal(valid.errors.length, 0);
    assert(valid.spec.properties.related);
    const broken = structuredClone(spec);
    broken.components.schemas.Broken = { properties: { missing: { $ref: '#/components/schemas/Absent' } } };
    const invalid = await resolver.resolveSubtree(broken, ['components', 'schemas', 'Broken'],
        { baseDoc: 'file:///example/library.openapi.json' });
    assert(invalid.errors.length > 0);
    win.close();
});
