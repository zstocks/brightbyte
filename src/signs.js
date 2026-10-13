// Applies changes to a sign's settings, works out what it should show,
// pushes that to the sign, and sets a timer for when a message expires.

import { customIsActive, resolve } from './state.js';

const MAX_TIMER_MS = 24 * 60 * 60 * 1000; // setTimeout can't wait much longer than 24 days

export function createSignService({ db, hub = null }) {
    const timers = new Map(); // sign ID -> timer for the next expiry

    // Recalculates one sign. Called after every change, when a message
    // expires, and once at startup.
    function refresh(signId, settings) {
        const now = Date.now();

        // Tidy away a message that has run out.
        if (settings.custom && !customIsActive(settings.custom, now)) {
            settings = { ...settings, custom: null };
        }

        const state = resolve(settings, now);
        const before = db.getSign(signId);
        const sign = db.saveSign(signId, settings, state);

        if (hub && JSON.stringify(before.state) !== JSON.stringify(state)) {
            hub.pushState(signId, state);
        }

        clearTimeout(timers.get(signId));
        timers.delete(signId);
        if (settings.custom?.expiresAt) {
            const delay = Date.parse(settings.custom.expiresAt) - now;
            const timer = setTimeout(() => {
                const latest = db.getSign(signId);
                if (latest) refresh(signId, latest.settings);
            }, Math.min(delay, MAX_TIMER_MS));
            timer.unref?.();
            timers.set(signId, timer);
        }
        return sign;
    }

    function change(signId, edit) {
        const sign = db.getSign(signId);
        if (!sign) return null;
        return refresh(signId, edit(sign.settings));
    }

    return {
        // Run once at startup: a message may have expired while the
        // server was off.
        start() {
            for (const sign of db.listSigns()) refresh(sign.id, sign.settings);
        },
        setCustom: (signId, custom) => change(signId, (settings) => ({ ...settings, custom })),
        clearCustom: (signId) => change(signId, (settings) => ({ ...settings, custom: null })),
        setDefault: (signId, value) => change(signId, (settings) => ({ ...settings, default: value })),
        setDark: (signId, dark) => change(signId, (settings) => ({ ...settings, dark })),
        setBrightness: (signId, brightness) => change(signId, (settings) => ({ ...settings, brightness })),
        stop() {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}
