import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createSignService } from '../src/signs.js';

const config = {
    appPassword: 'correct horse',
    sessionSecret: 'a-test-secret-that-is-long-enough-123',
    deviceToken: 'device',
    apiToken: 'the-key-token',
    timezone: 'America/Denver',
    secureCookies: false,
};

let server, base, db, signs, cookie;

before(async () => {
    db = openDatabase(':memory:');
    signs = createSignService({ db, timezone: config.timezone });
    signs.start();
    server = http.createServer(createApp({ config, db, signs }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    cookie = (await login()).cookie;
});

after(() => {
    signs.stop();
    server.close();
    db.close();
});

async function login(password = config.appPassword, ip = '203.0.113.1') {
    const response = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Real-IP': ip },
        body: new URLSearchParams({ password }),
    });
    const header = response.headers.get('set-cookie');
    return { response, cookie: header ? header.split(';')[0] : null };
}

// Calls the API as a logged-in browser.
async function call(method, path, body, headers = {}) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return { status: response.status, data: await response.json() };
}

test('health is public', async () => {
    const response = await fetch(`${base}/health`);
    assert.deepEqual(await response.json(), { status: 'ok', app: 'brightbyte' });
});

test('the dashboard redirects to login when logged out', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
});

test('the API returns 401 when logged out', async () => {
    assert.equal((await fetch(`${base}/api/signs`)).status, 401);
    for (const [method, path] of [
        ['PUT', '/api/signs/desk/custom'], ['DELETE', '/api/signs/desk/custom'],
        ['PUT', '/api/signs/desk/dark'], ['POST', '/api/presets'], ['DELETE', '/api/presets/1'],
    ]) {
        assert.equal((await fetch(`${base}${path}`, { method, body: method === 'DELETE' ? undefined : '{}' })).status, 401, path);
    }
});

test('a wrong password does not log in', async () => {
    const { response, cookie: none } = await login('nope', '203.0.113.2');
    assert.equal(response.headers.get('location'), '/login?error');
    assert.equal(none, null);
});

test('repeated wrong passwords lock that address only', async () => {
    for (let i = 0; i < 5; i++) await login('nope', '203.0.113.3');
    assert.equal((await login(config.appPassword, '203.0.113.3')).response.headers.get('location'), '/login?locked');
    assert.equal((await login(config.appPassword, '203.0.113.4')).response.headers.get('location'), '/');
});

test('the sign list includes settings, the current state and presets', async () => {
    const { data } = await call('GET', '/api/signs');
    assert.equal(data.signs[0].id, 'desk');
    assert.equal(data.signs[0].state.mode, 'clock');
    assert.equal(data.signs[0].settings.brightness, 30);
    assert.equal(data.signs[0].online, false);
    assert.deepEqual(data.presets, []);
    assert.ok(data.icons.includes('dnd'));
    assert.equal(data.timezone, 'America/Denver');
    assert.equal(data.keysEnabled, true);
    assert.deepEqual([data.signs[0].source, data.signs[0].schedules], ['default', []]);
});

test('sending and clearing a custom message', async () => {
    const sent = await call('PUT', '/api/signs/desk/custom', { text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt: null });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.sign.state.text, 'Busy');
    const cleared = await call('DELETE', '/api/signs/desk/custom');
    assert.equal(cleared.data.sign.state.mode, 'clock');
    assert.equal(cleared.data.sign.settings.custom, null);
});

test('a custom message with a past clear time is rejected', async () => {
    const result = await call('PUT', '/api/signs/desk/custom', { text: 'Late', expiresAt: '2020-01-01T00:00:00Z' });
    assert.equal(result.status, 400);
});

test('default, dark and brightness can be set', async () => {
    const fallback = await call('PUT', '/api/signs/desk/default', { mode: 'message', text: 'Welcome', color: '#00dc3c', icon: 'smiley' });
    assert.equal(fallback.data.sign.state.text, 'Welcome');
    assert.equal((await call('PUT', '/api/signs/desk/dark', { dark: true })).data.sign.state.mode, 'dark');
    assert.equal((await call('PUT', '/api/signs/desk/dark', { dark: false })).data.sign.state.mode, 'message');
    assert.equal((await call('PUT', '/api/signs/desk/brightness', { brightness: 55 })).data.sign.state.brightness, 55);
    await call('PUT', '/api/signs/desk/default', { mode: 'clock' });
});

test('invalid settings are rejected', async () => {
    assert.equal((await call('PUT', '/api/signs/desk/dark', { dark: 'yes' })).status, 400);
    assert.equal((await call('PUT', '/api/signs/desk/brightness', { brightness: 0 })).status, 400);
    assert.equal((await call('PUT', '/api/signs/desk/brightness', {})).status, 400);
    assert.equal((await call('PUT', '/api/signs/desk/default', { mode: 'dark' })).status, 400);
    assert.equal((await call('PUT', '/api/signs/desk/custom', 'not json')).status, 400);
    assert.equal((await call('PUT', '/api/signs/nope/dark', { dark: true })).status, 404);
    assert.equal((await call('PUT', '/api/signs/desk/unknown', {})).status, 404);
});

