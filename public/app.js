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
    el('clear-now').hidden = !active;
    if (!active) {
        el('expiry').textContent = '';
    } else if (custom.expiresAt === null) {
        el('expiry').textContent = 'Stays until you clear it.';
    } else {
        el('expiry').textContent = `Clears in ${formatRemaining(Date.parse(custom.expiresAt) - Date.now())}.`;
    }
    if (active && sign.settings.dark) {
        el('expiry').textContent += ` Hidden while the display is off: "${custom.text}".`;
    }
}

function showSign() {
    el('sign-name').textContent = sign.name;
    el('now-showing').textContent = describe(sign.state);
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
    setStatus(`Saved preset "${data.preset.name}".`);
    stopEditing();
}

async function deletePreset(preset) {
    if (!window.confirm(`Delete the preset "${preset.name}"?`)) return;
    const data = await api('DELETE', `/api/presets/${preset.id}`);
    if (!data) return;
    presets = presets.filter((item) => item.id !== preset.id);
    showPresets();
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
    });
    updated(data, 'Sent to the sign.');
});

el('clear').addEventListener('change', showClearInputs);
el('save-preset').addEventListener('click', savePreset);
el('cancel-edit').addEventListener('click', stopEditing);

el('clear-now').addEventListener('click', async () => {
    updated(await api('DELETE', `/api/signs/${sign.id}/custom`), 'Message cleared.');
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

    for (const [name, hex] of COLORS) {
        addChoice(el('colors'), 'color', hex, name, hex);
        addChoice(el('dcolors'), 'dcolor', hex, name, hex);
    }
    addChoice(el('icons'), 'icon', '', 'None');
    addChoice(el('dicons'), 'dicon', '', 'None');
    for (const icon of data.icons) {
        addChoice(el('icons'), 'icon', icon, icon);
        addChoice(el('dicons'), 'dicon', icon, icon);
    }

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
