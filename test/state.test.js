import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TEXT_LENGTH, validateState } from '../src/state.js';

test('accepts a message and normalizes it', () => {
    const result = validateState({ mode: 'message', text: '  Busy ', color: '#FF1E1E', icon: 'dnd' });
    assert.deepEqual(result, {
        ok: true,
        state: { mode: 'message', text: 'Busy', color: '#ff1e1e', icon: 'dnd' },
    });
});

test('accepts clock and dark without text', () => {
    assert.equal(validateState({ mode: 'clock' }).ok, true);
    assert.equal(validateState({ mode: 'dark' }).ok, true);
});

test('rejects bad input', () => {
    const bad = [
        null, 'text', [], {},
        { mode: 'party' },
        { mode: 'message', text: '' },
        { mode: 'message', text: '   ' },
        { mode: 'message', text: 42 },
        { mode: 'message', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
        { mode: 'message', text: 'café' },
        { mode: 'message', text: 'hi \u{1F600}' },
        { mode: 'message', text: 'line\nbreak' },
        { mode: 'message', text: 'hi', color: 'red' },
        { mode: 'message', text: 'hi', color: '#12345' },
        { mode: 'message', text: 'hi', icon: 'unicorn' },
    ];
    for (const input of bad) {
        const result = validateState(input);
        assert.equal(result.ok, false, JSON.stringify(input));
        assert.equal(typeof result.error, 'string');
    }
});

test('accepts text at the length limit', () => {
    assert.equal(validateState({ mode: 'message', text: 'x'.repeat(MAX_TEXT_LENGTH) }).ok, true);
});
