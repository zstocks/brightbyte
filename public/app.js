// Dashboard script. Talks to the JSON API and keeps the page in
// step with what the server has saved.

// These match the named colors in the firmware.
const COLORS = [
    ['Blue', '#0096ff'], ['Red', '#ff1e1e'], ['Green', '#00dc3c'],
    ['White', '#dcdcdc'], ['Yellow', '#ffc800'], ['Orange', '#ff6e00'],
    ['Purple', '#aa3cff'], ['Cyan', '#00dcdc'], ['Pink', '#ff50a0'],
];

const el = (id) => document.getElementById(id);
let sign = null; // the sign being controlled; one for now

function setStatus(message, isError = false) {
    el('status').textContent = message;
    el('status').classList.toggle('error', isError);
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

function describe(state) {
    if (state.mode === 'clock') return 'Clock';
    if (state.mode === 'dark') return 'Display off';
    return state.icon ? `"${state.text}" with ${state.icon} icon` : `"${state.text}"`;
}

function selected(group) {
    const input = document.querySelector(`input[name="${group}"]:checked`);
    return input ? input.value : null;
}

function select(group, value) {
    const input = document.querySelector(`input[name="${group}"][value="${value}"]`);
    if (input) input.checked = true;
}

function showSign() {
    el('sign-name').textContent = sign.name;
    el('now-showing').textContent = describe(sign.state);
    el('updated').textContent = `Last changed ${new Date(sign.updatedAt).toLocaleString()}`;
    showOnline(sign.online);
}

function showOnline(online) {
    el('online').textContent = online ? 'Sign online' : 'Sign offline';
    el('online').className = `badge ${online ? 'online' : 'offline'}`;
}

// Re-checks every 10 seconds whether the sign is connected.
async function refreshOnline() {
    try {
        const response = await fetch('/api/signs');
        if (!response.ok) return;
        const data = await response.json();
        const latest = data.signs.find((item) => item.id === sign.id);
        if (latest) showOnline(latest.online);
    } catch {
        // Ignore; the next check will try again.
    }
}

async function saveState(state) {
    setStatus('Saving...');
    try {
        const response = await fetch(`/api/signs/${sign.id}/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state),
        });
        if (response.status === 401) {
            window.location = '/login';
            return;
        }
        const data = await response.json();
        if (!response.ok) {
            setStatus(data.error || 'Could not save.', true);
            return;
        }
        sign = data.sign;
        showSign();
        setStatus(sign.online ? 'Sent to the sign.' : 'Saved. The sign is offline and will show this when it reconnects.');
    } catch {
        setStatus('Could not reach the server. Check your connection and try again.', true);
    }
}

async function load() {
    try {
        const response = await fetch('/api/signs');
        if (response.status === 401) {
            window.location = '/login';
            return;
        }
        const data = await response.json();
        sign = data.signs[0];

        for (const [name, hex] of COLORS) addChoice(el('colors'), 'color', hex, name, hex);
        addChoice(el('icons'), 'icon', '', 'None');
        for (const icon of data.icons) addChoice(el('icons'), 'icon', icon, icon);

        // Start the form from whatever the sign last had.
        el('text').value = sign.state.text;
        select('color', sign.state.color);
        if (!selected('color')) select('color', COLORS[0][1]);
        select('icon', sign.state.icon || '');
        showSign();
        setInterval(refreshOnline, 10000);
    } catch {
        setStatus('Could not load the sign. Refresh the page to try again.', true);
    }
}

el('message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveState({
        mode: 'message',
        text: el('text').value,
        color: selected('color'),
        icon: selected('icon') || null,
    });
});

// Clock and dark keep the current text, color and icon, so the
// message form still shows them next time.
el('show-clock').addEventListener('click', () => saveState({ ...sign.state, mode: 'clock' }));
el('go-dark').addEventListener('click', () => saveState({ ...sign.state, mode: 'dark' }));

load();
