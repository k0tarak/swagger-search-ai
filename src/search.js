(function (root) {
    'use strict';

    const { methods, resolve, dereference, parameters: operationParameters, assertSpec } = require('./openapi.js');
    const normalize = value => String(value ?? '').toLowerCase();
    const plainText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const stopWords = new Set('a an and are as at be by can could do does for from how i in into is it me my of on please that the their these this those to us was were what where which who why will with would you your api endpoint operation method route'.split(' '));
    const actionGroups = require('./action-words.js').map(group => new Set(group.split(' ')));
    const searchMetadata = new WeakMap();
    const indexOptions = new WeakMap();
    function stem(word) {
        if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + 'y';
        if (word.length > 4 && /(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
        if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
        return word;
    }
    function words(value, options = {}, splitOnly = false) {
        const input = String(value || '').normalize('NFKD').replace(/\p{M}/gu, '');
        const split = input.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/([a-z\d])([A-Z])/g, '$1 $2');
        const ignored = (options.stopWords || []).map(word => word.toLowerCase());
        return [...new Set([...(splitOnly ? [] : input.match(/[\p{L}\p{N}]+/gu) || []),
            ...(split.match(/[\p{L}\p{N}]+/gu) || [])]
            .map(word => word.toLowerCase()).filter(word => !stopWords.has(word) && !ignored.includes(word))
            .map(lower => {
                const result = options.normalizeTerm ? options.normalizeTerm(lower) : stem(lower);
                if (typeof result !== 'string' || !/^[\p{L}\p{N}_]+$/u.test(result)) {
                    throw new TypeError('normalizeTerm must return one nonempty word');
                }
                return result;
            }))];
    }
    function validateOptions(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('search must be an options object');
        if (options.normalizeTerm !== undefined && typeof options.normalizeTerm !== 'function') throw new TypeError('normalizeTerm must be a function');
        if (options.fuzzy !== undefined && typeof options.fuzzy !== 'boolean') throw new TypeError('fuzzy must be a boolean');
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
            throw new TypeError('limit must be an integer between 1 and 200');
        }
        for (const name of ['synonyms', 'stopWords']) {
            if (options[name] !== undefined && (!Array.isArray(options[name]) || options[name].some(value =>
                typeof value !== 'string' || !/[\p{L}\p{N}]/u.test(value)))) throw new TypeError(`${name} must be an array of words`);
        }
        return options;
    }
    function enumText(schema) {
        return [schema?.enum, schema?.['x-enumNames'], schema?.['x-enum-varnames'], schema?.['x-enum-descriptions']]
            .filter(Array.isArray).flat().join(' ');
    }

    function buildIndex(spec, options = {}) {
        assertSpec(spec);
        validateOptions(options);
        const entries = [];
        const add = entry => entries.push({ ...entry, nameText: normalize(entry.name),
            searchText: normalize([entry.name, entry.detail, entry.description].join(' ')) });

        // Index inline and referenced request/response fields under their operation.
        // Follow only contract structure, never examples or external documents.
        function contractText(value) {
            const seen = new Set(), text = [], queue = [value];
            for (let i = 0; i < queue.length; i++) {
                const node = queue[i];
                if (!node || typeof node !== 'object' || seen.has(node)) continue;
                seen.add(node);
                text.push(node.name, node.title, node.description, node.format, enumText(node), node.const);
                const target = resolve(spec, node.$ref);
                if (target) { text.push(target.path.at(-1)); queue.push(target.node); }
                for (const key of ['properties', 'content', 'responses', 'headers']) {
                    for (const [name, child] of Object.entries(node[key] || {})) { text.push(name); queue.push(child); }
                }
                for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'parameters']) queue.push(...(node[key] || []));
                for (const key of ['items', 'additionalProperties', 'schema', 'requestBody']) queue.push(node[key]);
            }
            return plainText(text.filter(value => value !== undefined).join(' '));
        }
        for (const [path, rawItem] of Object.entries(spec.paths || {})) {
            const item = dereference(spec, rawItem);
            if (!item || typeof item !== 'object') continue;
            for (const [method, operation] of Object.entries(item)) {
                if (!methods.has(method) || !operation || typeof operation !== 'object') continue;
                const parameters = operationParameters(spec, item, operation);
                add({ kind: 'operation', name: operation.operationId || `${method.toUpperCase()} ${path}`,
                    path, method, operationId: operation.operationId,
                    tag: (operation.tags || [])[0] || 'default',
                    detail: `${method.toUpperCase()} ${path} ${(operation.tags || []).join(' ')}`,
                    description: plainText([operation.summary, operation.description,
                        ...parameters.map(parameter => [parameter.name, parameter.description].filter(Boolean).join(': '))]
                        .filter(Boolean).join(' — ')),
                    parametersText: parameters.map(parameter => [parameter.name, parameter.in, enumText(parameter.schema)].join(' ')).join(' '),
                    keywords: contractText({ ...operation, parameters }) });
            }
        }

        const base = spec.components?.schemas ? ['components', 'schemas'] : ['definitions'];
        const schemas = spec.components?.schemas || spec.definitions || {};
        function visit(schema, model, path, names, ancestors = new Set()) {
            if (!schema || typeof schema !== 'object' || ancestors.has(schema) || ancestors.size > 40) return;
            ancestors = new Set(ancestors).add(schema);
            // Expand model aliases/inheritance. Nested references stay indexed under
            // their own model, avoiding exponential duplication in shared graphs.
            if (schema.$ref && !names.length) {
                const found = resolve(spec, schema.$ref);
                if (found) visit(found.node, model, path, names, ancestors);
            }
            for (const [name, property] of Object.entries(schema.properties || {})) {
                if (property === null || property === undefined) continue;
                const resolved = dereference(spec, property);
                const fieldPath = [...path, 'properties', name];
                const fieldNames = [...names, name];
                add({ kind: 'field', name: fieldNames.join('.'), model, specPath: fieldPath,
                    detail: model, description: plainText([resolved.description, enumText(resolved)].filter(Boolean).join(' ')),
                    type: property.type === 'array' ? `${property.items?.type || property.items?.$ref?.split('/').pop() || 'object'}[]`
                        : property.type || property.$ref?.split('/').pop() || 'object',
                    required: (schema.required || []).includes(name) });
                visit(property, model, fieldPath, fieldNames, ancestors);
            }
            for (const key of ['allOf', 'anyOf', 'oneOf']) {
                // Swagger merges allOf before display, so visible field paths omit that segment.
                (schema[key] || []).forEach((child, index) => visit(child, model, key === 'allOf' ? path : [...path, key, index], names, ancestors));
            }
            if (schema.items) visit(schema.items, model, [...path, 'items'], names, ancestors);
            if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                visit(schema.additionalProperties, model, [...path, 'additionalProperties'], names, ancestors);
            }
        }
        for (const [model, schema] of Object.entries(schemas)) {
            if (schema === null || schema === undefined) continue;
            const specPath = [...base, model];
            add({ kind: 'model', name: model, model, specPath,
                detail: schema.title || '', description: plainText([schema.description, enumText(schema)]
                    .filter(Boolean).join(' ')) });
            visit(schema, model, specPath, []);
        }
        indexOptions.set(entries, options);
        for (const entry of entries) metadata(entry, options);
        return entries;
    }

    function metadata(entry, options = {}) {
        let result = searchMetadata.get(entry);
        if (!result || result.options !== options || result.sourceName !== entry.specName) {
            result = {
                options, sourceName: entry.specName,
                name: words(entry.name, options), detail: words(entry.detail, options), description: words(entry.description, options),
                keywords: words(entry.keywords, options), source: words(entry.specName, options),
                parameters: words(entry.parametersText, options)
            };
            searchMetadata.set(entry, result);
        }
        return result;
    }
    function near(a, b) {
        if (Math.abs(a.length - b.length) > 1) return false;
        let left = 0, right = 0, edits = 0;
        while (left < a.length && right < b.length) {
            if (a[left] === b[right]) { left++; right++; continue; }
            if (++edits > 1) return false;
            if (a[left + 1] === b[right] && a[left] === b[right + 1]) { left += 2; right += 2; }
            else if (a.length > b.length) left++;
            else if (b.length > a.length) right++;
            else { left++; right++; }
        }
        return edits + (a.length - left) + (b.length - right) <= 1;
    }
    function tokenScore(queryWord, candidates, weight, fuzzy) {
        if (candidates.includes(queryWord)) return weight;
        if (queryWord.length >= 3 && candidates.some(word => word.startsWith(queryWord))) return weight * 0.7;
        if (queryWord.length >= 4 && actionGroups.some(group => group.has(queryWord) &&
            candidates.some(word => group.has(word)))) return weight * 0.35;
        if (fuzzy && queryWord.length >= 4 && candidates.some(word => near(queryWord, word))) return weight * 0.25;
        return 0;
    }
    function search(index, query, limit) {
        const options = indexOptions.get(index) || {};
        limit ??= options.limit ?? 40;
        if (!Number.isInteger(limit) || limit < 0) throw new TypeError('limit must be a nonnegative integer');
        const text = normalize(query).trim();
        const queryWords = words(query, options, true);
        const synonyms = (options.synonyms || []).map(group => words(group, options, true));
        if (!queryWords.length) return { total: 0, entries: [] };
        function collect(fuzzy) {
            const matches = [];
            for (const entry of index) {
                const fields = metadata(entry, options);
                let score = 0, complete = true;
                for (const word of queryWords) {
                    const variants = new Set([word, ...synonyms.filter(group => group.includes(word)).flat()]);
                    const points = Math.max(...[...variants].map(variant => (variant === word ? 1 : 0.8) * Math.max(
                        tokenScore(variant, fields.name, 8, fuzzy), tokenScore(variant, fields.detail, 3, fuzzy),
                        tokenScore(variant, fields.description, 2, fuzzy), tokenScore(variant, fields.keywords, 1.5, fuzzy),
                        tokenScore(variant, fields.parameters, 3.5, fuzzy),
                        tokenScore(variant, fields.source, 1, fuzzy))));
                    if (!points) { complete = false; break; }
                    score += points;
                }
                if (!complete) continue;
                if (entry.nameText === text) score += 20;
                else if (entry.nameText.startsWith(text)) score += 8;
                else if (fields.name.length === queryWords.length && queryWords.every(word => fields.name.includes(word) ||
                    synonyms.some(group => group.includes(word) && group.some(term => fields.name.includes(term))))) score += 6;
                if (entry.kind === 'operation' && queryWords.some(word =>
                    actionGroups.some(group => group.has(word)))) score += 1;
                if (entry.kind === 'field') score -= entry.name.split('.').length * 0.01;
                matches.push({ entry, score });
            }
            return matches;
        }
        const matches = collect(false);
        if (!matches.length && options.fuzzy !== false) matches.push(...collect(true));
        const kindOrder = { operation: 0, model: 1, field: 2 };
        matches.sort((a, b) => b.score - a.score || kindOrder[a.entry.kind] - kindOrder[b.entry.kind]
            || a.entry.name.localeCompare(b.entry.name));
        return { total: matches.length, entries: matches.slice(0, limit).map(match => match.entry) };
    }

    function plugin(system) {
        return {
            afterLoad(system) {
                // Swagger Client can mangle file:// when resolving recursive internal references.
                // A single in-memory document needs no base URL for its internal references.
                const localOptions = options => /^file:/i.test(options?.baseDoc || '')
                    ? { ...options, baseDoc: undefined } : options;
                const resolve = system.fn.resolve, resolveSubtree = system.fn.resolveSubtree;
                system.fn.resolve = options => resolve(localOptions(options));
                system.fn.resolveSubtree = (spec, path, options) => resolveSubtree(spec, path, localOptions(options));
            },
            wrapComponents: {
                operation: Original => props => system.React.createElement('div', {
                    'data-search-operation': JSON.stringify(props.specPath.toJS())
                }, system.React.createElement(Original, props)),
                Model: Original => props => system.React.createElement('span', {
                    'data-search-path': JSON.stringify(props.specPath?.toJS())
                }, system.React.createElement(Original, props))
            }
        };
    }

    function create(doc, { onNavigate, options = {} } = {}) {
        const root = doc.defaultView;
        const events = new root.AbortController();
        const input = doc.getElementById('api-search-input');
        const panel = doc.getElementById('api-search-panel');
        const results = doc.getElementById('api-search-results');
        const status = doc.getElementById('api-search-status');
        const clear = doc.getElementById('api-search-clear');
        const notice = doc.getElementById('api-search-notice');
        const host = doc.querySelector('.api-search-control');
        let ui, index = [], shown = [], selected = -1, cancelNavigation = () => {};
        let noticeTimer, highlightTimer;
        // One return button serves both search results and assistant references.
        const back = doc.createElement('button'); back.type = 'button'; back.className = 'api-search-return';
        back.textContent = '↑ Back'; back.hidden = true;
        doc.body.append(back);
        let returnSource;
        back.addEventListener('click', () => {
            cancelNavigation(); close(); back.hidden = true;
            if (returnSource === 'assistant') {
                const target = doc.getElementById('assistant-answer');
                doc.querySelector('.api-assistant').open = true;
                target.scrollIntoView({ block: 'center', behavior: 'instant' });
                target.focus({ preventScroll: true });
                return;
            }
            root.scrollTo({ top: 0, behavior: 'instant' });
            const header = doc.querySelector('.api-search');
            header.setAttribute('tabindex', '-1'); header.focus({ preventScroll: true });
        });
        doc.getElementById('api-search-shortcut').textContent = /Mac|iPhone|iPad/.test(root.navigator.platform) ? '⌘ K' : 'Ctrl K';

        function close() {
            panel.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }

        function select(position) {
            selected = position;
            [...results.querySelectorAll('[role="option"]')].forEach((option, i) => {
                option.setAttribute('aria-selected', String(i === selected));
                if (i === selected) {
                    input.setAttribute('aria-activedescendant', option.id);
                    option.scrollIntoView({ block: 'nearest' });
                }
            });
        }

        function highlight(container, text) {
            const words = normalize(input.value).trim().split(/\s+/).filter(Boolean);
            const lower = normalize(text);
            let cursor = 0;
            while (cursor < text.length) {
                let start = text.length, length = 0;
                for (const word of words) {
                    const found = lower.indexOf(word, cursor);
                    if (found !== -1 && (found < start || (found === start && word.length > length))) {
                        start = found;
                        length = word.length;
                    }
                }
                container.append(doc.createTextNode(text.slice(cursor, start)));
                if (!length) break;
                const mark = doc.createElement('mark');
                mark.textContent = text.slice(start, start + length);
                container.append(mark);
                cursor = start + length;
            }
        }

        function snippet(text) {
            const lower = normalize(text);
            const positions = normalize(input.value).trim().split(/\s+/).map(word => lower.indexOf(word)).filter(pos => pos >= 0);
            const start = positions.length ? Math.max(0, Math.min(...positions) - 45) : 0;
            return (start ? '…' : '') + text.slice(start, start + 160) + (text.length > start + 160 ? '…' : '');
        }

        function render() {
            const match = search(index, input.value);
            clear.hidden = !input.value;
            results.replaceChildren();
            selected = -1;
            input.removeAttribute('aria-activedescendant');
            shown = [];
            if (!input.value.trim()) {
                close();
                return;
            }
            panel.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            status.textContent = !match.total ? 'No results. Try a different name or description.'
                : `Found: ${match.total}` + (match.total > match.entries.length ? ` · showing the first ${match.entries.length}; refine your query` : '');
            const groups = [['Operations', ['operation']], ['Models and fields', ['model', 'field']]];
            groups.sort((a, b) => match.entries.findIndex(entry => a[1].includes(entry.kind)) -
                match.entries.findIndex(entry => b[1].includes(entry.kind)));
            for (const [label, kinds] of groups) {
                const entries = match.entries.filter(entry => kinds.includes(entry.kind));
                if (!entries.length) continue;
                const group = doc.createElement('div');
                group.setAttribute('role', 'group');
                group.setAttribute('aria-label', label);
                const heading = doc.createElement('div');
                heading.className = 'api-search-group';
                heading.textContent = label;
                heading.setAttribute('aria-hidden', 'true');
                group.append(heading);
                for (const entry of entries) {
                    const position = shown.push(entry) - 1;
                    const option = doc.createElement('div');
                    option.className = 'api-search-option';
                    option.id = `api-search-option-${position}`;
                    option.setAttribute('role', 'option');
                    option.setAttribute('aria-selected', 'false');
                    const title = doc.createElement('div');
                    title.className = 'api-search-option-title';
                    const badge = doc.createElement('span');
                    badge.className = `api-search-badge ${entry.kind}`;
                    badge.textContent = entry.kind === 'operation' ? entry.method.toUpperCase() : entry.kind === 'model' ? 'MODEL' : 'FIELD';
                    const name = doc.createElement('span');
                    highlight(name, entry.name);
                    title.append(badge, name);
                    if (entry.specName) {
                        const source = doc.createElement('span');
                        source.className = 'api-search-source';
                        source.textContent = `API: ${entry.specName}`;
                        title.append(source);
                    }
                    option.append(title);
                    for (const text of [entry.detail, snippet(entry.description)]) {
                        if (!text) continue;
                        const detail = doc.createElement('div');
                        detail.className = 'api-search-option-detail';
                        highlight(detail, text);
                        option.append(detail);
                    }
                    option.addEventListener('pointerdown', event => event.preventDefault());
                    option.addEventListener('click', () => navigate(entry));
                    group.append(option);
                }
                results.append(group);
            }
            results.scrollTop = 0;
            if (shown.length) select(0);
        }

        function notify(text) {
            clearTimeout(noticeTimer);
            notice.textContent = text;
            notice.hidden = false;
            noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
        }

        function navigate(entry, options = {}) {
            if (!ui) return;
            if (onNavigate?.(entry, options)) {
                close();
                return;
            }
            returnSource = options.source;
            back.textContent = returnSource === 'assistant' ? '↑ Back to AI answer' : '↑ Back to search';
            back.hidden = false;
            close();
            cancelNavigation();
            notice.hidden = true;
            doc.querySelectorAll('.api-search-target').forEach(node => node.classList.remove('api-search-target'));
            const system = ui.getSystem();
            const actions = system.layoutActions;
            let target, scrollFrame;
            if (entry.kind === 'operation') {
                const operationId = entry.operationId || system.fn.opId(system.specSelectors.specJson().getIn(['paths', entry.path, entry.method]), entry.path, entry.method);
                const key = ['operations', entry.tag, operationId];
                actions.show(['operations-tag', entry.tag], true);
                actions.show(key, true);
                actions.scrollTo(key);
                target = () => [...doc.querySelectorAll('[data-search-operation]')]
                    .find(node => node.getAttribute('data-search-operation') === JSON.stringify(['paths', entry.path, entry.method]))
                    ?.querySelector('.opblock-summary');
                scrollFrame = root.requestAnimationFrame(() => actions.scrollToVirtualizedOperation?.(key));
            } else {
                const base = entry.specPath.slice(0, entry.specPath[0] === 'components' ? 2 : 1);
                const modelPath = [...base, entry.model];
                actions.show(base, true);
                system.specActions.requestResolvedSubtree(modelPath);
                for (let length = modelPath.length; length <= entry.specPath.length; length++) {
                    actions.show(entry.specPath.slice(0, length), true);
                }
                scrollFrame = root.requestAnimationFrame(() => actions.scrollToVirtualizedSchema?.(entry.model));
                target = () => {
                    const model = doc.getElementById(`model-${entry.model}`);
                    if (!model) return null;
                    if (entry.kind === 'model') return model;
                    const path = JSON.stringify(entry.specPath);
                    const field = [...model.querySelectorAll('[data-search-path]')].find(node => node.getAttribute('data-search-path') === path);
                    return field?.closest('.property-row');
                };
            }
            // Wait for the virtualizer to measure the expanded model before final scrolling.
            let frame, previousElement, previousTop, stableFrames = 0;
            const timeout = setTimeout(() => {
                cancelNavigation();
                notify('Could not navigate to the result. Try selecting it again.');
            }, 5000);
            cancelNavigation = () => { root.cancelAnimationFrame(frame); root.cancelAnimationFrame(scrollFrame); clearTimeout(timeout); };
            function finish() {
                const element = target();
                const top = element?.getBoundingClientRect().top;
                stableFrames = element && element === previousElement && top === previousTop ? stableFrames + 1 : 0;
                previousElement = element;
                previousTop = top;
                if (!element || !element.getClientRects().length || stableFrames < 2) {
                    frame = root.requestAnimationFrame(finish);
                    return;
                }
                cancelNavigation();
                element.scrollIntoView({ block: 'center', behavior: 'instant' });
                element.classList.add('api-search-target');
                element.setAttribute('tabindex', '-1');
                element.focus({ preventScroll: true });
                clearTimeout(highlightTimer);
                highlightTimer = setTimeout(() => element.classList.remove('api-search-target'), 4000);
            }
            frame = root.requestAnimationFrame(finish);
        }

        input.addEventListener('input', render);
        input.addEventListener('focus', () => { if (input.value.trim()) render(); });
        input.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Escape') { close(); event.preventDefault(); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (panel.hidden) render();
                else if (shown.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
            }
            if (event.key === 'Enter' && !panel.hidden && shown[selected]) {
                event.preventDefault();
                navigate(shown[selected]);
            }
        });
        clear.addEventListener('click', () => { input.value = ''; render(); input.focus(); });
        doc.addEventListener('pointerdown', event => { if (!host.contains(event.target)) close(); }, { signal: events.signal });
        host.addEventListener('focusout', event => { if (!host.contains(event.relatedTarget)) close(); });
        doc.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !input.disabled) {
                event.preventDefault();
                input.focus();
                input.select();
            }
        }, { signal: events.signal });
        function reset() {
            cancelNavigation();
            back.hidden = true;
            index = [];
            shown = [];
            input.disabled = true;
            input.placeholder = 'Loading specification…';
            results.replaceChildren();
            close();
        }
        return {
            navigate,
            reset,
            destroy() {
                reset();
                events.abort();
                clearTimeout(noticeTimer);
                clearTimeout(highlightTimer);
                doc.querySelectorAll('.api-search-target').forEach(node => node.classList.remove('api-search-target'));
                back.remove();
                ui = undefined;
            },
            setIndex(entries) {
                index = entries;
                indexOptions.set(index, options);
                input.disabled = false;
                input.placeholder = 'Operations, models, fields…';
                if (input.value.trim()) render();
            },
            attach(instance) {
                reset();
                ui = instance;
                this.setIndex(buildIndex(ui.specSelectors.specJson().toJS(), options));
            }
        };
    }

    const api = { buildIndex, search, plugin, create, validateOptions };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SwaggerSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
