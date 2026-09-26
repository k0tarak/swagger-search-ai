'use strict';

const search = require('./search.js');
const assistant = require('./assistant.js');
const yaml = require('js-yaml');
const { validateSpecifications } = require('./openapi.js');
const abortable = require('./abortable.js');

function validSpec(spec) {
    return spec && typeof spec === 'object' && !Array.isArray(spec) &&
        (spec.openapi || spec.swagger) && spec.info;
}

// The controls are mounted beside Swagger UI, so Swagger can own and rerender its own root.
function createSwaggerSearch({ element, ai, title = 'API reference', showSpecificationName = false,
    specifications, search: searchOptions = {}, catalogTimeoutMs = 30000 } = {}) {
    if (!element || typeof element.append !== 'function') throw new TypeError('element must be a DOM element');
    const doc = element.ownerDocument;
    if (!doc?.defaultView || !element.isConnected) throw new TypeError('element must be connected to a browser document');
    if (doc.getElementById('api-search-input')) throw new Error('Use one Swagger Search AI instance per document. Call destroy() before mounting again.');
    ai = assistant.resolveConfiguration(ai);
    search.validateOptions(searchOptions);
    if (!Number.isInteger(catalogTimeoutMs) || catalogTimeoutMs < 1) throw new TypeError('catalogTimeoutMs must be a positive integer');
    if (specifications !== undefined) validateSpecifications(specifications, doc.baseURI);
    const shell = doc.createElement('div');
    shell.className = 'swagger-search-ai';
    shell.innerHTML = `
<header class="api-search" aria-label="API search">
  <div class="api-search-inner">
    <div class="api-search-brand-block"><span class="api-search-brand"></span><span class="api-spec-current" role="status" aria-live="polite" hidden></span><span class="api-search-catalog" hidden><span class="api-search-catalog-text" role="status" aria-live="polite"></span> <button class="api-search-retry" type="button" hidden>Retry</button></span></div>
    <div class="api-search-control">
      <label class="api-search-label" for="api-search-input">Search API</label>
      <div class="api-search-box">
        <span class="api-search-icon" aria-hidden="true">⌕</span>
        <input id="api-search-input" type="search" role="combobox" autocomplete="off"
          aria-autocomplete="list" aria-controls="api-search-results" aria-expanded="false"
          aria-describedby="api-search-status" placeholder="Loading search…" disabled>
        <button id="api-search-clear" type="button" aria-label="Clear search" hidden>×</button>
        <kbd id="api-search-shortcut">Ctrl K</kbd>
      </div>
      <div id="api-search-panel" class="api-search-panel" hidden>
        <div id="api-search-status" class="api-search-status" role="status"></div>
        <div id="api-search-results" role="listbox" aria-label="Search results"></div>
        <div class="api-search-footer"><span>↑ ↓ select · Enter open</span><span>Esc close</span></div>
      </div>
    </div>
  </div>
</header>
<div id="api-search-notice" class="api-search-notice" role="status" hidden></div>
<details class="api-assistant" open>
  <summary>API assistant <span>OpenRouter</span><span class="api-assistant-scope">Current API</span></summary>
  <div class="assistant-body">
    <details id="assistant-settings" class="assistant-settings">
      <summary>Connection <span id="assistant-key-status">Add an API key</span></summary>
      <div class="assistant-key-row">
        <label for="assistant-key">OpenRouter API key</label>
        <input id="assistant-key" type="password" autocomplete="off" spellcheck="false" maxlength="512"
          placeholder="Enter your API key">
        <button id="assistant-check" type="button">Check connection</button>
        <button id="assistant-forget" type="button">Remove key</button>
      </div>
      <fieldset id="assistant-key-persistence" class="assistant-key-persistence" hidden>
        <legend>Keep this key</legend>
        <label><input id="assistant-key-mode-memory" type="radio" name="assistant-key-mode" value="memory" checked> Only while this page is open</label>
        <label id="assistant-key-url-option" hidden><input id="assistant-key-mode-url" type="radio" name="assistant-key-mode" value="url"> In this page URL <small>Anyone with the link can decode and use the key.</small></label>
        <label id="assistant-key-local-option" hidden><input id="assistant-key-mode-local" type="radio" name="assistant-key-mode" value="localStorage"> In this browser <small>Remains after browser restarts; other scripts on this site can read it.</small></label>
      </fieldset>
    </details>
    <form id="assistant-form">
      <label for="assistant-question">API question</label>
      <textarea id="assistant-question" rows="2" maxlength="3000" required
        placeholder="How does this operation work?"></textarea>
      <div class="assistant-actions">
        <button id="assistant-submit" type="submit" disabled>Ask</button>
        <button id="assistant-cancel" type="button" hidden>Cancel</button>
        <span id="assistant-status" role="status" aria-live="polite">Loading documentation…</span>
      </div>
    </form>
    <section id="assistant-result" hidden>
      <div id="assistant-answer" aria-label="AI answer" tabindex="0"></div>
    </section>
  </div>
</details>`;
    shell.querySelector('.api-search-brand').textContent = title;
    if (showSpecificationName) shell.querySelector('.api-spec-current').hidden = false;
    if (!ai) shell.querySelector('.api-assistant').remove();
    element.append(shell);
    const normalizeUrl = url => {
        try { return new URL(url, doc.baseURI).href; } catch { return url; }
    };
    let currentUrl, pendingResult, catalogDocs = [], catalogGeneration = 0, navigationGeneration = 0;
    const indexed = new Map(), failed = new Set(), inFlight = new Set();
    let activeUi, destroyed = false, currentReady = false;
    const requests = new Set();
    const catalogLabel = shell.querySelector('.api-search-catalog');
    const catalogText = shell.querySelector('.api-search-catalog-text');
    const retry = shell.querySelector('.api-search-retry');
    function catalogEntries() {
        return catalogDocs.flatMap(item => indexed.get(item.key) || []);
    }
    function showCatalogStatus() {
        if (catalogDocs.length < 2) return;
        const count = catalogDocs.filter(item => indexed.has(item.key)).length;
        const missing = failed.size;
        catalogLabel.hidden = false;
        catalogLabel.dataset.error = missing ? 'true' : 'false';
        catalogText.textContent = missing
            ? `${count}/${catalogDocs.length} APIs indexed · ${missing} unavailable`
            : count === catalogDocs.length ? `Search all ${count} APIs`
                : `Searching all APIs · ${count}/${catalogDocs.length} indexed`;
        retry.hidden = !missing;
    }
    const navigation = search.create(doc, { options: searchOptions, onNavigate(entry, options) {
        const sameDocument = normalizeUrl(entry.specUrl) === currentUrl;
        if (!entry.specUrl || (sameDocument && currentReady)) return false;
        pendingResult = { entry, options };
        const selector = [...doc.querySelectorAll('select')].find(node =>
            [...node.options].some(option => normalizeUrl(option.value) === normalizeUrl(entry.specUrl)));
        if (selector && !sameDocument) {
            selector.value = [...selector.options].find(option =>
                normalizeUrl(option.value) === normalizeUrl(entry.specUrl)).value;
            selector.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
            return true;
        }
        const actions = activeUi?.getSystem().specActions;
        if (!actions?.updateUrl || !actions?.download) {
            pendingResult = null;
            return false;
        }
        actions.updateUrl(entry.specUrl);
        actions.download(entry.specUrl);
        return true;
    } });
    const chat = ai ? assistant.create(doc, navigation.navigate, ai) : null;
    function configureCatalog(ui) {
        const configured = specifications || ui.getSystem?.().getConfigs?.().urls;
        const list = Array.isArray(configured) ? configured.filter(item =>
            item && typeof item.name === 'string' && typeof item.url === 'string') : [];
        const next = list.map(item => ({ ...item, key: normalizeUrl(item.url) }));
        if (next.length === catalogDocs.length && next.every((item, i) =>
            item.key === catalogDocs[i].key && item.name === catalogDocs[i].name)) return;
        catalogGeneration++;
        for (const request of requests) request.abort();
        catalogDocs = next;
        indexed.clear();
        failed.clear();
        inFlight.clear();
        catalogLabel.hidden = true;
        shell.querySelector('.api-spec-current').hidden = !(showSpecificationName || next.length > 1);
    }
    function refreshSearch() {
        if (catalogDocs.length) navigation.setIndex(catalogEntries());
        showCatalogStatus();
    }
    function indexDocument(item, spec) {
        indexed.set(item.key, search.buildIndex(spec, searchOptions).map(entry => ({ ...entry,
            specUrl: item.url, specName: item.name })));
        failed.delete(item.key);
        refreshSearch();
    }
    function loadCatalog(ui) {
        if (catalogDocs.length < 2) return;
        const generation = catalogGeneration;
        const queue = catalogDocs.filter(item => !indexed.has(item.key) && !failed.has(item.key) && !inFlight.has(item.key));
        // Reserve the entire queue so repeated attach calls cannot duplicate queued work.
        for (const item of queue) inFlight.add(item.key);
        const workers = Math.min(4, queue.length);
        const worker = async () => {
            while (queue.length && generation === catalogGeneration && !destroyed) {
                const item = queue.shift();
                const controller = new doc.defaultView.AbortController();
                requests.add(controller);
                const timeout = setTimeout(() => controller.abort(), catalogTimeoutMs);
                try {
                    const system = ui.getSystem();
                    const config = system.getConfigs();
                    const response = await abortable(system.fn.fetch({ url: item.url,
                        requestInterceptor: config.requestInterceptor,
                        responseInterceptor: config.responseInterceptor,
                        credentials: config.withCredentials ? 'include' : 'same-origin',
                        signal: controller.signal }), controller.signal);
                    if (response.status >= 400 || typeof response.text !== 'string') {
                        throw new Error('Could not load OpenAPI document');
                    }
                    const parsed = yaml.load(response.text, { schema: yaml.JSON_SCHEMA });
                    if (!validSpec(parsed)) throw new Error('Invalid OpenAPI document');
                    if (generation === catalogGeneration && !indexed.has(item.key)) indexDocument(item, parsed);
                } catch {
                    if (generation === catalogGeneration && !indexed.has(item.key)) {
                        failed.add(item.key);
                        showCatalogStatus();
                    }
                } finally {
                    clearTimeout(timeout);
                    requests.delete(controller);
                    if (generation === catalogGeneration) inFlight.delete(item.key);
                }
            }
        };
        for (let i = 0; i < workers; i++) void worker();
    }
    retry.addEventListener('click', () => {
        failed.clear();
        showCatalogStatus();
        if (activeUi) loadCatalog(activeUi);
    });
    let loadingTimer;
    function loading() {
        if (destroyed) return;
        currentReady = false;
        navigationGeneration++;
        clearTimeout(loadingTimer);
        navigation.reset();
        chat?.reset();
        const label = shell.querySelector('.api-spec-current');
        delete label.dataset.error;
        if (!label.hidden) label.textContent = 'Loading specification…';
        const scope = shell.querySelector('.api-assistant-scope');
        if (scope) scope.textContent = 'Loading API…';
        loadingTimer = setTimeout(() => {
            if (!shell.querySelector('#api-search-input').disabled) return;
            const label = shell.querySelector('.api-spec-current');
            label.hidden = false;
            label.textContent = 'Still waiting for the specification. Check its URL or select another.';
        }, 15000);
    }
    return {
        plugin(system) {
            const base = search.plugin(system);
            return { ...base, statePlugins: {
                spec: { wrapActions: {
                    updateUrl: original => (...args) => { loading(); return original(...args); },
                    updateSpec: original => (...args) => { loading(); return original(...args); }
                } }
            } };
        },
        attach(ui) {
            if (destroyed) return false;
            clearTimeout(loadingTimer);
            activeUi = ui;
            configureCatalog(ui);
            try {
                const spec = ui.specSelectors.specJson().toJS();
                if (!validSpec(spec)) {
                    throw new Error('Invalid OpenAPI document');
                }
                currentUrl = normalizeUrl(ui.getSystem?.().specSelectors?.url?.() || '');
                currentReady = true;
                navigation.attach(ui);
                const current = catalogDocs.find(item => item.key === currentUrl);
                if (current) indexDocument(current, spec);
                else if (catalogDocs.length) refreshSearch();
                loadCatalog(ui);
                chat?.attach(ui);
                if (!shell.querySelector('.api-spec-current').hidden) {
                    const label = shell.querySelector('.api-spec-current');
                    delete label.dataset.error;
                    label.textContent = spec.info.title || 'Untitled specification';
                }
                const scope = shell.querySelector('.api-assistant-scope');
                if (scope) scope.textContent = `Current API: ${spec.info.title || 'Untitled specification'}`;
                if (pendingResult) {
                    const pending = pendingResult;
                    pendingResult = null;
                    if (normalizeUrl(pending.entry.specUrl) === currentUrl) {
                        const generation = navigationGeneration;
                        doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(() => {
                            if (generation === navigationGeneration &&
                                normalizeUrl(pending.entry.specUrl) === currentUrl) {
                                navigation.navigate(pending.entry, pending.options);
                            }
                        }));
                    }
                }
                return true;
            } catch {
                currentReady = false;
                currentUrl = normalizeUrl(ui.getSystem?.().specSelectors?.url?.() || '');
                pendingResult = null;
                navigation.reset();
                if (catalogDocs.length && indexed.size) refreshSearch();
                if (catalogDocs.some(item => item.key === currentUrl)) failed.add(currentUrl);
                showCatalogStatus();
                loadCatalog(ui);
                shell.querySelector('#api-search-input').placeholder = indexed.size
                    ? 'Search available APIs…' : 'Could not load specification';
                chat?.fail('Could not load the selected specification.');
                const scope = shell.querySelector('.api-assistant-scope');
                if (scope) scope.textContent = 'Current API unavailable';
                const label = shell.querySelector('.api-spec-current');
                label.hidden = false;
                label.dataset.error = 'true';
                label.textContent = 'Could not load this specification. Check the Swagger UI error or select another.';
                return false;
            }
        },
        navigate: navigation.navigate,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            catalogGeneration++;
            navigationGeneration++;
            clearTimeout(loadingTimer);
            for (const request of requests) request.abort();
            indexed.clear(); failed.clear(); inFlight.clear();
            pendingResult = null; activeUi = undefined;
            navigation.destroy(); chat?.destroy(); shell.remove();
        },
        element: shell
    };
}

module.exports = { createSwaggerSearch };
