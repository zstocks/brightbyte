import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createSignService } from '../src/signs.js';

function setup(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-12T12:00:00Z') });
    const db = openDatabase(':memory:');
    const pushed = [];
    const hub = { pushState: (id, state) => pushed.push(state), isOnline: () => true };
    const signs = createSignService({ db, hub, timezone: 'America/Denver' });
    signs.start();
    t.after(() => { signs.stop(); db.close(); });
    return { db, signs, pushed };
}

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const busy = (expiresAt = null) => ({ text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt });

test('sending a message pushes it to the sign', (t) => {
    const { signs, pushed } = setup(t);
    const sign = signs.setCustom('desk', busy());
    assert.equal(sign.state.text, 'Busy');
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].mode, 'message');
});

test('a message with a duration clears itself and the default returns', (t) => {
    const { db, signs, pushed } = setup(t);
    signs.setCustom('desk', busy(inMinutes(15)));
    t.mock.timers.tick(14 * 60000);
    assert.equal(db.getSign('desk').state.mode, 'message');
    t.mock.timers.tick(60000);
    const sign = db.getSign('desk');
    assert.equal(sign.state.mode, 'clock');
    assert.equal(sign.settings.custom, null);
    assert.deepEqual(pushed.map((state) => state.mode), ['message', 'clock']);
});

test('clearing by hand cancels the pending expiry', (t) => {
    const { signs, pushed } = setup(t);
    signs.setCustom('desk', busy(inMinutes(15)));
    signs.clearCustom('desk');
    t.mock.timers.tick(20 * 60000);
    assert.deepEqual(pushed.map((state) => state.mode), ['message', 'clock']);
});

test('a newer message replaces the older one and its timer', (t) => {
    const { db, signs } = setup(t);
    signs.setCustom('desk', busy(inMinutes(5)));
    signs.setCustom('desk', { text: 'Lunch', color: '#ffc800', icon: 'coffee', expiresAt: inMinutes(60) });
    t.mock.timers.tick(10 * 60000);
    assert.equal(db.getSign('desk').state.text, 'Lunch');
});

test('the dark switch hides a message without losing it', (t) => {
    const { signs } = setup(t);
    signs.setCustom('desk', busy());
    assert.equal(signs.setDark('desk', true).state.mode, 'dark');
    assert.equal(signs.setDark('desk', false).state.text, 'Busy');
});

test('nothing is pushed when the display would not change', (t) => {
    const { signs, pushed } = setup(t);
    signs.setDark('desk', true);
    signs.setCustom('desk', busy());     // hidden behind the dark switch
    signs.setDefault('desk', { mode: 'message', text: 'Hi', color: '#00dc3c', icon: null });
    assert.equal(pushed.length, 1);
});

test('changing brightness pushes the new level', (t) => {
    const { signs, pushed } = setup(t);
    signs.setBrightness('desk', 12);
    assert.equal(pushed.at(-1).brightness, 12);
});

test('a message that expired while the server was off is cleared at startup', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-12T12:00:00Z') });
    const db = openDatabase(':memory:');
    const first = createSignService({ db });
    first.setCustom('desk', busy(inMinutes(5)));
    first.stop();                              // server stops; its timers are gone
    t.mock.timers.setTime(Date.parse('2026-10-12T13:00:00Z'));
    const second = createSignService({ db });
    second.start();
    assert.equal(db.getSign('desk').state.mode, 'clock');
    second.stop();
    db.close();
});

test('changes to an unknown sign return null', (t) => {
    const { signs } = setup(t);
    assert.equal(signs.setDark('nope', true), null);
});

// The mocked clock starts at 2026-10-12T12:00Z: Monday 06:00 in Denver.
const standup = (changes = {}) => ({
    text: 'Standup', color: '#00dc3c', icon: 'mic',
    kind: 'weekly', days: [1], date: null, start: '06:30', end: '06:45', enabled: true, ...changes,
});

test('a schedule starts and ends on its own as the minutes pass', (t) => {
    const { db, signs, pushed } = setup(t);
    signs.createSchedule('desk', standup());
    assert.equal(db.getSign('desk').state.mode, 'clock');
    t.mock.timers.tick(29 * 60000);
    assert.equal(db.getSign('desk').state.mode, 'clock');      // 06:29
    t.mock.timers.tick(2 * 60000);
    assert.equal(db.getSign('desk').state.text, 'Standup');    // 06:31
    t.mock.timers.tick(15 * 60000);
    assert.equal(db.getSign('desk').state.mode, 'clock');      // 06:46
    assert.deepEqual(pushed.map((state) => state.mode), ['message', 'clock']);
});

test('creating a schedule that is already running shows it at once', (t) => {
    const { signs, pushed } = setup(t);
    signs.createSchedule('desk', standup({ start: '05:00', end: '07:00' }));
    assert.equal(pushed.at(-1).text, 'Standup');
});

test('turning a schedule off or deleting it removes it from the sign', (t) => {
    const { db, signs } = setup(t);
    const schedule = signs.createSchedule('desk', standup({ start: '05:00', end: '07:00' }));
    signs.updateSchedule(schedule.id, standup({ start: '05:00', end: '07:00', enabled: false }));
    assert.equal(db.getSign('desk').state.mode, 'clock');
    signs.updateSchedule(schedule.id, standup({ start: '05:00', end: '07:00' }));
    assert.equal(db.getSign('desk').state.text, 'Standup');
    assert.equal(signs.deleteSchedule(schedule.id), true);
    assert.equal(db.getSign('desk').state.mode, 'clock');
    assert.equal(signs.deleteSchedule(schedule.id), false);
});

test('a yielding message is interrupted by a schedule and comes back after', (t) => {
    const { db, signs } = setup(t);
    signs.createSchedule('desk', standup());
    signs.setCustom('desk', { ...busy(), yieldToSchedule: true, sentAt: new Date().toISOString() });
    assert.equal(db.getSign('desk').state.text, 'Busy');
    t.mock.timers.tick(31 * 60000);
    assert.equal(db.getSign('desk').state.text, 'Standup');
    t.mock.timers.tick(15 * 60000);
    assert.equal(db.getSign('desk').state.text, 'Busy');
});

test('a preset can be sent, and the service knows when it is showing', (t) => {
    const { signs } = setup(t);
    const lunch = { text: 'At lunch', color: '#ffc800', icon: 'coffee', minutes: 60 };
    assert.equal(signs.isShowingPreset('desk', lunch), false);
    const sign = signs.sendPreset('desk', lunch);
    assert.equal(sign.settings.custom.expiresAt, inMinutes(60));
    assert.equal(signs.isShowingPreset('desk', lunch), true);
    t.mock.timers.tick(61 * 60000);
    assert.equal(signs.isShowingPreset('desk', lunch), false);
});

test('the view explains where the current display came from', (t) => {
    const { db, signs } = setup(t);
    assert.equal(signs.view(db.getSign('desk')).source, 'default');
    const schedule = signs.createSchedule('desk', standup({ start: '05:00', end: '07:00' }));
    const view = signs.view(db.getSign('desk'));
    assert.deepEqual([view.source, view.scheduleId, view.schedules.length], ['schedule', schedule.id, 1]);
    signs.setCustom('desk', busy());
    assert.equal(signs.view(db.getSign('desk')).source, 'custom');
});
