'use strict';

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

function resolve(spec, ref) {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
    try {
        const path = decodeURIComponent(ref.slice(2)).split('/')
            .map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
        let node = spec;
        for (const key of path) {
            if (!node || !Object.hasOwn(node, key)) return null;
            node = node[key];
        }
        return { node, path };
    } catch { return null; }
}

function dereference(spec, value) {
    const seen = new Set();
    while (value && typeof value === 'object' && typeof value.$ref === 'string') {
        if (seen.has(value.$ref)) break;
        seen.add(value.$ref);
        const found = resolve(spec, value.$ref);
        if (!found || !found.node || typeof found.node !== 'object') break;
        value = { ...found.node, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) };
    }
    return value;
}

function parameters(spec, item, operation) {
    const merged = new Map();
    for (const value of [...(item.parameters || []), ...(operation.parameters || [])]) {
        const parameter = dereference(spec, value);
        if (parameter && typeof parameter === 'object') merged.set(`${parameter.in}:${parameter.name}`, parameter);
    }
    return [...merged.values()];
}

function assertSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new TypeError('spec must be an OpenAPI object');
    }
}

function validateSpecifications(list, baseURI) {
    if (!Array.isArray(list) || !list.length || list.some(item => !item ||
        typeof item.name !== 'string' || !item.name.trim() ||
        typeof item.url !== 'string' || !item.url.trim())) {
        throw new TypeError('specifications must contain unique { name, url } entries');
    }
    const urls = list.map(item => {
        try { return new URL(item.url, baseURI).href; } catch { return item.url; }
    });
    if (new Set(list.map(item => item.name)).size !== list.length || new Set(urls).size !== list.length) {
        throw new TypeError('specifications must contain unique { name, url } entries');
    }
}

module.exports = { methods, resolve, dereference, parameters, assertSpec, validateSpecifications };
