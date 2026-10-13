// Scheduled messages: when each one is active.
//
// A schedule has a start and end time of day ("09:00" to "17:00") and
// either repeats on chosen weekdays or happens once on a date. Times
// are in the sign's own timezone, not the server's. If the end is at
// or before the start, the schedule runs past midnight into the next
// day.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function isValidTimezone(timezone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

// The wall-clock date and time in a timezone:
// { date: '2026-10-13', weekday: 2, minutes: 690 } (weekday 0 is Sunday).
export function localTime(now, timezone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, hourCycle: 'h23', weekday: 'short',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).formatToParts(new Date(now)).map((part) => [part.type, part.value])
    );
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: WEEKDAYS.indexOf(parts.weekday),
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

function dayBefore(local) {
    const [year, month, day] = local.date.split('-').map(Number);
    return {
        date: new Date(Date.UTC(year, month - 1, day) - DAY_MS).toISOString().slice(0, 10),
        weekday: (local.weekday + 6) % 7,
    };
}

const happensOn = (schedule, day) =>
    (schedule.kind === 'once' ? schedule.date === day.date : schedule.days.includes(day.weekday));

// How many minutes ago this schedule's current run started, or null if
// it is not running now.
export function minutesSinceStart(schedule, local) {
    const start = toMinutes(schedule.start);
    const end = toMinutes(schedule.end);
    const now = local.minutes;

    if (end > start) {
        return happensOn(schedule, local) && now >= start && now < end ? now - start : null;
    }
    // Runs past midnight: tonight's run, or the tail of last night's.
    if (happensOn(schedule, local) && now >= start) return now - start;
    if (happensOn(schedule, dayBefore(local)) && now < end) return now + 1440 - start;
    return null;
}

// The schedule that should show now, or null. When several overlap,
// the one that started most recently wins. Returns
// { schedule, startedAt } where startedAt is a timestamp.
export function activeSchedule(schedules, now, timezone) {
    const local = localTime(now, timezone);
    let best = null;
    for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        const since = minutesSinceStart(schedule, local);
        if (since === null) continue;
        if (!best || since < best.since || (since === best.since && schedule.id < best.schedule.id)) {
            best = { schedule, since };
        }
    }
    if (!best) return null;
    const thisMinute = Math.floor(now / 60000) * 60000;
    return { schedule: best.schedule, startedAt: thisMinute - best.since * 60000 };
}
