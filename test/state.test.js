import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SETTINGS, MAX_TEXT_LENGTH, resolve,
    validateBrightness, validateCustom, validateDefault, validatePreset,
} from '../src/state.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const later = (minutes) => new Date(NOW + minutes * 60000).toISOString();
const settings = (changes = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), ...changes });
const message = (changes = {}) => ({ text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt: null, ...changes });

test('with nothing set, the sign shows the default clock', () => {
    assert.deepEqual(resolve(settings(), NOW), {
        mode: 'clock', text: '', color: '#0096ff', icon: null, brightness: 30,
    });
});

test('the default can be a message', () => {
    const state = resolve(settings({ default: { mode: 'message', text: 'Hello', color: '#00dc3c', icon: 'smiley' } }), NOW);
    assert.deepEqual(state, { mode: 'message', text: 'Hello', color: '#00dc3c', icon: 'smiley', brightness: 30 });
});

test('a custom message beats the default', () => {
    assert.equal(resolve(settings({ custom: message() }), NOW).text, 'Busy');
    assert.equal(resolve(settings({ custom: message({ expiresAt: later(10) }) }), NOW).text, 'Busy');
});

test('an expired custom message falls back to the default', () => {
    assert.equal(resolve(settings({ custom: message({ expiresAt: later(-1) }) }), NOW).mode, 'clock');
    assert.equal(resolve(settings({ custom: message({ expiresAt: later(0) }) }), NOW).mode, 'clock');
});

test('the dark switch beats everything', () => {
    assert.equal(resolve(settings({ dark: true, custom: message() }), NOW).mode, 'dark');
});

test('brightness is always passed through', () => {
    for (const changes of [{}, { dark: true }, { custom: message() }]) {
        assert.equal(resolve(settings({ ...changes, brightness: 77 }), NOW).brightness, 77);
    }
});

test('validateCustom accepts and normalizes a message', () => {
    assert.deepEqual(validateCustom({ text: '  Busy ', color: '#FF1E1E', icon: 'dnd' }, NOW), {
        ok: true,
        custom: { text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt: null },
    });
    assert.equal(validateCustom(message({ expiresAt: later(5) }), NOW).custom.expiresAt, later(5));
});

test('validateCustom rejects bad input', () => {
    const bad = [
        null, 'text', [], {},
        { text: '' }, { text: '   ' }, { text: 42 },
        { text: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
        { text: 'café' }, { text: 'hi \u{1F600}' }, { text: 'line\nbreak' },
        { text: 'hi', color: 'red' }, { text: 'hi', color: '#12345' },
        { text: 'hi', icon: 'unicorn' },
        { text: 'hi', expiresAt: 'soon' }, { text: 'hi', expiresAt: 12345 },
        { text: 'hi', expiresAt: later(-5) },
    ];
    for (const input of bad) {
        const result = validateCustom(input, NOW);
        assert.equal(result.ok, false, JSON.stringify(input));
        assert.equal(typeof result.error, 'string');
    }
});

test('validateDefault needs text only for a message', () => {
    assert.equal(validateDefault({ mode: 'clock' }).ok, true);
    assert.equal(validateDefault({ mode: 'message', text: 'Hi' }).ok, true);
    assert.equal(validateDefault({ mode: 'message', text: '' }).ok, false);
    assert.equal(validateDefault({ mode: 'dark' }).ok, false);
    assert.equal(validateDefault(null).ok, false);
});

test('validateBrightness accepts whole numbers from 1 to 100', () => {
    for (const good of [1, 30, 100]) assert.equal(validateBrightness(good).ok, true);
    for (const bad of [0, 101, 5.5, '50', null, undefined, NaN]) assert.equal(validateBrightness(bad).ok, false);
});

test('validatePreset checks the name and duration', () => {
    const base = { name: ' Lunch ', text: 'At lunch', color: '#ffc800', icon: 'coffee', minutes: 60 };
    assert.deepEqual(validatePreset(base), {
        ok: true,
        preset: { name: 'Lunch', text: 'At lunch', color: '#ffc800', icon: 'coffee', minutes: 60 },
    });
    assert.equal(validatePreset({ ...base, minutes: null }).ok, true);
    for (const changes of [
        { name: '' }, { name: '  ' }, { name: 'x'.repeat(41) }, { name: 7 },
        { minutes: 0 }, { minutes: 1.5 }, { minutes: 10081 }, { minutes: '60' },
        { text: '' },
    ]) {
        assert.equal(validatePreset({ ...base, ...changes }).ok, false, JSON.stringify(changes));
    }
});
