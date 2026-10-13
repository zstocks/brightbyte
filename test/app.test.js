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
    secureCookies: false,
};

let server, base, db, signs, cookie;

before(async () => {
    db = openDatabase(':memory:');
    signs = createSignService({ db });
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
