import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';

// Builds a database file the way Phase 4/5 left it, then opens it
// with the current code.
function migrate(t, legacyState) {
    const dir = mkdtempSync(join(tmpdir(), 'brightbyte-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = new Database(join(dir, 'brightbyte.db'));
    old.exec('CREATE TABLE signs (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL)');
    old.prepare('INSERT INTO signs VALUES (?, ?, ?, ?)').run('desk', 'Desk sign', JSON.stringify(legacyState), '2026-10-11T00:00:00Z');
    old.close();
    const db = openDatabase(dir);
    t.after(() => db.close());
    return db.getSign('desk');
}

test('an old message becomes a custom message that stays until cleared', (t) => {
    const sign = migrate(t, { mode: 'message', text: 'Busy', color: '#ff1e1e', icon: 'dnd' });
    assert.deepEqual(sign.settings.custom, { text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt: null });
    assert.equal(sign.settings.dark, false);
    assert.equal(sign.settings.default.mode, 'clock');
});

test('an old dark state turns the dark switch on', (t) => {
    const sign = migrate(t, { mode: 'dark', text: 'Busy', color: '#ff1e1e', icon: null });
    assert.equal(sign.settings.dark, true);
    assert.equal(sign.settings.custom, null);
});

test('an old clock state becomes the plain default', (t) => {
    const sign = migrate(t, { mode: 'clock', text: '', color: '#0096ff', icon: null });
    assert.equal(sign.settings.custom, null);
    assert.equal(sign.settings.brightness, 30);
});

test('opening the same database twice keeps its data', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'brightbyte-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = openDatabase(dir);
    first.createPreset({ name: 'Busy', text: 'Busy', color: '#ff1e1e', icon: null, minutes: null });
    first.close();
    const second = openDatabase(dir);
    assert.equal(second.listPresets().length, 1);
    assert.equal(second.listSigns().length, 1);
    second.close();
});
