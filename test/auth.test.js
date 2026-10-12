import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SESSION_TTL_MS, createLoginLimiter, createSession, parseCookies,
    safeEqual, verifySession,
} from '../src/auth.js';

const SECRET = 'a-test-secret-that-is-long-enough-123';

test('safeEqual compares values of any length', () => {
    assert.equal(safeEqual('hunter2', 'hunter2'), true);
    assert.equal(safeEqual('hunter2', 'hunter3'), false);
    assert.equal(safeEqual('short', 'a much longer value'), false);
    assert.equal(safeEqual('', ''), true);
});

test('a fresh session verifies', () => {
    assert.equal(verifySession(createSession(SECRET), SECRET), true);
});

test('a session fails with the wrong secret', () => {
    assert.equal(verifySession(createSession(SECRET), 'another-secret-that-is-also-long-456'), false);
});

test('a session expires', () => {
    const now = 1_000_000;
    const token = createSession(SECRET, now);
    assert.equal(verifySession(token, SECRET, now + SESSION_TTL_MS - 1), true);
    assert.equal(verifySession(token, SECRET, now + SESSION_TTL_MS + 1), false);
});

test('a tampered expiry is rejected', () => {
    const token = createSession(SECRET, 1_000_000);
    const signature = token.slice(token.indexOf('.') + 1);
    assert.equal(verifySession(`99999999999999.${signature}`, SECRET, 2_000_000), false);
});

test('malformed tokens are rejected', () => {
    for (const bad of [undefined, null, '', 'nodot', '.', '.abc', 'abc.', 123]) {
        assert.equal(verifySession(bad, SECRET), false);
    }
});

test('parseCookies reads a cookie header', () => {
    assert.deepEqual(parseCookies('a=1; b=two; c=x=y'), { a: '1', b: 'two', c: 'x=y' });
    assert.deepEqual(parseCookies(undefined), {});
});

test('the login limiter locks after repeated failures and unlocks later', () => {
    const limiter = createLoginLimiter({ maxFailures: 3, lockMs: 1000 });
    const ip = '203.0.113.5';
    limiter.recordFailure(ip, 0);
    limiter.recordFailure(ip, 0);
    assert.equal(limiter.isLocked(ip, 0), false);
    limiter.recordFailure(ip, 0);
    assert.equal(limiter.isLocked(ip, 500), true);
    assert.equal(limiter.isLocked('198.51.100.9', 500), false);
    assert.equal(limiter.isLocked(ip, 1001), false);
});

test('a successful login clears earlier failures', () => {
    const limiter = createLoginLimiter({ maxFailures: 2, lockMs: 1000 });
    limiter.recordFailure('ip', 0);
    limiter.recordSuccess('ip');
    limiter.recordFailure('ip', 0);
    assert.equal(limiter.isLocked('ip', 0), false);
});
