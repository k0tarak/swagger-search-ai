'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public source, examples, and built assets contain no raw Cyrillic text', () => {
    const roots = ['src', 'dist', 'examples', 'fixtures', 'scripts', 'README.md', 'LICENSE'];
    const walk = item => {
        const info = fs.statSync(item);
        return info.isDirectory() ? fs.readdirSync(item).flatMap(name => walk(path.join(item, name))) : [item];
    };
    const matches = roots.flatMap(walk).filter(file => /[\u0400-\u04ff]/u.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(matches, []);
});

test('publishable text does not contain credential-shaped secrets', () => {
    const walk = item => fs.statSync(item).isDirectory()
        ? fs.readdirSync(item).flatMap(name => walk(path.join(item, name))) : [item];
    const secrets = /sk-or-v1-[A-Za-z0-9]{32,}|sk-proj-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
    const matches = ['dist', 'examples', 'fixtures', 'README.md'].flatMap(walk)
        .filter(file => secrets.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(matches, []);
});
