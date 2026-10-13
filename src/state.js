// What a sign can show, and how the server decides what it shows.
//
// Each sign has "settings" (the layers you control from the dashboard)
// and a "display state" (the one thing it is showing right now, which
// is what gets sent to the sign). resolve() turns the first into the
// second.

// Must match the icon names in the firmware's icons.h.
export const ICONS = [
    'check', 'x', 'heart', 'bell', 'phone', 'coffee',
    'dnd', 'mic', 'smiley', 'sun', 'moon',
];

export const MAX_TEXT_LENGTH = 200;
export const MAX_NAME_LENGTH = 40;
export const MAX_MINUTES = 7 * 24 * 60; // presets can last up to a week
export const DEFAULT_COLOR = '#0096ff';

export const DEFAULT_SETTINGS = Object.freeze({
    // Shown when nothing else is active.
    default: Object.freeze({ mode: 'clock', text: '', color: DEFAULT_COLOR, icon: null }),
    // A message sent from the dashboard, or null. expiresAt is an ISO
    // timestamp, or null to stay until cleared by hand.
    custom: null,
    // The off switch. Overrides everything while true.
    dark: false,
    // 1 to 100.
    brightness: 30,
});

const fail = (error) => ({ ok: false, error });
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Checks the text, color and icon that every kind of message shares.
function checkMessageFields(input, { textRequired }) {
    const { text = '', color = DEFAULT_COLOR, icon = null } = input;
    if (typeof text !== 'string') return fail('Text must be a string.');
    if (text.length > MAX_TEXT_LENGTH) return fail(`Text must be ${MAX_TEXT_LENGTH} characters or fewer.`);
    // The sign's font only has the printable ASCII characters.
    if (!/^[\x20-\x7e]*$/.test(text)) {
        return fail('Text can only use plain keyboard characters (no emoji or accents).');
    }
    if (textRequired && text.trim() === '') return fail('A message needs some text.');
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return fail('Color must look like #rrggbb.');
    if (icon !== null && !ICONS.includes(icon)) return fail('Unknown icon.');
    return { ok: true, fields: { text: text.trim(), color: color.toLowerCase(), icon } };
}

// A message sent from the dashboard: { text, color, icon, expiresAt }.
export function validateCustom(input, now = Date.now()) {
    if (!isPlainObject(input)) return fail('Message must be an object.');
    const checked = checkMessageFields(input, { textRequired: true });
    if (!checked.ok) return checked;

    const { expiresAt = null } = input;
    if (expiresAt !== null) {
        const time = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
        if (Number.isNaN(time)) return fail('The clear time is not a valid date.');
        if (time <= now) return fail('The clear time must be in the future.');
        return { ok: true, custom: { ...checked.fields, expiresAt: new Date(time).toISOString() } };
    }
    return { ok: true, custom: { ...checked.fields, expiresAt: null } };
}

// The default: { mode: 'clock' | 'message', text, color, icon }.
export function validateDefault(input) {
    if (!isPlainObject(input)) return fail('Default must be an object.');
    if (input.mode !== 'clock' && input.mode !== 'message') return fail('Default must be the clock or a message.');
    const checked = checkMessageFields(input, { textRequired: input.mode === 'message' });
    if (!checked.ok) return checked;
    return { ok: true, default: { mode: input.mode, ...checked.fields } };
}

export function validateBrightness(value) {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        return fail('Brightness must be a whole number from 1 to 100.');
    }
    return { ok: true, brightness: value };
}

// A saved message: { name, text, color, icon, minutes }. minutes is how
// long it stays up, or null to stay until cleared.
export function validatePreset(input) {
    if (!isPlainObject(input)) return fail('Preset must be an object.');
    const { name, minutes = null } = input;
    if (typeof name !== 'string' || name.trim() === '') return fail('A preset needs a name.');
    if (name.trim().length > MAX_NAME_LENGTH) return fail(`Preset names must be ${MAX_NAME_LENGTH} characters or fewer.`);
    const checked = checkMessageFields(input, { textRequired: true });
    if (!checked.ok) return checked;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)) {
        return fail('Duration must be a whole number of minutes, up to one week.');
    }
    return { ok: true, preset: { name: name.trim(), ...checked.fields, minutes } };
}

export function customIsActive(custom, now = Date.now()) {
    if (!custom) return false;
    return custom.expiresAt === null || Date.parse(custom.expiresAt) > now;
}

// Decides what a sign shows right now. Highest priority first:
//   1. the dark switch
//   2. an active custom message
//   3. (scheduled messages will go here in Phase 7)
//   4. the default
export function resolve(settings, now = Date.now()) {
    const { brightness } = settings;
    if (settings.dark) {
        return { mode: 'dark', text: '', color: DEFAULT_COLOR, icon: null, brightness };
    }
    if (customIsActive(settings.custom, now)) {
        const { text, color, icon } = settings.custom;
        return { mode: 'message', text, color, icon, brightness };
    }
    const { mode, text, color, icon } = settings.default;
    if (mode === 'message') return { mode: 'message', text, color, icon, brightness };
    return { mode: 'clock', text: '', color, icon: null, brightness };
}
