// The HTTP request handler. Kept separate from server.js so tests
// can run it without opening a real port's worth of configuration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    SESSION_COOKIE, createLoginLimiter, createSession, parseCookies,
    safeEqual, sessionCookie, verifySession,
} from './auth.js';
import { ICONS, validateState } from './state.js';

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

// hub is the device hub from devices.js. It is optional so the
// HTTP side can be tested without it.
export function createApp({ config, db, hub = null }) {
    const limiter = createLoginLimiter();
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

            // ----- Everything below requires a login -----
            if (!isLoggedIn(req)) {
                if (path.startsWith('/api/')) return sendJson(res, 401, { error: 'Not logged in.' });
                return redirect(res, '/login');
            }

            if (isRead && path === '/') {
                return send(res, 200, 'text/html; charset=utf-8', dashboardPage);
            }
            if (isRead && path === '/api/signs') {
                const signs = db.listSigns().map((sign) => ({
                    ...sign,
                    online: hub ? hub.isOnline(sign.id) : false,
                }));
                return sendJson(res, 200, { signs, icons: ICONS });
            }

            const stateRoute = path.match(/^\/api\/signs\/([a-z0-9-]{1,40})\/state$/);
            if (stateRoute && method === 'PUT') {
                if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden.' });
                let input;
                try {
                    input = JSON.parse(await readBody(req));
                } catch {
                    return sendJson(res, 400, { error: 'Request body must be JSON.' });
                }
                const result = validateState(input);
                if (!result.ok) return sendJson(res, 400, { error: result.error });
                const sign = db.saveState(stateRoute[1], result.state);
                if (!sign) return sendJson(res, 404, { error: 'No sign with that ID.' });
                if (hub) hub.pushState(sign.id, sign.state);
                return sendJson(res, 200, { sign: { ...sign, online: hub ? hub.isOnline(sign.id) : false } });
            }

            if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
            return send(res, 404, 'text/html; charset=utf-8', '<h1>404</h1><p>Page not found.</p>');
        } catch (error) {
            console.error(`${method} ${path} failed:`, error.message);
            if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
        }
    };
}
