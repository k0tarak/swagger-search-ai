(function (root) {
    'use strict';
    const marked = typeof module !== 'undefined' && module.exports
        ? require('marked') : root.marked;
    const qualified = entry => entry.kind === 'field' ? `${entry.model}.${entry.name}` : entry.name;

    function createResolver(entries, sources) {
        const names = new Map();
        function add(name, entry) {
            if (!names.has(name)) names.set(name, []);
            const list = names.get(name);
            if (!list.includes(entry)) list.push(entry);
        }
        entries.forEach(entry => {
            add(entry.name, entry); add(qualified(entry), entry);
            if (entry.kind === 'field') add(entry.name.split('.').pop(), entry);
        });
        const sourceMap = new Map(sources.map(source => [source.sourceId, source]));
        return (name, context = '') => {
            if (sourceMap.has(name)) return [sourceMap.get(name)];
            let found = names.get(name) || [];
            const explicit = found.filter(entry => qualified(entry) === name);
            if (explicit.length) found = explicit;
            if (found.length <= 1) return found;
            // Prefer a model explicitly named beside an ambiguous field.
            const tokens = new Set(context.match(/[A-Za-z_][\w.]*/g) || []);
            const local = found.filter(entry => entry.model && tokens.has(entry.model));
            if (local.length) return local;
            const citations = [...context.matchAll(/\[(S\d+)\]/g)].map(match => sourceMap.get(match[1])).filter(Boolean);
            const relevant = citations.length ? citations : sources;
            const models = new Set(relevant.flatMap(source => (source.schemaNames || '').split(' ')));
            const scoped = found.filter(entry => entry.model ? models.has(entry.model) : relevant.some(source => source.name === entry.name));
            return scoped.length ? scoped : found;
        };
    }

    function render(container, markdown, resolve, makeReference) {
        const doc = container.ownerDocument;
        const element = (tag, text) => {
            const node = doc.createElement(tag);
            if (text !== undefined) node.textContent = text;
            return node;
        };
        function references(parent, text, context) {
            // Source markers guide model selection but stay hidden from readers.
            text = text.replace(/[ \t]*\[S\d+(?:\s*[,;]\s*S\d+)*\]/g, '');
            const pattern = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
            let start = 0;
            for (const match of text.matchAll(pattern)) {
                parent.append(doc.createTextNode(text.slice(start, match.index)));
                const candidates = resolve(match[0], context);
                parent.append(candidates.length ? makeReference(match[0], candidates) : doc.createTextNode(match[0]));
                start = match.index + match[0].length;
            }
            parent.append(doc.createTextNode(text.slice(start)));
        }
        function inline(parent, tokens, context) {
            for (const token of tokens || []) {
                let node;
                switch (token.type) {
                case 'text':
                    if (token.tokens) inline(parent, token.tokens, context);
                    else references(parent, token.text, context);
                    break;
                case 'codespan':
                    node = element('code'); references(node, token.text, context); parent.append(node); break;
                case 'strong': case 'em': case 'del':
                    node = element(token.type); inline(node, token.tokens, context); parent.append(node); break;
                case 'link': {
                    if (/^S\d+(?:\s*[,;]\s*S\d+)*$/.test(token.text)) break;
                    const candidates = resolve(token.text, context) || [];
                    // Never use model-provided URLs for navigation.
                    if (candidates.length) parent.append(makeReference(token.text, candidates));
                    else inline(parent, token.tokens, context);
                    break;
                }
                case 'br': parent.append(element('br')); break;
                case 'image': parent.append(doc.createTextNode(token.text || '')); break;
                default: parent.append(doc.createTextNode(token.text || token.raw || '')); break;
                }
            }
        }
        function blocks(parent, tokens) {
            for (const token of tokens) {
                let node;
                switch (token.type) {
                case 'space': break;
                case 'heading':
                    node = element(`h${Math.min(6, token.depth + 2)}`); inline(node, token.tokens, token.raw); parent.append(node); break;
                case 'paragraph': case 'text':
                    node = element('p'); inline(node, token.tokens || [{ type: 'text', text: token.text }], token.raw); parent.append(node); break;
                case 'list':
                    node = element(token.ordered ? 'ol' : 'ul');
                    if (token.ordered && token.start !== 1) node.start = token.start;
                    for (const item of token.items) {
                        const li = element('li'); blocks(li, item.tokens); node.append(li);
                    }
                    parent.append(node); break;
                case 'blockquote':
                    node = element('blockquote'); blocks(node, token.tokens); parent.append(node); break;
                case 'code':
                    node = element('pre'); node.append(element('code', token.text)); parent.append(node); break;
                case 'table': {
                    const wrapper = element('div'); wrapper.className = 'assistant-table';
                    node = element('table'); const head = element('thead'), body = element('tbody');
                    const row = (cells, tag) => {
                        const tr = element('tr');
                        cells.forEach(cell => { const td = element(tag); inline(td, cell.tokens, cells.map(c => c.text).join(' ')); tr.append(td); });
                        return tr;
                    };
                    head.append(row(token.header, 'th')); token.rows.forEach(cells => body.append(row(cells, 'td')));
                    node.append(head, body); wrapper.append(node); parent.append(wrapper); break;
                }
                case 'hr': parent.append(element('hr')); break;
                default: parent.append(element('p', token.text || token.raw || '')); break;
                }
            }
        }
        container.replaceChildren();
        // Render only known Markdown tokens to DOM; HTML stays text.
        blocks(container, marked.lexer(markdown, { gfm: true }));
    }

    function create(doc, navigate) {
        const root = doc.defaultView;
        const events = new root.AbortController();
        const card = doc.createElement('div');
        card.className = 'assistant-reference-card'; card.id = 'assistant-reference-card';
        card.hidden = true; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Documentation preview');
        doc.body.append(card);
        let anchor, hideTimer, pinned = false, restoringFocus = false;
        function restoreFocus(target) {
            restoringFocus = true; target?.focus({ preventScroll: true }); restoringFocus = false;
        }
        function close() {
            clearTimeout(hideTimer); card.hidden = true; pinned = false; anchor?.setAttribute('aria-expanded', 'false'); anchor = null;
        }
        function jump(entry) {
            close(); navigate(entry, { source: 'assistant' });
        }
        function position() {
            if (!anchor || card.hidden) return;
            const bounds = anchor.getBoundingClientRect();
            card.style.left = `${Math.max(8, Math.min(bounds.left, root.innerWidth - card.offsetWidth - 8))}px`;
            const below = bounds.bottom + 8;
            const top = below + card.offsetHeight < root.innerHeight - 8 ? below : bounds.top - card.offsetHeight - 8;
            card.style.top = `${Math.max(8, top)}px`;
        }
        function open(button, entries) {
            clearTimeout(hideTimer);
            if (anchor === button && !card.hidden) return;
            close(); anchor = button; button.setAttribute('aria-expanded', 'true');
            card.replaceChildren();
            const title = doc.createElement('div'); title.className = 'assistant-reference-title';
            title.textContent = entries.length > 1 ? `Choose a contract · ${entries.length}` : 'From the API documentation';
            const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.className = 'assistant-reference-close';
            dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Close preview');
            dismiss.addEventListener('click', () => { close(); restoreFocus(button); }); title.append(dismiss); card.append(title);
            for (const entry of entries) {
                const option = doc.createElement('button'); option.type = 'button'; option.className = 'assistant-reference-option';
                const name = doc.createElement('strong'); name.textContent = qualified(entry);
                const meta = doc.createElement('span'); meta.className = 'assistant-reference-meta';
                meta.textContent = entry.kind === 'operation' ? `${entry.method.toUpperCase()} ${entry.path}`
                    : entry.kind === 'field' ? `${entry.type || 'Field'}${entry.required ? ' · required' : ''}` : 'DTO';
                const description = doc.createElement('span'); description.className = 'assistant-reference-description';
                description.textContent = entry.description || entry.summary || 'No OpenAPI description available.';
                const hint = doc.createElement('span'); hint.className = 'assistant-reference-hint'; hint.textContent = 'Open in Swagger ↗';
                option.append(name, meta, description, hint);
                option.addEventListener('click', () => jump(entry)); card.append(option);
            }
            card.hidden = false; position();
        }
        function scheduleClose() { if (pinned) return; clearTimeout(hideTimer); hideTimer = setTimeout(close, 180); }
        card.addEventListener('pointerenter', () => clearTimeout(hideTimer));
        card.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse' && !card.contains(doc.activeElement)) scheduleClose(); });
        card.addEventListener('focusin', () => clearTimeout(hideTimer));
        card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget) && event.relatedTarget !== anchor) close(); });
        doc.addEventListener('pointerdown', event => { if (!card.contains(event.target) && !anchor?.contains(event.target)) close(); }, { signal: events.signal });
        doc.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || card.hidden) return;
            const from = anchor; close(); restoreFocus(from); event.preventDefault();
        }, { signal: events.signal });
        root.addEventListener('resize', () => { if (pinned) position(); else close(); }, { signal: events.signal });
        root.addEventListener('scroll', event => { if (!card.contains(event.target)) close(); }, { capture: true, signal: events.signal });
        function reference(text, entries) {
            const button = doc.createElement('button'); button.type = 'button'; button.className = 'assistant-reference';
            button.textContent = text; button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-controls', card.id); button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-label', `${text}: ${entries.length > 1 ? 'choose a contract' : 'open in Swagger'}`);
            let pointerType;
            button.addEventListener('pointerdown', event => { pointerType = event.pointerType; });
            button.addEventListener('pointercancel', () => { pointerType = null; });
            button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') open(button, entries); });
            button.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') scheduleClose(); });
            button.addEventListener('focus', () => { if (!restoringFocus && pointerType !== 'touch' && pointerType !== 'pen') open(button, entries); });
            button.addEventListener('blur', event => { if (!card.contains(event.relatedTarget)) scheduleClose(); });
            button.addEventListener('keydown', event => {
                if (event.key === 'ArrowDown') { event.preventDefault(); open(button, entries); card.querySelector('.assistant-reference-option')?.focus(); }
            });
            button.addEventListener('click', event => {
                const touch = ['touch', 'pen'].includes(event.pointerType || pointerType);
                pointerType = null;
                if (touch) { open(button, entries); pinned = true; return; }
                if (entries.length === 1) jump(entries[0]);
                else { open(button, entries); card.querySelector('.assistant-reference-option')?.focus(); }
            });
            return button;
        }
        return { reference, clear() { close(); },
            destroy() { close(); events.abort(); card.remove(); },
            render(container, text, entries, sources) { close(); render(container, text, createResolver(entries, sources), reference); } };
    }
    const api = { createResolver, render, create };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SwaggerAssistantRichText = api;
})(typeof window !== 'undefined' ? window : globalThis);
