import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SETTINGS, MAX_TEXT_LENGTH, resolve, resolveWithSource,
    validateBrightness, validateCustom, validateDefault, validatePreset, validateSchedule,
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
        custom: {
            text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt: null,
            yieldToSchedule: false, sentAt: new Date(NOW).toISOString(),
        },
    });
    assert.equal(validateCustom({ text: 'Hi', yieldToSchedule: true }, NOW).custom.yieldToSchedule, true);
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
        { text: 'hi', yieldToSchedule: 'yes' },
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

// ----- Schedules in the priority order -----
// NOW is Monday 2026-10-12 12:00 UTC, which is 06:00 in Denver.

const TZ = { timezone: 'America/Denver' };
const scheduled = (changes = {}) => ({
    id: 1, text: 'Standup', color: '#00dc3c', icon: 'mic',
    kind: 'weekly', days: [1], date: null, start: '05:30', end: '07:00', enabled: true, ...changes,
});
const withSchedules = (list) => ({ ...TZ, schedules: list });

test('an active schedule beats the default', () => {
    const result = resolveWithSource(settings(), NOW, withSchedules([scheduled()]));
    assert.equal(result.source, 'schedule');
    assert.equal(result.scheduleId, 1);
    assert.equal(result.state.text, 'Standup');
});

test('a custom message beats a schedule by default', () => {
    const custom = message({ sentAt: later(-60) });
    const result = resolveWithSource(settings({ custom }), NOW, withSchedules([scheduled()]));
    assert.equal(result.source, 'custom');
});

test('a yielding message gives way to a schedule that starts after it was sent', () => {
    const custom = message({ yieldToSchedule: true, sentAt: later(-60) });   // sent 05:00, schedule began 05:30
    const result = resolveWithSource(settings({ custom }), NOW, withSchedules([scheduled()]));
    assert.equal(result.source, 'schedule');
});

test('a yielding message stays up over a schedule that was already running', () => {
    const custom = message({ yieldToSchedule: true, sentAt: later(-10) });   // sent 05:50, schedule began 05:30
    const result = resolveWithSource(settings({ custom }), NOW, withSchedules([scheduled()]));
    assert.equal(result.source, 'custom');
});

test('a yielding message returns when the schedule ends', () => {
    const custom = message({ yieldToSchedule: true, sentAt: later(-60) });
    const afterEnd = NOW + 61 * 60000;                                       // 07:01
    assert.equal(resolveWithSource(settings({ custom }), afterEnd, withSchedules([scheduled()])).source, 'custom');
});

test('the dark switch beats a schedule', () => {
    assert.equal(resolve(settings({ dark: true }), NOW, withSchedules([scheduled()])).mode, 'dark');
});

test('validateSchedule accepts weekly and one-time schedules', () => {
    const base = { text: ' Standup ', color: '#00DC3C', icon: 'mic', start: '09:00', end: '09:15' };
    assert.deepEqual(validateSchedule({ ...base, kind: 'weekly', days: [5, 1, 1, 3] }), {
        ok: true,
        schedule: { text: 'Standup', color: '#00dc3c', icon: 'mic', kind: 'weekly', days: [1, 3, 5], date: null, start: '09:00', end: '09:15', enabled: true },
    });
    const once = validateSchedule({ ...base, kind: 'once', date: '2026-10-20', enabled: false });
    assert.equal(once.ok, true);
    assert.deepEqual([once.schedule.days, once.schedule.date, once.schedule.enabled], [[], '2026-10-20', false]);
});

test('validateSchedule rejects bad input', () => {
    const base = { text: 'Standup', kind: 'weekly', days: [1], start: '09:00', end: '09:15' };
    for (const changes of [
        { text: '' }, { kind: 'daily' }, { days: [] }, { days: [7] }, { days: [1.5] }, { days: 'mon' },
        { start: '9:00' }, { start: '24:00' }, { end: '09:60' }, { end: null }, { enabled: 'yes' },
        { kind: 'once' }, { kind: 'once', date: '10/20/2026' }, { kind: 'once', date: '2026-13-45' },
    ]) {
        assert.equal(validateSchedule({ ...base, ...changes }).ok, false, JSON.stringify(changes));
    }
    assert.equal(validateSchedule(null).ok, false);
});
