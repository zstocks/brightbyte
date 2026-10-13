import http from 'node:http';
import { validateConfig } from './src/config.js';
import { openDatabase } from './src/db.js';
import { createApp } from './src/app.js';
import { createDeviceHub } from './src/devices.js';
import { createSignService } from './src/signs.js';
import { createFirmwareStore } from './src/firmware.js';

const config = validateConfig();
const db = openDatabase(config.dataDir);
const hub = createDeviceHub({ config, db });
const signs = createSignService({ db, hub, timezone: config.timezone });
signs.start();
const firmware = createFirmwareStore(config.dataDir);
const server = http.createServer(createApp({ config, db, signs, hub, firmware }));

// WebSocket connections from the signs arrive as HTTP upgrades.
server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

// Bind to 0.0.0.0 so Docker's port mapping can reach the app.
server.listen(config.port, '0.0.0.0', () => {
    console.log(`brightbyte listening on port ${config.port}`);
});

// Close cleanly when Docker stops the container.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        signs.stop();
        hub.close();
        server.close(() => {
            db.close();
            process.exit(0);
        });
    });
}
