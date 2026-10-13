// Dashboard script. Talks to the JSON API and keeps the page in step
// with what the server has saved.

// These match the named colors in the firmware.
const COLORS = [
    ['Blue', '#0096ff'], ['Red', '#ff1e1e'], ['Green', '#00dc3c'],
    ['White', '#dcdcdc'], ['Yellow', '#ffc800'], ['Orange', '#ff6e00'],
    ['Purple', '#aa3cff'], ['Cyan', '#00dcdc'], ['Pink', '#ff50a0'],
];
const QUICK_MINUTES = [15, 30, 60, 120];

const el = (id) => document.getElementById(id);
let sign = null;       // the sign being controlled; one for now
let presets = [];
let editingId = null;  // the preset being edited, if any
let editingScheduleId = null;
let timezone = '';
let keysEnabled = false;
let firmware = null;    // the uploaded firmware file's details, if any
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- Small helpers ----------

function setStatus(message, isError = false) {
    el('status').textContent = message;
    el('status').classList.toggle('error', isError);
}

// Calls the API. Returns the parsed response, or null after showing
// an error message.
async function api(method, path, body) {
    try {
        const response = await fetch(path, {
            method,
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.status === 401) {
            window.location = '/login';
            return null;
        }
        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'That did not work. Try again.', true);
            return null;
        }
        return data;
    } catch {
        setStatus('Could not reach the server. Check your connection and try again.', true);
        return null;
    }
}

function addChoice(container, group, value, label, swatchColor) {
    const wrapper = document.createElement('label');
    wrapper.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = value;
    const span = document.createElement('span');
    if (swatchColor) {
        const swatch = document.createElement('i');
        swatch.className = 'swatch';
        swatch.style.background = swatchColor;
        span.append(swatch);
    }
    span.append(label);
    wrapper.append(input, span);
    container.append(wrapper);
}

function selected(group) {
    const input = document.querySelector(`input[name="${group}"]:checked`);
    return input ? input.value : null;
}

function select(group, value) {
    const input = document.querySelector(`input[name="${group}"][value="${value}"]`);
    if (input) input.checked = true;
    return Boolean(input);
}

