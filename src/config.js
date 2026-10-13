// Reads and checks configuration from environment variables.
// Secrets live in .env only and are never committed.

import { isValidTimezone } from './schedule.js';

const REQUIRED = ['APP_PASSWORD', 'SESSION_SECRET', 'DEVICE_TOKEN'];

export function validateConfig(env = process.env) {
    const missing = REQUIRED.filter((name) => !env[name] || env[name].trim() === '');
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    if (env.SESSION_SECRET.length < 32) {
        console.error('SESSION_SECRET must be at least 32 characters.');
        process.exit(1);
    }
    const timezone = env.TIMEZONE || 'America/Denver';
    if (!isValidTimezone(timezone)) {
        console.error(`TIMEZONE "${timezone}" is not a valid timezone name.`);
        process.exit(1);
    }
    return {
        appPassword: env.APP_PASSWORD,
        sessionSecret: env.SESSION_SECRET,
        deviceToken: env.DEVICE_TOKEN, // the sign presents this when it connects
        // Optional. Lets a Stream Deck or script press "keys". If it
        // is not set, the key routes are switched off.
        apiToken: (env.API_TOKEN || '').trim(),
        // Scheduled messages use this timezone's wall-clock time.
        timezone,
        port: 3000,
        dataDir: env.DATA_DIR || './data',
        // Set INSECURE_COOKIES=1 only for local development over plain http.
        secureCookies: env.INSECURE_COOKIES !== '1',
    };
}
