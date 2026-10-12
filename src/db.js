// SQLite storage. Everything is keyed by sign ID so more signs can
// be added later without changing the schema.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_STATE } from './state.js';

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
    `);

    const insertSign = db.prepare(
        'INSERT OR IGNORE INTO signs (id, name, state, updated_at) VALUES (?, ?, ?, ?)'
    );
    const selectAll = db.prepare('SELECT id, name, state, updated_at FROM signs ORDER BY name');
    const selectOne = db.prepare('SELECT id, name, state, updated_at FROM signs WHERE id = ?');
    const updateState = db.prepare('UPDATE signs SET state = ?, updated_at = ? WHERE id = ?');

    const toSign = (row) => ({
        id: row.id,
        name: row.name,
        state: JSON.parse(row.state),
        updatedAt: row.updated_at,
    });

    // The first sign. Created once; ignored if it already exists.
    insertSign.run('desk', 'Desk sign', JSON.stringify(DEFAULT_STATE), new Date().toISOString());

    return {
        listSigns() {
            return selectAll.all().map(toSign);
        },
        getSign(id) {
            const row = selectOne.get(id);
            return row ? toSign(row) : null;
        },
        saveState(id, state) {
            const result = updateState.run(JSON.stringify(state), new Date().toISOString(), id);
            return result.changes > 0 ? this.getSign(id) : null;
        },
        close() {
            db.close();
        },
    };
}