function formatDuration(minutes) {
    if (minutes === null) return 'until cleared';
    if (minutes % 60 === 0) return `${minutes / 60} h`;
    if (minutes > 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    return `${minutes} min`;
}

function formatRemaining(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60) return `${seconds} sec`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    if (minutes % 60 === 0) return `${minutes / 60} h`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ---------- Showing the sign ----------

function describe(state) {
    if (state.mode === 'clock') return 'Clock';
    if (state.mode === 'dark') return 'Display off';
    return state.icon ? `"${state.text}" with ${state.icon} icon` : `"${state.text}"`;
}

function customIsActive() {
    const custom = sign.settings.custom;
    return Boolean(custom) && (custom.expiresAt === null || Date.parse(custom.expiresAt) > Date.now());
}

function showExpiry() {
    const custom = sign.settings.custom;
    const active = customIsActive();
    const lines = [];
    el('clear-now').hidden = !active;

    if (sign.source === 'schedule') {
        const schedule = sign.schedules.find((item) => item.id === sign.scheduleId);
        if (schedule) lines.push(`Scheduled until ${formatTime(schedule.end)}.`);
    }
    if (active) {
        const hidden = sign.source !== 'custom';
        const what = hidden ? `Your message "${custom.text}"` : 'It';
        if (custom.expiresAt === null) {
            lines.push(hidden ? `${what} is waiting behind this and stays until you clear it.` : 'Stays until you clear it.');
        } else {
            const remaining = formatRemaining(Date.parse(custom.expiresAt) - Date.now());
            lines.push(hidden ? `${what} is waiting behind this and clears in ${remaining}.` : `Clears in ${remaining}.`);
        }
    }
    el('expiry').textContent = lines.join(' ');
}

function showSign() {
    el('sign-name').textContent = sign.name;
    el('now-showing').textContent = describe(sign.state) + (sign.source === 'schedule' ? ' (scheduled)' : '');
    el('online').textContent = sign.online ? 'Sign online' : 'Sign offline';
    el('online').className = `badge ${sign.online ? 'online' : 'offline'}`;
    el('dark').checked = sign.settings.dark;
    // Leave the slider alone while it is being dragged.
    if (document.activeElement !== el('brightness')) {
        el('brightness').value = sign.settings.brightness;
        el('brightness-value').textContent = sign.settings.brightness;
    }
    const fallback = sign.settings.default;
    el('default-summary').textContent = fallback.mode === 'clock' ? 'Clock' : `"${fallback.text}"`;
    showExpiry();
    showSchedules();
    showFirmware();
}

function updated(data, message) {
    if (!data) return false;
    sign = data.sign;
    showSign();
    setStatus(sign.online ? message : `${message} The sign is offline and will catch up when it reconnects.`);
    return true;
}

// ---------- Presets ----------

function showPresets() {
    const list = el('presets');
    list.replaceChildren();
    el('no-presets').hidden = presets.length > 0;
    for (const preset of presets) {
        const item = document.createElement('li');

        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'send';
        send.setAttribute('aria-label', `Send preset ${preset.name}`);
        const swatch = document.createElement('i');
        swatch.className = 'swatch';
        swatch.style.background = preset.color;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = preset.name;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = formatDuration(preset.minutes);
        send.append(swatch, name, meta);
        send.addEventListener('click', () => sendPreset(preset));

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', `Edit preset ${preset.name}`);
        edit.addEventListener('click', () => startEditing(preset));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete preset ${preset.name}`);
        remove.addEventListener('click', () => deletePreset(preset));

        item.append(send, edit, remove);
        list.append(item);
    }
}

async function sendPreset(preset) {
    const expiresAt = preset.minutes === null
        ? null
        : new Date(Date.now() + preset.minutes * 60000).toISOString();
    const data = await api('PUT', `/api/signs/${sign.id}/custom`, {
        text: preset.text, color: preset.color, icon: preset.icon, expiresAt,
    });
    updated(data, `Sent "${preset.name}".`);
}

function startEditing(preset) {
    editingId = preset.id;
    el('text').value = preset.text;
    select('color', preset.color);
    select('icon', preset.icon || '');
    if (preset.minutes === null) {
        el('clear').value = 'manual';
    } else if (QUICK_MINUTES.includes(preset.minutes)) {
        el('clear').value = String(preset.minutes);
    } else {
        el('clear').value = 'custom';
        el('clear-minutes').value = preset.minutes;
    }
    showClearInputs();
    el('preset-name').value = preset.name;
    el('form-title').textContent = `Editing preset: ${preset.name}`;
    el('save-preset').textContent = 'Update preset';
    el('cancel-edit').hidden = false;
    el('text').focus();
}

function stopEditing() {
    editingId = null;
    el('preset-name').value = '';
    el('form-title').textContent = 'Send a message';
    el('save-preset').textContent = 'Save as preset';
    el('cancel-edit').hidden = true;
}

async function savePreset() {
    const clear = el('clear').value;
    let minutes = null;
    if (clear === 'time') {
        setStatus('A preset can clear after a number of minutes, or stay until you clear it. Pick one of those.', true);
        return;
    }
    if (clear === 'custom') {
        minutes = Number(el('clear-minutes').value);
        if (!Number.isInteger(minutes) || minutes < 1) {
            setStatus('Enter how many minutes the preset should stay up.', true);
            return;
        }
    } else if (clear !== 'manual') {
        minutes = Number(clear);
    }
    const preset = {
        name: el('preset-name').value,
        text: el('text').value,
        color: selected('color'),
        icon: selected('icon') || null,
        minutes,
    };
    const data = editingId === null
        ? await api('POST', '/api/presets', preset)
        : await api('PUT', `/api/presets/${editingId}`, preset);
    if (!data) return;
    presets = presets.filter((item) => item.id !== data.preset.id).concat(data.preset);
    presets.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    showPresets();
    showKeys();
    setStatus(`Saved preset "${data.preset.name}".`);
    stopEditing();
}

async function deletePreset(preset) {
    if (!window.confirm(`Delete the preset "${preset.name}"?`)) return;
    const data = await api('DELETE', `/api/presets/${preset.id}`);
    if (!data) return;
    presets = presets.filter((item) => item.id !== preset.id);
    showPresets();
    showKeys();
    if (editingId === preset.id) stopEditing();
    setStatus(`Deleted preset "${preset.name}".`);
}

// ---------- Sending a message ----------

function showClearInputs() {
    el('clear-minutes').hidden = el('clear').value !== 'custom';
    el('clear-time').hidden = el('clear').value !== 'time';
}

// Works out when the message should clear. Returns { expiresAt } or
// { error }.
function chosenExpiry() {
    const clear = el('clear').value;
    if (clear === 'manual') return { expiresAt: null };
    if (clear === 'time') {
        const value = el('clear-time').value;
        if (!value) return { error: 'Choose the time the message should clear.' };
        const [hours, minutes] = value.split(':').map(Number);
        const when = new Date();
        when.setHours(hours, minutes, 0, 0);
        if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1); // already passed today
        return { expiresAt: when.toISOString() };
    }
    const minutes = clear === 'custom' ? Number(el('clear-minutes').value) : Number(clear);
    if (!Number.isInteger(minutes) || minutes < 1) return { error: 'Enter how many minutes the message should stay up.' };
    return { expiresAt: new Date(Date.now() + minutes * 60000).toISOString() };
}

el('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const expiry = chosenExpiry();
    if (expiry.error) {
        setStatus(expiry.error, true);
        return;
    }
    const data = await api('PUT', `/api/signs/${sign.id}/custom`, {
        text: el('text').value,
        color: selected('color'),
        icon: selected('icon') || null,
        expiresAt: expiry.expiresAt,
        yieldToSchedule: el('yield').checked,
    });
    updated(data, 'Sent to the sign.');
});

el('clear').addEventListener('change', showClearInputs);
el('save-preset').addEventListener('click', savePreset);
el('cancel-edit').addEventListener('click', stopEditing);

el('clear-now').addEventListener('click', async () => {
    updated(await api('DELETE', `/api/signs/${sign.id}/custom`), 'Message cleared.');
});

// ---------- Scheduled messages ----------

// "09:00" -> "9:00 AM"
function formatTime(time) {
    const [hours, minutes] = time.split(':').map(Number);
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${hour12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function formatDays(days) {
    const key = days.join(',');
    if (key === '0,1,2,3,4,5,6') return 'Every day';
    if (key === '1,2,3,4,5') return 'Weekdays';
    if (key === '0,6') return 'Weekends';
    return days.map((day) => DAY_NAMES[day]).join(', ');
}

function describeSchedule(schedule) {
    const when = schedule.kind === 'once'
        ? new Date(`${schedule.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : formatDays(schedule.days);
    const overnight = schedule.end <= schedule.start ? ' (next day)' : '';
    return `${when}, ${formatTime(schedule.start)} to ${formatTime(schedule.end)}${overnight}`;
}

function showSchedules() {
    const list = el('schedules');
    list.replaceChildren();
    const count = sign.schedules.length;
    el('schedule-summary').textContent = count === 0 ? 'None' : `${count} saved`;
    el('schedule-hint').textContent = count === 0
        ? `Nothing scheduled yet. Times use ${timezone} time.`
        : `Times use ${timezone} time. If two overlap, the one that started most recently shows.`;

    for (const schedule of sign.schedules) {
        const item = document.createElement('li');
        if (!schedule.enabled) item.className = 'off';

        const swatch = document.createElement('i');
        swatch.className = 'swatch';
        swatch.style.background = schedule.color;
        const info = document.createElement('div');
        info.className = 'info';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = schedule.text;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = describeSchedule(schedule);
        info.append(name, meta);

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'switch';
        toggle.setAttribute('role', 'switch');
        toggle.checked = schedule.enabled;
        toggle.setAttribute('aria-label', `Scheduled message ${schedule.text} is on`);
        toggle.addEventListener('change', async () => {
            const data = await api('PUT', `/api/schedules/${schedule.id}`, { ...schedule, enabled: toggle.checked });
            if (!updated(data, toggle.checked ? 'Schedule turned on.' : 'Schedule turned off.')) toggle.checked = schedule.enabled;
        });

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', `Edit scheduled message ${schedule.text}`);
        edit.addEventListener('click', () => startEditingSchedule(schedule));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete scheduled message ${schedule.text}`);
        remove.addEventListener('click', async () => {
            if (!window.confirm(`Delete the scheduled message "${schedule.text}"?`)) return;
            if (updated(await api('DELETE', `/api/schedules/${schedule.id}`), 'Scheduled message deleted.')
                && editingScheduleId === schedule.id) stopEditingSchedule();
        });

        item.append(swatch, info, toggle, edit, remove);
        list.append(item);
    }
}

function showScheduleKind() {
    const weekly = el('skind').value === 'weekly';
    el('sdays-field').hidden = !weekly;
    el('sdate-field').hidden = weekly;
}

function startEditingSchedule(schedule) {
    editingScheduleId = schedule.id;
    el('stext').value = schedule.text;
    select('scolor', schedule.color);
    select('sicon', schedule.icon || '');
    el('skind').value = schedule.kind;
    document.querySelectorAll('input[name="sday"]').forEach((input) => {
        input.checked = schedule.days.includes(Number(input.value));
    });
    el('sdate').value = schedule.date || '';
    el('sstart').value = schedule.start;
    el('send').value = schedule.end;
    showScheduleKind();
    el('schedule-form-title').textContent = 'Edit scheduled message';
    el('save-schedule').textContent = 'Save changes';
    el('cancel-schedule').hidden = false;
    el('stext').focus();
}

function stopEditingSchedule() {
    editingScheduleId = null;
    el('schedule-form').reset();
    select('scolor', COLORS[0][1]);
    select('sicon', '');
    showScheduleKind();
    el('schedule-form-title').textContent = 'Add a scheduled message';
    el('save-schedule').textContent = 'Add to schedule';
    el('cancel-schedule').hidden = true;
}

el('skind').addEventListener('change', showScheduleKind);
el('cancel-schedule').addEventListener('click', stopEditingSchedule);

el('schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const existing = sign.schedules.find((item) => item.id === editingScheduleId);
    const schedule = {
        text: el('stext').value,
        color: selected('scolor'),
        icon: selected('sicon') || null,
        kind: el('skind').value,
        days: [...document.querySelectorAll('input[name="sday"]:checked')].map((input) => Number(input.value)),
        date: el('sdate').value || null,
        start: el('sstart').value,
        end: el('send').value,
        enabled: existing ? existing.enabled : true,
    };
    const data = editingScheduleId === null
        ? await api('POST', `/api/signs/${sign.id}/schedules`, schedule)
        : await api('PUT', `/api/schedules/${editingScheduleId}`, schedule);
    if (updated(data, 'Schedule saved.')) stopEditingSchedule();
});

// ---------- Stream Deck keys ----------

function showKeys() {
    const box = el('keys');
    box.replaceChildren();
    const paragraph = (text) => {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = text;
        box.append(p);
    };
    if (!keysEnabled) {
        paragraph('Keys are switched off. To turn them on, add API_TOKEN to the .env file on the server and redeploy.');
        return;
    }
    paragraph('Each key sends a POST request to its address, with the header "Authorization: Bearer" followed by a space and your API_TOKEN. Preset keys work as toggles: press again to take the message down.');

    const base = `${window.location.origin}/api/keys`;
    const keys = [
        ['Clear message', `${base}/clear`],
        ['Display off / on', `${base}/dark/toggle`],
        ...presets.map((preset) => [`Preset: ${preset.name}`, `${base}/presets/${preset.id}/toggle`]),
    ];
    const list = document.createElement('ul');
    list.className = 'keys';
    for (const [label, address] of keys) {
        const item = document.createElement('li');
        const title = document.createElement('span');
        title.className = 'label';
        title.textContent = label;
        const line = document.createElement('div');
        line.className = 'line';
        const code = document.createElement('code');
        code.textContent = address;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', `Copy address for ${label}`);
        copy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(address);
                setStatus(`Copied the address for "${label}".`);
            } catch {
                setStatus('Could not copy. Select the address and copy it by hand.', true);
            }
        });
        line.append(code, copy);
        item.append(title, line);
        list.append(item);
    }
    box.append(list);
}

// ---------- Firmware ----------

function showFirmware() {
    const running = sign.device.version;
    el('fw-running').textContent = running || (sign.online ? 'an older version that does not report one' : 'unknown while offline');
    el('fw-uploaded').textContent = firmware
        ? `${firmware.version} (${(firmware.size / 1024 / 1024).toFixed(2)} MB, ${new Date(firmware.uploadedAt).toLocaleString()})`
        : 'nothing yet';
    el('firmware-summary').textContent = running || '';
    el('fw-error').hidden = !sign.device.updateError;
    el('fw-error').textContent = sign.device.updateError ? `The last update failed: ${sign.device.updateError}` : '';
    const upToDate = firmware && running === firmware.version;
    el('fw-install').disabled = !firmware || !sign.online || upToDate;
    el('fw-install').textContent = upToDate ? 'The sign is up to date' : 'Install on the sign';
}

el('fw-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = el('fw-file').files[0];
    if (!file) return;
    setStatus('Uploading...');
    try {
        const response = await fetch('/api/firmware', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Firmware-Version': el('fw-version').value.trim() },
            body: file,
        });
        if (response.status === 401) {
            window.location = '/login';
            return;
        }
        if (response.status === 413) {
            setStatus('The server refused the file as too large. Check the Nginx upload limit for /api/firmware.', true);
            return;
        }
        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'The upload did not work. Try again.', true);
            return;
        }
        firmware = data.firmware;
        el('fw-form').reset();
        showFirmware();
        setStatus(`Uploaded firmware ${firmware.version}. Choose "Install on the sign" when you are ready.`);
    } catch {
        setStatus('Could not reach the server. Check your connection and try again.', true);
    }
});

el('fw-install').addEventListener('click', async () => {
    if (!window.confirm(`Install firmware ${firmware.version} on the sign? It will restart.`)) return;
    const data = await api('POST', `/api/signs/${sign.id}/firmware/install`, {});
    if (data) setStatus(`Update sent. The sign downloads it and restarts, which takes about a minute.`);
});

// ---------- Display off and brightness ----------

el('dark').addEventListener('change', async () => {
    const dark = el('dark').checked;
    const ok = updated(await api('PUT', `/api/signs/${sign.id}/dark`, { dark }), dark ? 'Display turned off.' : 'Display turned on.');
    if (!ok) el('dark').checked = !dark;
});

el('brightness').addEventListener('input', () => {
    el('brightness-value').textContent = el('brightness').value;
});

el('brightness').addEventListener('change', async () => {
    const brightness = Number(el('brightness').value);
    updated(await api('PUT', `/api/signs/${sign.id}/brightness`, { brightness }), `Brightness set to ${brightness}.`);
});

// ---------- Default ----------

function showDefaultFields() {
    el('default-message-fields').hidden = selected('dmode') !== 'message';
}

document.querySelectorAll('input[name="dmode"]').forEach((input) => {
    input.addEventListener('change', showDefaultFields);
});

el('default-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = selected('dmode');
    const data = await api('PUT', `/api/signs/${sign.id}/default`, {
        mode,
        text: mode === 'message' ? el('dtext').value : '',
        color: selected('dcolor'),
        icon: mode === 'message' ? (selected('dicon') || null) : null,
    });
    updated(data, 'Default saved.');
});

// ---------- Loading and staying current ----------

// Fetches the latest from the server. Updates the status card only,
// so it never disturbs a form you are filling in.
async function refresh() {
    try {
        const response = await fetch('/api/signs');
        if (!response.ok) return;
        const data = await response.json();
        const latest = data.signs.find((item) => item.id === sign.id);
        firmware = data.firmware;
        if (latest) {
            sign = latest;
            showSign();
        }
    } catch {
        // Ignore; the next check will try again.
    }
}

async function load() {
    const data = await api('GET', '/api/signs');
    if (!data) return;
    sign = data.signs[0];
    presets = data.presets;
    timezone = data.timezone;
    keysEnabled = data.keysEnabled;
    firmware = data.firmware;

    for (const [name, hex] of COLORS) {
        addChoice(el('colors'), 'color', hex, name, hex);
        addChoice(el('dcolors'), 'dcolor', hex, name, hex);
        addChoice(el('scolors'), 'scolor', hex, name, hex);
    }
    for (const [container, group] of [['icons', 'icon'], ['dicons', 'dicon'], ['sicons', 'sicon']]) {
        addChoice(el(container), group, '', 'None');
        for (const icon of data.icons) addChoice(el(container), group, icon, icon);
    }
    // Day checkboxes, Monday first.
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
        const wrapper = document.createElement('label');
        wrapper.className = 'choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'sday';
        input.value = day;
        const span = document.createElement('span');
        span.textContent = DAY_NAMES[day];
        wrapper.append(input, span);
        el('sdays').append(wrapper);
    }
    select('scolor', COLORS[0][1]);
    select('sicon', '');
    showScheduleKind();

    // Start the forms from what the sign already has.
    const custom = sign.settings.custom;
    el('text').value = custom ? custom.text : '';
    if (!custom || !select('color', custom.color)) select('color', COLORS[0][1]);
    select('icon', (custom && custom.icon) || '');

    const fallback = sign.settings.default;
    select('dmode', fallback.mode);
    el('dtext').value = fallback.text;
    if (!select('dcolor', fallback.color)) select('dcolor', COLORS[0][1]);
    select('dicon', fallback.icon || '');
    showDefaultFields();
    showClearInputs();

    showSign();
    showPresets();
    showKeys();

    setInterval(refresh, 10000);
    // Tick the countdown, and fetch the new state once a message runs out.
    setInterval(() => {
        const custom = sign.settings.custom;
        if (custom && custom.expiresAt && Date.parse(custom.expiresAt) <= Date.now()) {
            sign.settings.custom = null;
            setTimeout(refresh, 500);
        }
        showExpiry();
    }, 1000);
}

load();
