// Keeps track of the signs that are connected over WebSocket and
// pushes each one its display state.
//
// A sign connects to wss://<host>/device?sign=<id> with the header
// "Authorization: Bearer <DEVICE_TOKEN>". It is sent its current
// state straight away, and again every time the state changes.
//
// The sign sends one kind of message back:
//   {"type":"hello","version":"1.8.0","updateError":"..."}
// when it connects, saying which firmware it runs and, if its last
// update attempt failed, why.

import { WebSocketServer } from 'ws';
import { safeEqual } from './auth.js';

const HEARTBEAT_MS = 30 * 1000;

export function createDeviceHub({ config, db, heartbeatMs = HEARTBEAT_MS }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    const connections = new Map(); // sign ID -> Set of sockets
    const reported = new Map();    // sign ID -> { version, updateError }

    const stateMessage = (state) => JSON.stringify({ type: 'state', state });

    function refuse(socket, status, reason) {
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
    }

    function register(ws, signId) {
        if (!connections.has(signId)) connections.set(signId, new Set());
        connections.get(signId).add(ws);
        ws.isAlive = true;
        console.log(`Sign "${signId}" connected`);

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (data) => {
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return; // not JSON; ignore
            }
            if (message?.type !== 'hello') return;
            const clean = (value) => (typeof value === 'string' ? value.slice(0, 120) : null);
            reported.set(signId, { version: clean(message.version), updateError: clean(message.updateError) });
            if (message.updateError) console.error(`Sign "${signId}" update failed: ${clean(message.updateError)}`);
        });
        ws.on('error', (error) => console.error(`Sign "${signId}" socket error:`, error.message));
        ws.on('close', () => {
            connections.get(signId)?.delete(ws);
            console.log(`Sign "${signId}" disconnected`);
        });

        const sign = db.getSign(signId);
        if (sign) ws.send(stateMessage(sign.state));
    }

    // Drops connections that have stopped answering, such as a sign
    // that lost power without closing its socket.
    const heartbeat = setInterval(() => {
        for (const sockets of connections.values()) {
            for (const ws of sockets) {
                if (!ws.isAlive) {
                    ws.terminate();
                    continue;
                }
                ws.isAlive = false;
                ws.ping();
            }
        }
    }, heartbeatMs);
    heartbeat.unref();

    return {
        // Wire this to the HTTP server's "upgrade" event.
        handleUpgrade(req, socket, head) {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname !== '/device') return refuse(socket, 404, 'Not Found');

            const header = req.headers.authorization || '';
            const token = header.startsWith('Bearer ') ? header.slice(7) : '';
            if (!safeEqual(token, config.deviceToken)) return refuse(socket, 401, 'Unauthorized');

            const sign = db.getSign(url.searchParams.get('sign') || '');
            if (!sign) return refuse(socket, 404, 'Not Found');

            wss.handleUpgrade(req, socket, head, (ws) => register(ws, sign.id));
        },

        pushState(signId, state) {
            for (const ws of connections.get(signId) || []) {
                if (ws.readyState === ws.OPEN) ws.send(stateMessage(state));
            }
        },

        // Sends any message to a sign. Returns false if it is offline.
        send(signId, message) {
            let sent = false;
            for (const ws of connections.get(signId) || []) {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(message));
                    sent = true;
                }
            }
            return sent;
        },

        // What the sign last said about itself. version is null for a
        // sign that has not said, such as one on firmware older than 1.8.
        deviceInfo(signId) {
            return reported.get(signId) || { version: null, updateError: null };
        },

        isOnline(signId) {
            return (connections.get(signId)?.size || 0) > 0;
        },

        close() {
            clearInterval(heartbeat);
            for (const sockets of connections.values()) {
                for (const ws of sockets) ws.terminate();
            }
            wss.close();
        },
    };
}
