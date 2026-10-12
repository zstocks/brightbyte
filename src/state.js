// The "display state" is everything a sign needs to draw itself.
// It mirrors the DisplayState struct in the firmware.

export const MODES = ['message', 'clock', 'dark'];

// Must match the icon names in the firmware's icons.h.
export const ICONS = [
    'check', 'x', 'heart', 'bell', 'phone', 'coffee',
    'dnd', 'mic', 'smiley', 'sun', 'moon',
];

export const MAX_TEXT_LENGTH = 200;

export const DEFAULT_STATE = Object.freeze({
    mode: 'clock',
    text: '',
    color: '#0096ff',
    icon: null,
});

// Checks a state object from the browser. Returns { ok, state } or
// { ok: false, error }. Never trusts the input's shape.
export function validateState(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'State must be an object.' };
    }
    const { mode, text = '', color = DEFAULT_STATE.color, icon = null } = input;

    if (!MODES.includes(mode)) {
        return { ok: false, error: `Mode must be one of: ${MODES.join(', ')}.` };
    }
    if (typeof text !== 'string') {
        return { ok: false, error: 'Text must be a string.' };
    }
    if (text.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: `Text must be ${MAX_TEXT_LENGTH} characters or fewer.` };
    }
    // The sign's font only has the printable ASCII characters.
    if (!/^[\x20-\x7e]*$/.test(text)) {
        return { ok: false, error: 'Text can only use plain keyboard characters (no emoji or accents).' };
    }
    if (mode === 'message' && text.trim() === '') {
        return { ok: false, error: 'A message needs some text.' };
    }
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
        return { ok: false, error: 'Color must look like #rrggbb.' };
    }
    if (icon !== null && !ICONS.includes(icon)) {
        return { ok: false, error: 'Unknown icon.' };
    }
    return {
        ok: true,
        state: { mode, text: text.trim(), color: color.toLowerCase(), icon },
    };
}
