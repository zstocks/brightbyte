// Applies changes to a sign, works out what it should show, pushes
// that to the sign, and re-checks whenever time could change the
// answer: when a message expires, and every minute for schedules.

import { customIsActive, resolveWithSource } from './state.js';

const MAX_TIMER_MS = 24 * 60 * 60 * 1000; // setTimeout can't wait much longer than 24 days

export function createSignService({ db, hub = null, timezone = 'UTC' }) {
    const expiryTimers = new Map(); // sign ID -> timer for the next expiry
    let minuteTimer = null;

    const resolveFor = (signId, settings, now) =>
        resolveWithSource(settings, now, { schedules: db.listSchedules(signId), timezone });

    // Recalculates one sign. Called after every change, when a message
    // expires, every minute, and once at startup.
    function refresh(signId, settings) {
        const now = Date.now();
        const before = db.getSign(signId);
        if (!before) return null;
        settings = settings || before.settings;

        // Tidy away a message that has run out.
        if (settings.custom && !customIsActive(settings.custom, now)) {
            settings = { ...settings, custom: null };
        }

        const { state } = resolveFor(signId, settings, now);
        const stateChanged = JSON.stringify(before.state) !== JSON.stringify(state);
        const settingsChanged = JSON.stringify(before.settings) !== JSON.stringify(settings);
        const sign = stateChanged || settingsChanged ? db.saveSign(signId, settings, state) : before;
        if (hub && stateChanged) hub.pushState(signId, state);

        clearTimeout(expiryTimers.get(signId));
        expiryTimers.delete(signId);
        if (settings.custom?.expiresAt) {
            const delay = Date.parse(settings.custom.expiresAt) - now;
            const timer = setTimeout(() => refresh(signId), Math.min(delay, MAX_TIMER_MS));
            timer.unref?.();
            expiryTimers.set(signId, timer);
        }
        return sign;
    }

    // Schedules start and end on the minute, so check just after each
    // minute begins.
    function tickEveryMinute() {
        const untilNextMinute = 60000 - (Date.now() % 60000) + 50;
        minuteTimer = setTimeout(() => {
            for (const sign of db.listSigns()) refresh(sign.id);
            tickEveryMinute();
        }, untilNextMinute);
        minuteTimer.unref?.();
    }

    function change(signId, edit) {
        const sign = db.getSign(signId);
        if (!sign) return null;
        return refresh(signId, edit(sign.settings));
    }

    return {
        // Run once at startup: things may have changed while the
        // server was off.
        start() {
            for (const sign of db.listSigns()) refresh(sign.id);
            tickEveryMinute();
        },
        stop() {
            for (const timer of expiryTimers.values()) clearTimeout(timer);
            expiryTimers.clear();
            clearTimeout(minuteTimer);
        },

        setCustom: (signId, custom) => change(signId, (settings) => ({ ...settings, custom })),
        clearCustom: (signId) => change(signId, (settings) => ({ ...settings, custom: null })),
        setDefault: (signId, value) => change(signId, (settings) => ({ ...settings, default: value })),
        setDark: (signId, dark) => change(signId, (settings) => ({ ...settings, dark })),
        setBrightness: (signId, brightness) => change(signId, (settings) => ({ ...settings, brightness })),

        // Sends a saved preset, lasting as long as the preset says.
        sendPreset(signId, preset) {
            const now = Date.now();
            return this.setCustom(signId, {
                text: preset.text,
                color: preset.color,
                icon: preset.icon,
                expiresAt: preset.minutes === null ? null : new Date(now + preset.minutes * 60000).toISOString(),
                yieldToSchedule: false,
                sentAt: new Date(now).toISOString(),
            });
        },
        // True when the sign's current custom message is this preset.
        isShowingPreset(signId, preset) {
            const custom = db.getSign(signId)?.settings.custom;
            return customIsActive(custom) && custom.text === preset.text
                && custom.color === preset.color && custom.icon === preset.icon;
        },

        createSchedule(signId, schedule) {
            if (!db.getSign(signId)) return null;
            const created = db.createSchedule(signId, schedule);
            refresh(signId);
            return created;
        },
        updateSchedule(id, schedule) {
            const updated = db.updateSchedule(id, schedule);
            if (updated) refresh(updated.signId);
            return updated;
        },
        deleteSchedule(id) {
            const existing = db.getSchedule(id);
            if (!existing) return false;
            db.deleteSchedule(id);
            refresh(existing.signId);
            return true;
        },

        // A sign as the dashboard sees it: its settings, what it is
        // showing, why, and its schedules.
        view(sign) {
            const { source, scheduleId } = resolveFor(sign.id, sign.settings, Date.now());
            return {
                ...sign,
                source,
                scheduleId,
                schedules: db.listSchedules(sign.id),
                online: hub ? hub.isOnline(sign.id) : false,
                device: hub ? hub.deviceInfo(sign.id) : { version: null, updateError: null },
            };
        },
    };
}
