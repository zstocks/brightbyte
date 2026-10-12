import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const config = {
    appPassword: 'correct horse',
    sessionSecret: 'a-test-secret-that-is-long-enough-123',
    deviceToken: 'device',
    secureCookies: false,
};

let server;
let base;
let db;

before(async () => {
    db = openDatabase(':memory:');
    server = http.createServer(createApp({ config, db }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
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
    const cookie = response.headers.get('set-cookie');
    return { response, cookie: cookie ? cookie.split(';')[0] : null };
}

test('health is public', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', app: 'brightbyte' });
});

test('the dashboard redirects to login when logged out', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
});

test('the API returns 401 when logged out', async () => {
    assert.equal((await fetch(`${base}/api/signs`)).status, 401);
    const put = await fetch(`${base}/api/signs/desk/state`, { method: 'PUT', body: '{}' });
    assert.equal(put.status, 401);
});

test('a wrong password does not log in', async () => {
    const { response, cookie } = await login('nope', '203.0.113.2');
    assert.equal(response.headers.get('location'), '/login?error');
    assert.equal(cookie, null);
});

test('repeated wrong passwords lock that address only', async () => {
    for (let i = 0; i < 5; i++) await login('nope', '203.0.113.3');
    const locked = await login(config.appPassword, '203.0.113.3');
    assert.equal(locked.response.headers.get('location'), '/login?locked');
    assert.equal(locked.cookie, null);
    const other = await login(config.appPassword, '203.0.113.4');
    assert.equal(other.response.headers.get('location'), '/');
});

test('logging in allows reading and saving state', async () => {
    const { cookie } = await login();
    assert.ok(cookie);

    const list = await (await fetch(`${base}/api/signs`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.signs.length, 1);
    assert.equal(list.signs[0].id, 'desk');
    assert.equal(list.signs[0].state.mode, 'clock');

    const saved = await fetch(`${base}/api/signs/desk/state`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'message', text: 'Busy', color: '#ff1e1e', icon: 'dnd' }),
    });
    assert.equal(saved.status, 200);
    assert.equal(db.getSign('desk').state.text, 'Busy');
});

test('saving rejects invalid state, unknown signs and bad JSON', async () => {
    const { cookie } = await login();
    const put = (id, body) => fetch(`${base}/api/signs/${id}/state`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body,
    });
    assert.equal((await put('desk', JSON.stringify({ mode: 'party' }))).status, 400);
    assert.equal((await put('desk', 'not json')).status, 400);
    assert.equal((await put('nope', JSON.stringify({ mode: 'clock' }))).status, 404);
});

test('requests from another origin are refused', async () => {
    const { cookie } = await login();
    const response = await fetch(`${base}/api/signs/desk/state`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ mode: 'dark' }),
    });
    assert.equal(response.status, 403);
});

test('oversized bodies are refused', async () => {
    const { cookie } = await login();
    const response = await fetch(`${base}/api/signs/desk/state`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'message', text: 'x'.repeat(20000) }),
    }).catch(() => ({ status: 'connection closed' }));
    assert.notEqual(response.status, 200);
});
