import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSchedule, isValidTimezone, localTime, minutesSinceStart } from '../src/schedule.js';

const DENVER = 'America/Denver';
const at = (iso) => Date.parse(iso);
const weekly = (changes = {}) => ({
    id: 1, kind: 'weekly', days: [1, 2, 3, 4, 5], date: null, start: '09:00', end: '17:00', enabled: true, ...changes,
});
const isActive = (schedule, iso) => activeSchedule([schedule], at(iso), DENVER) !== null;

test('localTime converts to the wall clock in a timezone', () => {
    // Daylight time: Denver is UTC-6.
    assert.deepEqual(localTime(at('2026-10-13T17:30:00Z'), DENVER), { date: '2026-10-13', weekday: 2, minutes: 11 * 60 + 30 });
    // Standard time: Denver is UTC-7.
    assert.deepEqual(localTime(at('2026-12-01T17:30:00Z'), DENVER), { date: '2026-12-01', weekday: 2, minutes: 10 * 60 + 30 });
    // Just after midnight UTC is still the evening before in Denver.
    assert.deepEqual(localTime(at('2026-10-13T02:00:00Z'), DENVER), { date: '2026-10-12', weekday: 1, minutes: 20 * 60 });
    assert.equal(localTime(at('2026-10-13T06:00:00Z'), DENVER).minutes, 0); // midnight reads as 0, not 24:00
});

test('a weekly schedule runs between its start and end on its days', () => {
    const schedule = weekly();                                   // weekdays 9 to 5
    assert.equal(isActive(schedule, '2026-10-13T14:59:00Z'), false); // Tue 08:59
    assert.equal(isActive(schedule, '2026-10-13T15:00:00Z'), true);  // Tue 09:00
    assert.equal(isActive(schedule, '2026-10-13T22:59:00Z'), true);  // Tue 16:59
    assert.equal(isActive(schedule, '2026-10-13T23:00:00Z'), false); // Tue 17:00, the end is not included
    assert.equal(isActive(schedule, '2026-10-17T18:00:00Z'), false); // Saturday noon
});

test('a schedule follows the local clock across a daylight saving change', () => {
    const schedule = weekly({ days: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(isActive(schedule, '2026-10-30T15:00:00Z'), true);  // 09:00 before the change (UTC-6)
    assert.equal(isActive(schedule, '2026-11-02T15:00:00Z'), false); // 08:00 after it (UTC-7)
    assert.equal(isActive(schedule, '2026-11-02T16:00:00Z'), true);  // 09:00 after it
});

test('a schedule that ends at or before its start runs past midnight', () => {
    const schedule = weekly({ days: [5], start: '22:00', end: '06:00' }); // Friday night
    assert.equal(isActive(schedule, '2026-10-17T03:59:00Z'), false); // Fri 21:59
    assert.equal(isActive(schedule, '2026-10-17T04:00:00Z'), true);  // Fri 22:00
    assert.equal(isActive(schedule, '2026-10-17T11:59:00Z'), true);  // Sat 05:59
    assert.equal(isActive(schedule, '2026-10-17T12:00:00Z'), false); // Sat 06:00
    assert.equal(isActive(schedule, '2026-10-18T05:00:00Z'), false); // Sat 23:00, not a Friday run
});

test('a one-time schedule runs only on its date', () => {
    const schedule = weekly({ kind: 'once', days: [], date: '2026-10-20', start: '13:00', end: '14:00' });
    assert.equal(isActive(schedule, '2026-10-20T19:30:00Z'), true);  // Oct 20, 13:30
    assert.equal(isActive(schedule, '2026-10-21T19:30:00Z'), false);
    assert.equal(isActive(schedule, '2026-10-27T19:30:00Z'), false);
});

test('a one-time overnight schedule covers the following morning', () => {
    const schedule = weekly({ kind: 'once', days: [], date: '2026-10-31', start: '23:00', end: '01:00' });
    assert.equal(isActive(schedule, '2026-11-01T06:30:00Z'), true);  // Nov 1, 00:30 (still UTC-6)
    assert.equal(isActive(schedule, '2026-11-02T06:30:00Z'), false);
});

test('a disabled schedule never runs', () => {
    assert.equal(isActive(weekly({ enabled: false }), '2026-10-13T18:00:00Z'), false);
});

test('when schedules overlap, the one that started most recently wins', () => {
    const allDay = weekly({ id: 1, start: '09:00', end: '17:00' });
    const meeting = weekly({ id: 2, start: '10:00', end: '11:00' });
    const pick = (iso) => activeSchedule([allDay, meeting], at(iso), DENVER).schedule.id;
    assert.equal(pick('2026-10-13T15:30:00Z'), 1); // 09:30
    assert.equal(pick('2026-10-13T16:30:00Z'), 2); // 10:30
    assert.equal(pick('2026-10-13T17:30:00Z'), 1); // 11:30
});

test('activeSchedule reports when the current run started', () => {
    const result = activeSchedule([weekly()], at('2026-10-13T16:30:45Z'), DENVER); // 10:30:45
    assert.equal(new Date(result.startedAt).toISOString(), '2026-10-13T15:00:00.000Z');
});

test('minutesSinceStart handles a full-day schedule', () => {
    const allDay = weekly({ days: [2], start: '00:00', end: '00:00' });
    assert.equal(minutesSinceStart(allDay, { date: '2026-10-13', weekday: 2, minutes: 0 }), 0);
    assert.equal(minutesSinceStart(allDay, { date: '2026-10-13', weekday: 2, minutes: 1439 }), 1439);
    assert.equal(minutesSinceStart(allDay, { date: '2026-10-14', weekday: 3, minutes: 0 }), null);
});

test('isValidTimezone checks names', () => {
    assert.equal(isValidTimezone('America/Denver'), true);
    assert.equal(isValidTimezone('Mars/Olympus'), false);
});
