'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validKey, urlWithKey, keyFromUrl } = require('../src/key-persistence.js');

test('ORT round-trips a key while preserving other URL parts', () => {
    const original = 'https://example.test/docs?api=pets#operation';
    const saved = urlWithKey(original, 'sk-or-example_123');
    assert.equal(new URL(saved).searchParams.get('api'), 'pets');
    assert.equal(new URL(saved).hash, '#operation');
    assert(!saved.includes('sk-or-example_123'));
    assert.equal(keyFromUrl(saved), 'sk-or-example_123');
    assert.equal(urlWithKey(saved, ''), original);
});

test('ORT rejects malformed values and keys that cannot be safely encoded', () => {
    assert.equal(validKey('key with spaces'), false);
    assert.equal(validKey('a'.repeat(513)), false);
    assert.throws(() => urlWithKey('https://example.test/', 'key with spaces'), TypeError);
    assert.equal(keyFromUrl('https://example.test/?ORT=not+base64'), '');
    assert.equal(keyFromUrl('https://example.test/?ORT=YQ&ORT=Yg'), '');
    assert.equal(keyFromUrl('https://example.test/?ORT=YQ='), '');
});
