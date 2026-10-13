import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { createDeviceHub } from '../src/devices.js';
import { createFirmwareStore, MAX_FIRMWARE_BYTES, validateFirmware } from '../src/firmware.js';
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

// A stand-in for a real firmware file: right first byte, plausible size.
function fakeFirmware(size = 200 * 1024, fill = 7) {
    const buffer = Buffer.alloc(size, fill);
    buffer[0] = 0xE9;
    return buffer;
}

let dir, db, hub, signs, firmware, server, base, port, cookie;

before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brightbyte-fw-'));
    db = openDatabase(':memory:');
    hub = createDeviceHub({ config, db });
    signs = createSignService({ db, hub, timezone: config.timezone });
    signs.start();
    firmware = createFirmwareStore(dir);
    server = http.createServer(createApp({ config, db, signs, hub, firmware }));
    server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
    cookie = `${SESSION_COOKIE}=${createSession(config.sessionSecret)}`;
});

after(() => {
    signs.stop();
    hub.close();
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

const upload = (bytes, version, headers = {}) => fetch(`${base}/api/firmware`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Firmware-Version': version, ...headers },
    body: bytes,
}).then(async (response) => ({ status: response.status, data: await response.json() }));

const install = () => fetch(`${base}/api/signs/desk/firmware/install`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
}).then(async (response) => ({ status: response.status, data: await response.json() }));

const listSigns = () => fetch(`${base}/api/signs`, { headers: { Cookie: cookie } }).then((response) => response.json());

function connectSign() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?sign=desk`, {
        headers: { Authorization: `Bearer ${config.deviceToken}` },
    });
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    const opened = new Promise((resolve) => ws.on('open', resolve));
    const until = async (type) => {
        for (let i = 0; i < 100; i++) {
            const found = messages.find((message) => message.type === type);
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`no "${type}" message arrived`);
    };
    return { ws, opened, until };
}

test('validateFirmware checks the version, size and file type', () => {
    assert.equal(validateFirmware(fakeFirmware(), '1.8.0').ok, true);
    assert.equal(validateFirmware(fakeFirmware(), '').ok, false);
    assert.equal(validateFirmware(fakeFirmware(), 'has spaces').ok, false);
    assert.equal(validateFirmware(fakeFirmware(), 'x'.repeat(33)).ok, false);
    assert.equal(validateFirmware(fakeFirmware(1024), '1.8.0').ok, false);                    // too small
    assert.equal(validateFirmware(fakeFirmware(MAX_FIRMWARE_BYTES + 1), '1.8.0').ok, false);  // too large
    assert.equal(validateFirmware(Buffer.alloc(200 * 1024, 7), '1.8.0').ok, false);           // wrong first byte
    assert.equal(validateFirmware('not a buffer', '1.8.0').ok, false);
});

test('nothing is uploaded at first', async () => {
    assert.equal((await listSigns()).firmware, null);
    assert.equal((await install()).status, 400);
    const download = await fetch(`${base}/api/device/firmware`, { headers: { Authorization: `Bearer ${config.deviceToken}` } });
    assert.equal(download.status, 404);
});

test('uploading needs a login and a valid file', async () => {
    const loggedOut = await fetch(`${base}/api/firmware`, { method: 'POST', body: fakeFirmware() });
    assert.equal(loggedOut.status, 401);
    assert.equal((await upload(Buffer.from('hello'), '1.8.0')).status, 400);
    assert.equal((await upload(fakeFirmware(), 'bad version!')).status, 400);
    assert.equal((await upload(fakeFirmware(), '1.8.0', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await listSigns()).firmware, null);
});

test('a file over the upload limit is refused', async () => {
    const result = await upload(fakeFirmware(3 * 1024 * 1024), '1.8.0').catch(() => ({ status: 'connection closed' }));
    assert.notEqual(result.status, 201);
});

test('an uploaded file can be downloaded by the sign, byte for byte', async () => {
    const bytes = fakeFirmware(300 * 1024, 42);
    const result = await upload(bytes, '1.8.1');
    assert.equal(result.status, 201);
    const md5 = createHash('md5').update(bytes).digest('hex');
    assert.deepEqual([result.data.firmware.version, result.data.firmware.size, result.data.firmware.md5], ['1.8.1', bytes.length, md5]);
    assert.equal((await listSigns()).firmware.version, '1.8.1');

    const download = await fetch(`${base}/api/device/firmware?sign=desk`, { headers: { Authorization: `Bearer ${config.deviceToken}` } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-length'), String(bytes.length));
    assert.equal(Buffer.from(await download.arrayBuffer()).equals(bytes), true);
});

test('the download needs the device token', async () => {
    assert.equal((await fetch(`${base}/api/device/firmware`)).status, 401);
    assert.equal((await fetch(`${base}/api/device/firmware`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/api/device/firmware`, { headers: { Cookie: cookie } })).status, 401);
});

test('a newer upload replaces the older one', async () => {
    await upload(fakeFirmware(250 * 1024, 9), '1.8.2');
    assert.equal(firmware.info().version, '1.8.2');
    assert.equal(firmware.info().size, 250 * 1024);
});

test('installing fails while the sign is offline', async () => {
    assert.equal((await install()).status, 409);
});

test('a sign reports its version and is told to update', async () => {
    const sign = connectSign();
    await sign.opened;
    sign.ws.send(JSON.stringify({ type: 'hello', version: '1.8.0' }));
    await sign.until('state');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await listSigns()).signs[0].device.version, '1.8.0');

    const result = await install();
    assert.deepEqual([result.status, result.data.version], [200, '1.8.2']);
    const update = await sign.until('update');
    assert.deepEqual([update.version, update.size, update.md5], ['1.8.2', firmware.info().size, firmware.info().md5]);
    sign.ws.close();
});

test('a sign can report why an update failed, and junk is ignored', async () => {
    const sign = connectSign();
    await sign.opened;
    sign.ws.send('not json');
    sign.ws.send(JSON.stringify({ type: 'mystery' }));
    sign.ws.send(JSON.stringify({ type: 'hello', version: '1.8.0', updateError: 'server answered 404' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const device = (await listSigns()).signs[0].device;
    assert.deepEqual(device, { version: '1.8.0', updateError: 'server answered 404' });
    sign.ws.close();
});
