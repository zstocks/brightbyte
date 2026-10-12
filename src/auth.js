// Single-user auth: one password, and a signed cookie that proves
// the browser has logged in. No session storage is needed because
// the cookie carries its own expiry and an HMAC signature.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'brightbyte_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Constant-time comparison. Hashing first gives both sides the same
// length, which timingSafeEqual requires.
export function safeEqual(a, b) {
    const ha = createHash('sha256').update(String(a)).digest();
    const hb = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ha, hb);
}

function sign(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSession(secret, now = Date.now()) {
    const expires = String(now + SESSION_TTL_MS);
    return `${expires}.${sign(expires, secret)}`;
}

export function verifySession(token, secret, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const expires = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!safeEqual(signature, sign(expires, secret))) return false;
    const expiresAt = Number(expires);
    return Number.isFinite(expiresAt) && expiresAt > now;
}

export function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return cookies;
}

export function sessionCookie(token, { secure = true, clear = false } = {}) {
    const parts = [
        `${SESSION_COOKIE}=${clear ? '' : token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${clear ? 0 : Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

// Slows down password guessing: after 5 failures from one address,
// that address is locked out for 15 minutes.
export function createLoginLimiter({ maxFailures = 5, lockMs = 15 * 60 * 1000 } = {}) {
    const attempts = new Map();
    return {
        isLocked(ip, now = Date.now()) {
            const entry = attempts.get(ip);
            if (!entry) return false;
            if (entry.lockedUntil > now) return true;
            if (entry.lockedUntil !== 0) attempts.delete(ip);
            return false;
        },
        recordFailure(ip, now = Date.now()) {
            const entry = attempts.get(ip) || { failures: 0, lockedUntil: 0 };
            entry.failures += 1;
            if (entry.failures >= maxFailures) entry.lockedUntil = now + lockMs;
            attempts.set(ip, entry);
        },
        recordSuccess(ip) {
            attempts.delete(ip);
        },
    };
}
