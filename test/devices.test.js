import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { createDeviceHub } from '../src/devices.js';
import { openDatabase } from '../src/db.js';
import { createSignService } from '../src/signs.js';
import { createSession, SESSION_COOKIE } from '../src/auth.js';

const config = {
    appPassword: 'correct horse',
    sessionSecret: 'a-test-secret-that-is-long-enough-123',
    deviceToken: 'the-device-token',
    apiToken: '',
    timezone: 'America/Denver',
    secureCookies: false,
};

let server, db, hub, signs, port, cookie;

before(async () => {
    db = openDatabase(':memory:');
    hub = createDeviceHub({ config, db, heartbeatMs: 50 });
    signs = createSignService({ db, hub, timezone: 'America/Denver' });
    signs.start();
    server = http.createServer(createApp({ config, db, signs, hub }));
    server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    cookie = `${SESSION_COOKIE}=${createSession(config.sessionSecret)}`;
});

after(() => {
    signs.stop();
    hub.close();
    server.close();
    db.close();
});

// Opens a device connection and collects the messages it receives.
function connect({ token = config.deviceToken, sign = 'desk', path = '/device' } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?sign=${sign}`, {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
    const messages = [];
    const waiters = [];
    ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        while (waiters.length && messages.length) waiters.shift()();
    });
    const next = async () => {
        if (messages.length === 0) await new Promise((resolve) => waiters.push(resolve));
        return messages.shift();
    };
    const opened = new Promise((resolve, reject) => {
        ws.on('open', () => resolve('open'));
        ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
        ws.on('error', reject);
    });
    return { ws, next, opened };
}

const put = (what, body) => fetch(`http://127.0.0.1:${port}/api/signs/desk/${what}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

test('a sign with the wrong token is refused', async () => {
    assert.equal(await connect({ token: 'wrong' }).opened, 401);
    assert.equal(await connect({ token: null }).opened, 401);
});

test('an unknown sign or path is refused', async () => {
    assert.equal(await connect({ sign: 'nope' }).opened, 404);
    assert.equal(await connect({ path: '/elsewhere' }).opened, 404);
});

test('a sign gets its state on connect and again on every change', async () => {
    const device = connect();
    assert.equal(await device.opened, 'open');

    const first = await device.next();
    assert.equal(first.type, 'state');
    assert.equal(first.state.mode, 'clock');
    assert.equal(hub.isOnline('desk'), true);

    const response = await put('custom', { text: 'Busy', color: '#ff1e1e', icon: 'dnd', expiresAt: null });
    assert.equal((await response.json()).sign.online, true);
    assert.deepEqual(await device.next(), {
        type: 'state',
        state: { mode: 'message', text: 'Busy', color: '#ff1e1e', icon: 'dnd', brightness: 30 },
    });

    device.ws.close();
    await new Promise((resolve) => device.ws.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hub.isOnline('desk'), false);
});

test('a sign that reconnects later gets the latest state', async () => {
    await put('dark', { dark: true });
    const device = connect();
    await device.opened;
    assert.equal((await device.next()).state.mode, 'dark');
    device.ws.close();
});

test('a connection that stops answering pings is dropped', async () => {
    const device = connect();
    await device.opened;
    await device.next();
    device.ws.pong = () => {};          // stop answering
    device.ws._receiver.removeAllListeners('ping');
    await new Promise((resolve) => device.ws.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hub.isOnline('desk'), false);
});

test('the sign list reports online status', async () => {
    const offline = await (await fetch(`http://127.0.0.1:${port}/api/signs`, { headers: { Cookie: cookie } })).json();
    assert.equal(offline.signs[0].online, false);
    const device = connect();
    await device.opened;
    await device.next();
    const online = await (await fetch(`http://127.0.0.1:${port}/api/signs`, { headers: { Cookie: cookie } })).json();
    assert.equal(online.signs[0].online, true);
    device.ws.close();
});
