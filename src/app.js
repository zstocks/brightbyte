// The HTTP request handler. Kept separate from server.js so tests
// can run it without opening a real port's worth of configuration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    SESSION_COOKIE, createLoginLimiter, createSession, parseCookies,
    safeEqual, sessionCookie, verifySession,
} from './auth.js';
import {
    ICONS, validateBrightness, validateCustom, validateDefault, validatePreset, validateSchedule,
} from './state.js';

const APP_NAME = 'brightbyte';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY_BYTES = 10 * 1024;

// Only these files are ever served. No path from the request touches the disk.
const STATIC_FILES = {
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
}

const sendJson = (res, status, data) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

const redirect = (res, location, headers = {}) =>
    send(res, 303, 'text/plain; charset=utf-8', 'Redirecting', { Location: location, ...headers });

// signs is the service from signs.js; hub is the device hub from
// devices.js, optional so the HTTP side can be tested without it.
export function createApp({ config, db, signs, hub = null }) {
    const limiter = createLoginLimiter();
    const keyLimiter = createLoginLimiter({ maxFailures: 10 });
    const page = (name) => readFileSync(join(PUBLIC_DIR, name), 'utf8');
    const loginPage = page('login.html');
    const dashboardPage = page('index.html');

    const isLoggedIn = (req) =>
        verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], config.sessionSecret);

    // Nginx passes the real client address in X-Real-IP.
    const clientIp = (req) => req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';

    // Blocks cross-site form posts: a browser always sends Origin on
    // POST/PUT, and it must match the host the request was sent to.
    const sameOrigin = (req) => {
        const origin = req.headers.origin;
        if (!origin) return true; // non-browser clients such as curl
        try {
            return new URL(origin).host === req.headers.host;
        } catch {
            return false;
        }
    };

    return async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        const method = req.method;
        const isRead = method === 'GET' || method === 'HEAD';

        try {
            // ----- Public routes -----
            if (isRead && path === '/health') {
                return sendJson(res, 200, { status: 'ok', app: APP_NAME });
            }
            if (isRead && STATIC_FILES[path]) {
                const { file, type } = STATIC_FILES[path];
                return send(res, 200, type, readFileSync(join(PUBLIC_DIR, file)));
            }
            if (isRead && path === '/login') {
                if (isLoggedIn(req)) return redirect(res, '/');
                const message = url.searchParams.has('error')
                    ? '<p class="error" role="alert">That password is not right.</p>'
                    : url.searchParams.has('locked')
                        ? '<p class="error" role="alert">Too many attempts. Try again in 15 minutes.</p>'
                        : '';
                return send(res, 200, 'text/html; charset=utf-8', loginPage.replace('<!--MESSAGE-->', message));
            }
            if (method === 'POST' && path === '/login') {
                if (!sameOrigin(req)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
                const ip = clientIp(req);
                if (limiter.isLocked(ip)) return redirect(res, '/login?locked');
                const form = new URLSearchParams(await readBody(req));
                if (!safeEqual(form.get('password') || '', config.appPassword)) {
                    limiter.recordFailure(ip);
                    return redirect(res, limiter.isLocked(ip) ? '/login?locked' : '/login?error');
                }
                limiter.recordSuccess(ip);
                const cookie = sessionCookie(createSession(config.sessionSecret), { secure: config.secureCookies });
                return redirect(res, '/', { 'Set-Cookie': cookie });
            }
            if (method === 'POST' && path === '/logout') {
                if (!sameOrigin(req)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
                const cookie = sessionCookie('', { secure: config.secureCookies, clear: true });
                return redirect(res, '/login', { 'Set-Cookie': cookie });
            }

            // ----- Keys: for a Stream Deck or a script -----
            // These use "Authorization: Bearer <API_TOKEN>" in place of
            // the login cookie. They are off unless API_TOKEN is set.
            if (path.startsWith('/api/keys/')) {
                if (!config.apiToken) return sendJson(res, 404, { error: 'Not found.' });
                if (method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
                const ip = clientIp(req);
                if (keyLimiter.isLocked(ip)) return sendJson(res, 429, { error: 'Too many failed attempts. Try again later.' });
                const header = req.headers.authorization || '';
                const token = header.startsWith('Bearer ') ? header.slice(7) : '';
                if (!safeEqual(token, config.apiToken)) {
                    keyLimiter.recordFailure(ip);
                    return sendJson(res, 401, { error: 'Missing or wrong token.' });
                }

                const signId = url.searchParams.get('sign') || db.listSigns()[0]?.id;
                const sign = signId ? db.getSign(signId) : null;
                if (!sign) return sendJson(res, 404, { error: 'No sign with that ID.' });
                const done = (updated, action) => sendJson(res, 200, { ok: true, action, showing: updated.state });

                const presetKey = path.match(/^\/api\/keys\/presets\/(\d{1,9})\/(send|toggle)$/);
                if (presetKey) {
                    const preset = db.getPreset(Number(presetKey[1]));
                    if (!preset) return sendJson(res, 404, { error: 'No preset with that ID.' });
                    // toggle: pressing the key again takes the message down.
                    if (presetKey[2] === 'toggle' && signs.isShowingPreset(sign.id, preset)) {
                        return done(signs.clearCustom(sign.id), 'cleared');
                    }
                    return done(signs.sendPreset(sign.id, preset), 'sent');
                }
                if (path === '/api/keys/clear') return done(signs.clearCustom(sign.id), 'cleared');
                const darkKey = path.match(/^\/api\/keys\/dark\/(on|off|toggle)$/);
                if (darkKey) {
                    const dark = darkKey[1] === 'toggle' ? !sign.settings.dark : darkKey[1] === 'on';
                    return done(signs.setDark(sign.id, dark), dark ? 'display off' : 'display on');
                }
                return sendJson(res, 404, { error: 'Not found.' });
            }

            // ----- Everything below requires a login -----
            if (!isLoggedIn(req)) {
                if (path.startsWith('/api/')) return sendJson(res, 401, { error: 'Not logged in.' });
                return redirect(res, '/login');
            }

            if (isRead && path === '/') {
                return send(res, 200, 'text/html; charset=utf-8', dashboardPage);
            }
            if (isRead && path === '/api/signs') {
                return sendJson(res, 200, {
                    signs: db.listSigns().map((sign) => signs.view(sign)),
                    presets: db.listPresets(),
                    icons: ICONS,
                    timezone: config.timezone,
                    keysEnabled: Boolean(config.apiToken),
                });
            }

            // Every route below changes something, so it must come
            // from our own pages and carry a JSON body where needed.
            if (path.startsWith('/api/') && !isRead) {
                if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden.' });
                let body = null;
                if (method !== 'DELETE') {
                    try {
                        body = JSON.parse(await readBody(req));
                    } catch {
                        return sendJson(res, 400, { error: 'Request body must be JSON.' });
                    }
                }
                const changed = (sign) => (sign
                    ? sendJson(res, 200, { sign: signs.view(sign) })
                    : sendJson(res, 404, { error: 'No sign with that ID.' }));

                const signRoute = path.match(/^\/api\/signs\/([a-z0-9-]{1,40})\/(custom|default|dark|brightness)$/);
                if (signRoute) {
                    const [, signId, what] = signRoute;
                    if (what === 'custom' && method === 'PUT') {
                        const result = validateCustom(body);
                        if (!result.ok) return sendJson(res, 400, { error: result.error });
                        return changed(signs.setCustom(signId, result.custom));
                    }
                    if (what === 'custom' && method === 'DELETE') {
                        return changed(signs.clearCustom(signId));
                    }
                    if (what === 'default' && method === 'PUT') {
                        const result = validateDefault(body);
                        if (!result.ok) return sendJson(res, 400, { error: result.error });
                        return changed(signs.setDefault(signId, result.default));
                    }
                    if (what === 'dark' && method === 'PUT') {
                        if (typeof body?.dark !== 'boolean') return sendJson(res, 400, { error: 'dark must be true or false.' });
                        return changed(signs.setDark(signId, body.dark));
                    }
                    if (what === 'brightness' && method === 'PUT') {
                        const result = validateBrightness(body?.brightness);
                        if (!result.ok) return sendJson(res, 400, { error: result.error });
                        return changed(signs.setBrightness(signId, result.brightness));
                    }
                }

                const newSchedule = path.match(/^\/api\/signs\/([a-z0-9-]{1,40})\/schedules$/);
                if (newSchedule && method === 'POST') {
                    const result = validateSchedule(body);
                    if (!result.ok) return sendJson(res, 400, { error: result.error });
                    const schedule = signs.createSchedule(newSchedule[1], result.schedule);
                    if (!schedule) return sendJson(res, 404, { error: 'No sign with that ID.' });
                    return sendJson(res, 201, { sign: signs.view(db.getSign(schedule.signId)) });
                }
                const scheduleRoute = path.match(/^\/api\/schedules\/(\d{1,9})$/);
                if (scheduleRoute && method === 'PUT') {
                    const result = validateSchedule(body);
                    if (!result.ok) return sendJson(res, 400, { error: result.error });
                    const schedule = signs.updateSchedule(Number(scheduleRoute[1]), result.schedule);
                    if (!schedule) return sendJson(res, 404, { error: 'No schedule with that ID.' });
                    return sendJson(res, 200, { sign: signs.view(db.getSign(schedule.signId)) });
                }
                if (scheduleRoute && method === 'DELETE') {
                    const existing = db.getSchedule(Number(scheduleRoute[1]));
                    if (!existing) return sendJson(res, 404, { error: 'No schedule with that ID.' });
                    signs.deleteSchedule(existing.id);
                    return sendJson(res, 200, { sign: signs.view(db.getSign(existing.signId)) });
                }

                if (path === '/api/presets' && method === 'POST') {
                    const result = validatePreset(body);
                    if (!result.ok) return sendJson(res, 400, { error: result.error });
                    return sendJson(res, 201, { preset: db.createPreset(result.preset) });
                }
                const presetRoute = path.match(/^\/api\/presets\/(\d{1,9})$/);
                if (presetRoute && method === 'PUT') {
                    const result = validatePreset(body);
                    if (!result.ok) return sendJson(res, 400, { error: result.error });
                    const preset = db.updatePreset(Number(presetRoute[1]), result.preset);
                    return preset
                        ? sendJson(res, 200, { preset })
                        : sendJson(res, 404, { error: 'No preset with that ID.' });
                }
                if (presetRoute && method === 'DELETE') {
                    return db.deletePreset(Number(presetRoute[1]))
                        ? sendJson(res, 200, { deleted: true })
                        : sendJson(res, 404, { error: 'No preset with that ID.' });
                }
            }

            if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
            return send(res, 404, 'text/html; charset=utf-8', '<h1>404</h1><p>Page not found.</p>');
        } catch (error) {
            console.error(`${method} ${path} failed:`, error.message);
            if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
        }
    };
}
