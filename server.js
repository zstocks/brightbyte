import http from 'node:http';
import { validateConfig } from './src/config.js';
import { openDatabase } from './src/db.js';
import { createApp } from './src/app.js';

const config = validateConfig();
const db = openDatabase(config.dataDir);
const server = http.createServer(createApp({ config, db }));

// Bind to 0.0.0.0 so Docker's port mapping can reach the app.
server.listen(config.port, '0.0.0.0', () => {
    console.log(`brightbyte listening on port ${config.port}`);
});

// Close cleanly when Docker stops the container.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        server.close(() => {
            db.close();
            process.exit(0);
        });
    });
}