test('presets can be created, listed, updated and deleted', async () => {
    const created = await call('POST', '/api/presets', { name: 'Lunch', text: 'At lunch', color: '#ffc800', icon: 'coffee', minutes: 60 });
    assert.equal(created.status, 201);
    const id = created.data.preset.id;
    assert.equal(created.data.preset.minutes, 60);

    await call('POST', '/api/presets', { name: 'busy', text: 'Busy', color: '#ff1e1e', icon: 'dnd', minutes: null });
    const listed = (await call('GET', '/api/signs')).data.presets;
    assert.deepEqual(listed.map((preset) => preset.name), ['busy', 'Lunch']); // sorted, ignoring case

    const changed = await call('PUT', `/api/presets/${id}`, { name: 'Lunch', text: 'Out to lunch', color: '#ffc800', icon: null, minutes: 45 });
    assert.equal(changed.data.preset.text, 'Out to lunch');
    assert.equal(changed.data.preset.icon, null);

    assert.equal((await call('DELETE', `/api/presets/${id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/presets/${id}`)).status, 404);
    assert.equal((await call('PUT', `/api/presets/${id}`, { name: 'x', text: 'x' })).status, 404);
    assert.equal((await call('POST', '/api/presets', { name: '', text: 'x' })).status, 400);
});

test('requests from another origin are refused', async () => {
    const result = await call('PUT', '/api/signs/desk/dark', { dark: true }, { Origin: 'https://evil.example' });
    assert.equal(result.status, 403);
    assert.equal((await call('GET', '/api/signs')).data.signs[0].settings.dark, false);
});

test('oversized bodies are refused', async () => {
    const response = await fetch(`${base}/api/signs/desk/custom`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(20000) }),
    }).catch(() => ({ status: 'connection closed' }));
    assert.notEqual(response.status, 200);
});

test('schedules can be created, updated and deleted', async () => {
    const body = { text: 'Standup', color: '#00dc3c', icon: 'mic', kind: 'weekly', days: [1, 3], start: '09:00', end: '09:15' };
    const created = await call('POST', '/api/signs/desk/schedules', body);
    assert.equal(created.status, 201);
    const schedule = created.data.sign.schedules[0];
    assert.deepEqual([schedule.text, schedule.days, schedule.enabled], ['Standup', [1, 3], true]);

    const changed = await call('PUT', `/api/schedules/${schedule.id}`, { ...body, enabled: false, end: '09:30' });
    assert.deepEqual([changed.data.sign.schedules[0].enabled, changed.data.sign.schedules[0].end], [false, '09:30']);

    assert.equal((await call('POST', '/api/signs/desk/schedules', { ...body, days: [] })).status, 400);
    assert.equal((await call('POST', '/api/signs/nope/schedules', body)).status, 404);
    assert.equal((await call('PUT', '/api/schedules/999', body)).status, 404);

    const removed = await call('DELETE', `/api/schedules/${schedule.id}`);
    assert.deepEqual(removed.data.sign.schedules, []);
    assert.equal((await call('DELETE', `/api/schedules/${schedule.id}`)).status, 404);
});

// ----- Keys (Stream Deck) -----

const key = (path, token = config.apiToken, ip = '198.51.100.1', method = 'POST') => fetch(`${base}/api/keys/${path}`, {
    method,
    headers: { 'X-Real-IP': ip, ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
}).then(async (response) => ({ status: response.status, data: await response.json() }));

test('keys need the API token, not the login cookie', async () => {
    assert.equal((await key('clear', null)).status, 401);
    assert.equal((await key('clear', 'wrong')).status, 401);
    assert.equal((await key('clear', config.deviceToken)).status, 401);
    const withCookie = await fetch(`${base}/api/keys/clear`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(withCookie.status, 401);
    assert.equal((await key('clear', config.apiToken, '198.51.100.1', 'GET')).status, 405);
});

test('a preset key toggles its message on and off', async () => {
    const { data } = await call('POST', '/api/presets', { name: 'Key test', text: 'On air', color: '#ff1e1e', icon: 'mic', minutes: 30 });
    const id = data.preset.id;

    const on = await key(`presets/${id}/toggle`);
    assert.deepEqual([on.status, on.data.action, on.data.showing.text], [200, 'sent', 'On air']);
    const off = await key(`presets/${id}/toggle`);
    assert.deepEqual([off.data.action, off.data.showing.mode], ['cleared', 'clock']);

    await key(`presets/${id}/send`);
    const again = await key(`presets/${id}/send`);                 // send never clears
    assert.equal(again.data.showing.text, 'On air');
    assert.equal((await key('clear')).data.showing.mode, 'clock');
    assert.equal((await key('presets/999/toggle')).status, 404);
    await call('DELETE', `/api/presets/${id}`);
});

test('the dark keys switch the display', async () => {
    assert.equal((await key('dark/toggle')).data.showing.mode, 'dark');
    assert.equal((await key('dark/toggle')).data.showing.mode, 'clock');
    assert.equal((await key('dark/on')).data.action, 'display off');
    assert.equal((await key('dark/off')).data.showing.mode, 'clock');
    assert.equal((await key('dark/sideways')).status, 404);
    assert.equal((await key('clear?sign=nope')).status, 404);
});

test('repeated wrong key tokens lock that address out', async () => {
    for (let i = 0; i < 10; i++) await key('clear', 'wrong', '198.51.100.7');
    assert.equal((await key('clear', config.apiToken, '198.51.100.7')).status, 429);
    assert.equal((await key('clear', config.apiToken, '198.51.100.8')).status, 200);
});

test('keys are switched off when no API token is configured', async () => {
    const off = http.createServer(createApp({ config: { ...config, apiToken: '' }, db, signs }));
    await new Promise((resolve) => off.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${off.address().port}/api/keys/clear`, {
        method: 'POST', headers: { Authorization: 'Bearer ' },
    });
    assert.equal(response.status, 404);
    off.close();
});
