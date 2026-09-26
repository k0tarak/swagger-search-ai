(function (root) {
    'use strict';

const parameter = 'ORT';
const storageKey = 'swagger-search-ai:openrouter-key';

function validKey(value) {
    return /^[\x21-\x7e]{1,512}$/.test(value);
}

function urlWithKey(href, value) {
    const url = new URL(href);
    const key = value.trim();
    if (key && !validKey(key)) throw new TypeError('The API key must contain up to 512 printable ASCII characters without spaces.');
    url.searchParams.delete(parameter);
    if (key) url.searchParams.set(parameter, btoa(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    return url.href;
}

function keyFromUrl(href) {
    try {
        const url = new URL(href), values = url.searchParams.getAll(parameter);
        if (values.length !== 1 || !/^[A-Za-z0-9_-]{1,683}$/.test(values[0])) return '';
        const encoded = values[0], key = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
        return new URL(urlWithKey(href, key)).searchParams.get(parameter) === encoded ? key : '';
    } catch { return ''; }
}

    const api = { storageKey, validKey, urlWithKey, keyFromUrl };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SwaggerKeyPersistence = api;
})(typeof window !== 'undefined' ? window : globalThis);
