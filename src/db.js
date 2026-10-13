// SQLite storage. Sign data is keyed by sign ID so more signs can be
// added later without changing the schema.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, resolve } from './state.js';

// Signs created before Phase 6 stored only a single display state.
// This turns that into the layered settings.
function settingsFromLegacyState(state) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    if (state?.mode === 'dark') settings.dark = true;
    if (state?.mode === 'message' && state.text) {
        settings.custom = { text: state.text, color: state.color, icon: state.icon ?? null, expiresAt: null };
    }
    return settings;
}

export function openDatabase(dataDir) {
    let db;
    if (dataDir === ':memory:') {
        db = new Database(':memory:');
    } else {
        mkdirSync(dataDir, { recursive: true });
        db = new Database(join(dataDir, 'brightbyte.db'));
        db.pragma('journal_mode = WAL');
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS signs (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            state      TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS presets (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name    TEXT NOT NULL,
            text    TEXT NOT NULL,
            color   TEXT NOT NULL,
            icon    TEXT,
            minutes INTEGER
        );
    `);

    // Migration: add the settings column to databases from Phase 4/5.
    const columns = db.prepare('PRAGMA table_info(signs)').all().map((column) => column.name);
    if (!columns.includes('settings')) {
        db.exec('ALTER TABLE signs ADD COLUMN settings TEXT');
        const fill = db.prepare('UPDATE signs SET settings = ? WHERE id = ?');
        for (const row of db.prepare('SELECT id, state FROM signs').all()) {
            fill.run(JSON.stringify(settingsFromLegacyState(JSON.parse(row.state))), row.id);
        }
    }

    const insertSign = db.prepare(
        'INSERT OR IGNORE INTO signs (id, name, state, settings, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const selectAll = db.prepare('SELECT * FROM signs ORDER BY name');
    const selectOne = db.prepare('SELECT * FROM signs WHERE id = ?');
    const updateSign = db.prepare('UPDATE signs SET settings = ?, state = ?, updated_at = ? WHERE id = ?');

    const selectPresets = db.prepare('SELECT * FROM presets ORDER BY name COLLATE NOCASE');
    const selectPreset = db.prepare('SELECT * FROM presets WHERE id = ?');
    const insertPreset = db.prepare(
        'INSERT INTO presets (name, text, color, icon, minutes) VALUES (@name, @text, @color, @icon, @minutes)'
    );
    const updatePreset = db.prepare(
        'UPDATE presets SET name = @name, text = @text, color = @color, icon = @icon, minutes = @minutes WHERE id = @id'
    );
    const deletePreset = db.prepare('DELETE FROM presets WHERE id = ?');

    // state is the display state last sent to the sign; settings are
    // the layers it was worked out from.
    const toSign = (row) => ({
        id: row.id,
        name: row.name,
        state: JSON.parse(row.state),
        settings: { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(row.settings) },
        updatedAt: row.updated_at,
    });

    // The first sign. Created once; ignored if it already exists.
    insertSign.run(
        'desk', 'Desk sign',
        JSON.stringify(resolve(DEFAULT_SETTINGS)), JSON.stringify(DEFAULT_SETTINGS),
        new Date().toISOString()
    );

    return {
        listSigns() {
            return selectAll.all().map(toSign);
        },
        getSign(id) {
            const row = selectOne.get(id);
            return row ? toSign(row) : null;
        },
        saveSign(id, settings, state) {
            updateSign.run(JSON.stringify(settings), JSON.stringify(state), new Date().toISOString(), id);
            return this.getSign(id);
        },

        listPresets() {
            return selectPresets.all();
        },
        getPreset(id) {
            return selectPreset.get(id) || null;
        },
        createPreset(preset) {
            return this.getPreset(insertPreset.run(preset).lastInsertRowid);
        },
        updatePreset(id, preset) {
            return updatePreset.run({ ...preset, id }).changes > 0 ? this.getPreset(id) : null;
        },
        deletePreset(id) {
            return deletePreset.run(id).changes > 0;
        },

        close() {
            db.close();
        },
    };
}
