(function (root) {
    'use strict';
    const MiniSearch = typeof module !== 'undefined' && module.exports
        ? require('minisearch') : root.MiniSearch;
    const { methods, resolve, dereference, parameters, assertSpec } = require('./openapi.js');
    const actionWords = require('./action-words.js');
    const stop = new Set('the a an is how to in of for and with as what which are does do can i my me it this that there from by on at use mean'.split(' '));
    const plain = value => String(value ?? '').replace(/<[^>]*>/g, ' ').trim();
    function normalize(word) {
        word = word.toLowerCase();
        if (/^[a-z]{4,}s$/.test(word) && !/(ss|us|is)$/.test(word)) word = word.slice(0, -1);
        return word;
    }
    function tokenize(value, normalizer = normalize, ignored = stop) {
        const text = String(value);
        const original = text.match(/[\p{L}\p{N}_]+/gu) || [];
        const split = text.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2')
            .replace(/_/g, ' ').match(/[\p{L}\p{N}]+/gu) || [];
        return [...new Set([...original, ...split].filter(word => !ignored.has(word.toLowerCase()))
            .map(word => normalizer(word.toLowerCase())))];
    }
    const phraseWords = (text, normalizer = normalize, ignored = stop) => String(text).replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu)
        ?.filter(word => !ignored.has(word)).map(normalizer) || [];
    function validateVocabulary(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Vocabulary must be an options object');
        if (options.minScoreRatio !== undefined && (typeof options.minScoreRatio !== 'number' ||
            !Number.isFinite(options.minScoreRatio) || options.minScoreRatio < 0 || options.minScoreRatio > 1)) {
            throw new TypeError('minScoreRatio must be a number between 0 and 1');
        }
        for (const name of ['normalizeTerm', 'technicalTermKey']) {
            if (options[name] !== undefined && typeof options[name] !== 'function') {
                throw new TypeError(`${name} must be a function`);
            }
        }
        for (const name of ['stopWords', 'actionTerms']) {
            if (options[name] !== undefined && (!Array.isArray(options[name]) ||
                options[name].some(word => typeof word !== 'string' || !/[\p{L}\p{N}]/u.test(word)))) {
                throw new TypeError(`${name} must be an array of nonempty words`);
            }
        }
        if (options.synonyms !== undefined && (!Array.isArray(options.synonyms) ||
            options.synonyms.some(group => typeof group !== 'string' || !/[\p{L}\p{N}]/u.test(group)))) {
            throw new TypeError('synonyms must be an array of nonempty word groups');
        }
        if (options.aliases !== undefined && (!Array.isArray(options.aliases) || options.aliases.some(entry =>
            !Array.isArray(entry) || entry.length < 2 || entry.length > 3 ||
            entry.some((value, index) => typeof value !== 'string' ||
                (index < 2 && !value.trim()) ||
                ((index < 2 || value.trim()) && value.split('|').some(phrase =>
                    !/[\p{L}\p{N}]/u.test(phrase))))))) {
            throw new TypeError('aliases must contain [query phrases, technical names, related names?] with nonempty alternatives');
        }
    }
    function compileAliases(aliases = [], phrase = phraseWords) { return aliases.flatMap(([names, targets, related = '']) => names.split('|').map(alias => ({
        words: phrase(alias), variants: targets.split('|').map(phrase), related: related ? related.split('|').map(phrase) : []
    }))).sort((a, b) => b.words.length - a.words.length); }
    const defaultActions = 'get fetch search find create add delete remove edit update change send disable enable reset refresh list all work make';
    function queryTerms(question, technicalTerms, phraseRules, vocabulary, tokenizeWords, phrase,
        actionTerms, technicalTermKey) {
        const original = tokenizeWords(question), words = phrase(question), groups = [], consumed = new Set();
        const occupied = new Set();
        for (const rule of phraseRules) {
            for (let i = 0; i <= words.length - rule.words.length; i++) {
                if (!rule.words.every((word, j) => !occupied.has(i + j) && words[i + j] === word)) continue;
                rule.words.forEach((word, j) => { occupied.add(i + j); consumed.add(word); });
                groups.push({ exact: [rule.words], variants: rule.variants, related: rule.related, subject: !rule.words.every(word => actionTerms.has(word)) });
            }
        }
        for (const terms of vocabulary) {
            const exact = original.filter(term => !consumed.has(term) && terms.has(term));
            if (!exact.length) continue;
            groups.push({ exact: exact.map(term => [term]), variants: [...terms].map(term => [term]),
                subject: !exact.every(term => actionTerms.has(term)) });
            exact.forEach(term => consumed.add(term));
        }
        original.filter(term => !consumed.has(term)).forEach(term => {
            groups.push({ exact: [[term]], variants: technicalTerms.get(technicalTermKey(term)) || [],
                subject: !actionTerms.has(term) });
        });
        return { original, groups, expanded: [...new Set(groups.flatMap(group => [...group.exact, ...group.variants, ...(group.related || [])].flat()))] };
    }
    function groupMatch(group, terms) {
        if (group.exact.some(variant => variant.every(term => terms.has(term)))) return 1;
        // Configured aliases have less weight than literal matches.
        if (group.variants.some(variant => variant.every(term => terms.has(term)))) return 0.8;
        if (group.related?.some(variant => variant.every(term => terms.has(term)))) return 0.45;
        // An unfinished technical name should not block subject matching.
        return group.exact.some(variant => variant.every(term => terms.has(term) ||
            (/^[a-z0-9_]{4,}$/.test(term) && [...terms].some(candidate => candidate.startsWith(term))))) ? 0.55 : 0;
    }
    function pointer(parts) { return '#/' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/'); }
    function buildIndex(spec, options = {}) {
        assertSpec(spec);
        validateVocabulary(options);
        const configuredNormalizer = options.normalizeTerm || normalize;
        const normalizer = word => {
            const result = configuredNormalizer(word);
            if (typeof result !== 'string' || !/^[\p{L}\p{N}_]+$/u.test(result)) {
                throw new TypeError('normalizeTerm must return one nonempty word');
            }
            return result;
        };
        const ignored = new Set([...stop, ...(options.stopWords || []).map(word => word.toLowerCase())]);
        const tokenizeWords = value => tokenize(value, normalizer, ignored);
        const phrase = value => phraseWords(value, normalizer, ignored);
        const actionTerms = new Set(tokenizeWords(defaultActions + ' ' + actionWords.join(' ') + ' ' + (options.actionTerms || []).join(' ')));
        const technicalTermKey = term => {
            const result = options.technicalTermKey ? options.technicalTermKey(term) : term;
            if (typeof result !== 'string' || !/^[\p{L}\p{N}_]+$/u.test(result)) throw new TypeError('technicalTermKey must return one nonempty word');
            return result;
        };
        const nodes = new Map(), fragments = new Map(), pending = [], warnings = [];
        function addNode(id, metadata, value) {
            if (nodes.has(id)) return nodes.get(id);
            const node = { id, ...metadata, fragments: [], edges: [], incoming: [] };
            nodes.set(id, node); pending.push({ node, value }); return node;
        }
        function reference(ref) {
            const found = resolve(spec, ref);
            if (!found || found.node === null || !['object', 'boolean'].includes(typeof found.node)) return null;
            const id = pointer(found.path), name = found.path.at(-1);
            return addNode(id, { name, model: name, kind: 'model', specPath: found.path }, found.node);
        }
        for (const [name, value] of Object.entries(spec.components?.schemas || spec.definitions || {})) {
            const path = spec.components?.schemas ? ['components', 'schemas', name] : ['definitions', name];
            addNode(pointer(path), { name, model: name, kind: 'model', specPath: path }, value);
        }
        for (const [path, rawItem] of Object.entries(spec.paths || {})) {
            const item = dereference(spec, rawItem);
            if (!item || typeof item !== 'object') continue;
            for (const [method, operation] of Object.entries(item)) {
                if (!methods.has(method) || !operation || typeof operation !== 'object') continue;
                const id = `${method} ${path}`;
                addNode(id, { kind: 'operation', name: operation.operationId || `${method.toUpperCase()} ${path}`,
                    operationId: operation.operationId, method, path, tag: operation.tags?.[0] || 'default',
                    summary: plain(operation.summary), description: plain(operation.description) },
                { ...operation, parameters: parameters(spec, item, operation),
                    security: operation.security ?? spec.security });
            }
        }
        // Parse each named object once. References remain graph edges, preventing cycles
        // and shared schemas from duplicating operation content.
        for (let next = 0; next < pending.length; next++) {
            const { node, value } = pending[next];
            function visit(value, label, parent, depth = 0, role = '', ancestors = new Set()) {
                if (typeof value === 'boolean') value = { description: value ? 'Any value is allowed.' : 'No value is allowed.' };
                if (!value || typeof value !== 'object' || ancestors.has(value)) return;
                ancestors = new Set(ancestors).add(value);
                if (depth > 40) { warnings.push(`Depth limit reached at ${label}`); return; }
                const attributes = ['type', 'format', 'nullable', 'required', 'default', 'const', 'minimum', 'maximum',
                    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
                    'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'readOnly', 'writeOnly', 'deprecated'];
                const details = attributes.filter(key => value[key] !== undefined).map(key => `${key}: ${JSON.stringify(value[key])}`);
                const text = [label, ...details, plain(value.summary), plain(value.description)].filter(Boolean);
                if (typeof value.additionalProperties === 'boolean') text.push(`additionalProperties: ${value.additionalProperties}`);
                if (Array.isArray(value.security)) {
                    text.push(`Security requirements (alternatives): ${JSON.stringify(value.security)}`);
                    for (const name of new Set(value.security.flatMap(requirement => Object.keys(requirement)))) {
                        const scheme = dereference(spec, (spec.components?.securitySchemes || spec.securityDefinitions || {})[name]);
                        if (scheme) text.push(`Security scheme ${name}: ${JSON.stringify(scheme)}`);
                    }
                }
                if (value.tags?.length) text.push(`Tags: ${value.tags.join(', ')}`);
                const refs = [];
                if (value.$ref) {
                    const target = reference(value.$ref);
                    text.push(`ref: ${value.$ref}`);
                    if (target) refs.push(target.id);
                    else text.push('Reference unresolved; external documents are not loaded.');
                }
                const enumNames = value['x-enumNames'] || value['x-enum-varnames'] || [];
                const descriptions = value['x-enum-descriptions'] || [];
                const enumeration = (value.enum || []).map((item, i) => `${JSON.stringify(item)} ${enumNames[i] || ''} ${plain(descriptions[i])}`.trim());
                if (enumeration.length <= 32) text.push(...enumeration);
                else text.push(`enum: ${enumeration.length} values; matching values appear below.`);
                const id = `${node.id}@${node.fragments.length}`;
                const fragment = { id, owner: node.id, name: label, text: text.join('\n'), refs, parent, role,
                    identifiers: [label, ...(value.tags || []), ...refs.map(ref => nodes.get(ref).name)].join(' '),
                    description: [plain(value.summary), plain(value.description), ...enumeration.slice(0, 32)].join(' ') };
                fragments.set(id, fragment); node.fragments.push(id);
                for (const target of refs) node.edges.push({ target, fragment: id, role });
                if (enumeration.length > 32) enumeration.forEach(line => {
                    const childId = `${node.id}@${node.fragments.length}`;
                    fragments.set(childId, { id: childId, owner: node.id, name: label, text: `${label}: ${line}`,
                        identifiers: label, description: line, refs: [], parent: id, role });
                    node.fragments.push(childId);
                });
                for (const [name, child] of Object.entries(value.properties || {})) visit(child, `${label}.${name}`, id, depth + 1, role, ancestors);
                for (const composition of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) {
                    (value[composition] || []).forEach((child, i) => visit(child, `${label} ${composition}[${i}]`, id, depth + 1, role, ancestors));
                }
                if (value.items !== undefined) visit(value.items, `${label}[]`, id, depth + 1, role, ancestors);
                if (typeof value.additionalProperties === 'object') visit(value.additionalProperties, `${label}.*`, id, depth + 1, role, ancestors);
                if (value.schema !== undefined) visit(value.schema, label, id, depth + 1, role, ancestors);
                for (const [media, content] of Object.entries(value.content || {})) visit(content, `${label} (${media})`, id, depth + 1, role, ancestors);
                if (value.requestBody) visit(value.requestBody, 'Request', id, depth + 1, 'request', ancestors);
                (value.parameters || []).forEach(parameter => visit(parameter, `Parameter ${parameter.in || ''} ${parameter.name || ''}`, id, depth + 1, 'request', ancestors));
                for (const [code, response] of Object.entries(value.responses || {})) visit(response, `Response ${code}`, id, depth + 1, 'response', ancestors);
                for (const [name, header] of Object.entries(value.headers || {})) visit(header, `Header ${name}`, id, depth + 1, role, ancestors);
            }
            visit(value, node.kind === 'operation' ? `${node.method.toUpperCase()} ${node.path}\n${node.name}` : `Schema ${node.name}`, null);
        }
        for (const node of nodes.values()) for (const edge of node.edges) nodes.get(edge.target).incoming.push({ ...edge, owner: node.id });
        const index = new MiniSearch({ fields: ['identifiers', 'description'], tokenize: tokenizeWords,
            searchOptions: { boost: { identifiers: 3, description: 2 } } });
        index.addAll([...fragments.values()]);
        const catalog = new MiniSearch({ fields: ['name', 'description'], tokenize: tokenizeWords,
            searchOptions: { boost: { name: 4, description: 1 } } });
        catalog.addAll([...nodes.values()].map(node => ({ id: node.id, name: node.name,
            description: node.fragments.map(id => fragments.get(id).description).join(' ') })));
        const frequencies = new Map(), technicalTerms = new Map();
        for (const fragment of fragments.values()) {
            fragment.terms = new Set(tokenizeWords(fragment.identifiers + ' ' + fragment.description));
            for (const term of fragment.terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
            for (const identifier of fragment.identifiers.match(/[A-Za-z][A-Za-z0-9]+/g) || []) {
                const words = phrase(identifier);
                for (let start = 0; start < words.length; start++) for (let length = 1; length <= 3 && start + length <= words.length; length++) {
                    const variant = words.slice(start, start + length), key = variant.join('');
                    if (key.length < 5) continue;
                    if (!technicalTerms.has(key)) technicalTerms.set(key, []);
                    const variants = technicalTerms.get(key);
                    if (!variants.some(item => item.join(' ') === variant.join(' ')) && variants.length < 4) variants.push(variant);
                }
            }
        }
        return { index, catalog, nodes, fragments, frequencies, technicalTerms, warnings,
            tokenizeWords, normalizer, phrase, actionTerms, technicalTermKey, minScoreRatio: options.minScoreRatio ?? 0.45,
            phraseRules: compileAliases(options.aliases, phrase),
            vocabulary: [...actionWords, ...(options.synonyms || [])].map(text => new Set(tokenizeWords(text))),
            documents: new Map([...nodes].filter(([, node]) => node.kind === 'operation')) };
    }

    function retrieve(data, question, budget = 24000) {
        if (!Number.isInteger(budget) || budget < 0) throw new TypeError('budget must be a nonnegative integer');
        const tokenize = data.tokenizeWords;
        const query = queryTerms(question, data.technicalTerms, data.phraseRules, data.vocabulary,
            tokenize, data.phrase, data.actionTerms, data.technicalTermKey), scores = new Map();
        if (!query.original.length || budget < 200) return { context: '', sources: [], diagnostics: { candidates: [] } };
        // Keep the literal query separate from synonym-expanded searches.
        const searches = [
            [query.original, { prefix: false, fuzzy: false }, 1.15],
            [query.original, { prefix: term => term.length >= 4, fuzzy: term => term.length >= 6 ? 0.15 : false }, 1],
            [query.expanded, { prefix: false, fuzzy: false }, 0.8]
        ];
        for (const [terms, options, weight] of searches) {
            data.index.search(terms.join(' '), { ...options, tokenize: text => text.split(' ') }).slice(0, 120).forEach((match, rank) => {
                scores.set(match.id, Math.max(scores.get(match.id) || 0, weight / (20 + rank)));
            });
        }
        for (const group of query.groups) {
            for (const variant of group.variants.filter(variant => variant.length > 1)) {
                data.index.search(variant.join(' '), { combineWith: 'AND', prefix: false, fuzzy: false,
                    tokenize: text => text.split(' ') }).slice(0, 40).forEach((match, rank) => {
                    scores.set(match.id, Math.max(scores.get(match.id) || 0, 0.8 / (20 + rank)));
                });
            }
        }
        const groupWeights = query.groups.map(group => {
            const frequency = Math.max(...[...group.exact, ...group.variants].map(variant => Math.min(...variant.map(term => data.frequencies.get(term) || 0))), 1);
            return Math.log(1 + data.fragments.size / frequency);
        });
        const coverage = terms => query.groups.reduce((sum, group, i) => sum + (groupMatch(group, terms) * groupWeights[i]), 0);
        const totalWeight = groupWeights.reduce((a, b) => a + b, 0) || 1;
        const matchesName = name => {
            const terms = tokenize(name);
            return terms.length > 0 && terms.every(term => query.original.includes(term));
        };
        // Catalog search keeps field-heavy schemas from drowning out operation and model names.
        data.catalog.search(query.expanded.join(' '), { tokenize: text => text.split(' ') }).slice(0, 60).forEach((match, rank) => {
            const node = data.nodes.get(match.id);
            const best = [...node.fragments].sort((a, b) => coverage(data.fragments.get(b).terms) - coverage(data.fragments.get(a).terms))[0];
            if (best) scores.set(best, Math.max(scores.get(best) || 0, 1 / (20 + rank)));
        });
        for (const [id, score] of scores) {
            const fragment = data.fragments.get(id);
            const owner = data.nodes.get(fragment.owner);
            const terms = new Set([...fragment.terms, ...tokenize(owner.name + ' ' + (owner.summary || ''))]);
            const exact = matchesName(owner.name) ? 2 : 0;
            scores.set(id, score * ((0.15 + coverage(terms) / totalWeight) ** 2 + exact));
        }
        const hits = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 100);
        const candidates = new Map();
        for (const [fragmentId, score] of hits) {
            const start = data.fragments.get(fragmentId).owner;
            if (!candidates.has(start)) candidates.set(start, []);
            candidates.get(start).push({ fragmentId, score, path: [] });
            const queue = [{ id: start, factor: 1, path: [] }], visited = new Map();
            for (let i = 0; i < queue.length; i++) {
                const current = queue[i], node = data.nodes.get(current.id);
                if ((visited.get(node.id) || 0) >= current.factor) continue;
                visited.set(node.id, current.factor);
                if (node.kind === 'operation') {
                    if (node.id !== start) {
                        if (!candidates.has(node.id)) candidates.set(node.id, []);
                        candidates.get(node.id).push({ fragmentId, score: score * current.factor, path: current.path });
                    }
                    continue;
                }
                if (current.path.length >= 4) continue;
                const fanout = new Set(node.incoming.map(edge => edge.owner)).size;
                for (const edge of node.incoming) {
                    const factor = current.factor * 0.8 / Math.sqrt(Math.max(1, fanout / 3));
                    if (factor < 0.03) continue;
                    queue.push({ id: edge.owner, factor, path: [...current.path, edge.fragment] });
                }
            }
        }
        const ranked = [...candidates].map(([id, evidence]) => {
            evidence.sort((a, b) => b.score - a.score);
            const node = data.nodes.get(id);
            // Direct action and subject matches outrank indirect matches in shared responses.
            const directCoverage = coverage(new Set(tokenize(node.name + ' ' + node.summary))) / totalWeight;
            const actions = query.groups.filter(group => !group.subject), nameTerms = new Set(tokenize(node.name));
            const actionMatch = actions.length ? 0.6 + actions.reduce((sum, group) => sum + groupMatch(group, nameTerms), 0) / actions.length : 1;
            const score = (evidence[0].score + evidence.slice(1, 4).reduce((sum, hit) => sum + hit.score * 0.12, 0))
                * (1 + 2 * directCoverage ** 2) * actionMatch;
            return { id, score, evidence };
        }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        // Avoid showing a schema separately when the same evidence belongs to a matching operation.
        const distinct = ranked.filter(item => data.nodes.get(item.id).kind === 'operation' ||
            matchesName(data.nodes.get(item.id).name) || !ranked.some(other =>
                data.nodes.get(other.id).kind === 'operation' && other.score >= item.score * 0.4 &&
                other.evidence.some(hit => hit.fragmentId === item.evidence[0].fragmentId)));
        const selected = distinct.filter(item => item.score >= (distinct[0]?.score || 0) * data.minScoreRatio)
            .slice(0, Math.min(10, Math.max(1, Math.floor(budget / 1200))));
        const included = new Set(), selectedSchemas = new Set(), sections = new Map(), sources = [];
        let used = 0, skipped = 0;
        function sectionHeader(node) {
            if (node.kind !== 'operation') return `=== Schema: ${node.name} (selected fragments) ===`;
            return `=== Operation: ${node.name} ===` + (node.summary || node.description ? ''
                : '\nNo description is available; the name alone does not establish behavior.');
        }
        function include(ids) {
            const bundle = new Set();
            function add(id) {
                if (!id || included.has(id) || bundle.has(id)) return;
                const fragment = data.fragments.get(id);
                if (!fragment) return;
                add(fragment.parent); bundle.add(id);
            }
            ids.forEach(add);
            const newOwners = new Set([...bundle].map(id => data.fragments.get(id).owner).filter(id => !sections.has(id)));
            const size = [...bundle].reduce((sum, id) => sum + data.fragments.get(id).text.length + 2, 0)
                + [...newOwners].reduce((sum, id) => sum + sectionHeader(data.nodes.get(id)).length + 2, 0);
            if (used + size > budget) { skipped++; return false; }
            for (const id of bundle) {
                const fragment = data.fragments.get(id), node = data.nodes.get(fragment.owner);
                if (!sections.has(node.id)) {
                    const header = sectionHeader(node);
                    sections.set(node.id, [header]); used += header.length + 2;
                }
                included.add(id); sections.get(node.id).push(fragment.text); used += fragment.text.length + 2;
                if (node.kind === 'model') selectedSchemas.add(node.name);
            }
            return true;
        }
        // Include selected definitions first, then supporting fragments and reference paths.
        for (const item of selected) {
            const node = data.nodes.get(item.id);
            if (include([node.fragments[0]])) sources.push({ ...node, sourceId: `S${sources.length + 1}` });
        }
        const evidence = selected.flatMap(item => item.evidence.filter(hit => hit.score >= item.evidence[0].score * 0.3).slice(0, 8))
            .sort((a, b) => b.score - a.score);
        function definition(id) {
            const node = data.nodes.get(id);
            if (!node) return [];
            // Small enums are included in full; large enums are filtered by relevance.
            return [node.fragments[0]];
        }
        for (const hit of evidence) {
            const fragment = data.fragments.get(hit.fragmentId);
            include([...hit.path].reverse().concat(hit.fragmentId, fragment.refs.flatMap(definition)));
        }
        // Expand nearby schemas for standalone contracts, visiting cycles only once.
        const schemaQueue = selected.filter(item => data.nodes.get(item.id).kind === 'model')
            .map(item => ({ id: item.id, depth: 0 }));
        const expanded = new Set();
        let expandedSize = 0;
        for (let i = 0; i < schemaQueue.length && expanded.size < 20; i++) {
            const current = schemaQueue[i], node = data.nodes.get(current.id);
            if (expanded.has(current.id) || current.depth > 2) continue;
            expanded.add(current.id);
            const size = node.fragments.reduce((sum, id) => sum + data.fragments.get(id).text.length + 2, 0);
            const bestScore = node.fragments.reduce((best, id) => Math.max(best, scores.get(id) || 0), 0);
            const ids = size <= 3500 ? node.fragments : node.fragments.filter(id => id === node.fragments[0] ||
                (scores.has(id) && scores.get(id) >= bestScore * 0.3));
            const cost = ids.filter(id => !included.has(id)).reduce((sum, id) => sum + data.fragments.get(id).text.length + 2, 0);
            if (expandedSize + cost > budget * 0.5 || !include(ids)) continue;
            expandedSize += cost;
            node.edges.filter(edge => included.has(edge.fragment)).forEach(edge => schemaQueue.push({ id: edge.target, depth: current.depth + 1 }));
        }
        // Preserve relevant request and response structures for top operations.
        for (const item of selected.slice(0, 4)) {
            const node = data.nodes.get(item.id);
            if (node.kind !== 'operation') continue;
            include(node.fragments.filter(id => ['request', 'response'].includes(data.fragments.get(id).role)));
            const queue = node.edges.filter(edge => ['request', 'response'].includes(edge.role)).map(edge => ({ id: edge.target, depth: 0 }));
            const visited = new Set();
            for (let i = 0; i < queue.length; i++) {
                const current = queue[i]; if (visited.has(current.id)) continue; visited.add(current.id);
                const target = data.nodes.get(current.id);
                if (current.depth > 2 || new Set(target.incoming.map(edge => edge.owner)).size > 20) continue;
                const small = target.fragments.reduce((sum, id) => sum + data.fragments.get(id).text.length, 0) <= 3500;
                for (const id of target.fragments) {
                    const fragment = data.fragments.get(id);
                    if (!small && !scores.has(id) && id !== target.fragments[0]) continue;
                    include([id, ...fragment.refs.flatMap(definition)]);
                }
                target.edges.filter(edge => included.has(edge.fragment)).forEach(edge => queue.push({ id: edge.target, depth: current.depth + 1 }));
            }
        }
        const contextTerms = new Set([...included].flatMap(id => [...data.fragments.get(id).terms]));
        const subjects = query.groups.filter(group => group.subject);
        const missingSubjects = subjects.filter(group => !groupMatch(group, contextTerms)).map(group => group.exact[0].join(' '));
        // Common verbs alone are insufficient evidence for an unknown subject.
        const subjectMissing = subjects.length > 0 && missingSubjects.length === subjects.length;
        const scope = [...selectedSchemas].join(' ');
        sources.forEach(source => { source.schemaNames = scope; });
        return { context: subjectMissing ? '' : [...sections.values()].map(parts => parts.join('\n\n')).join('\n\n'), sources: subjectMissing ? [] : sources, diagnostics: {
            missingSubjects, subjectMissing,
            candidates: ranked.slice(0, 20).map(item => ({ name: data.nodes.get(item.id).name, score: item.score })),
            fragments: included.size, schemas: selectedSchemas.size, skipped, warnings: data.warnings
        } };
    }
    const api = { tokenize, validateVocabulary, buildIndex, retrieve };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SwaggerAssistantSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
