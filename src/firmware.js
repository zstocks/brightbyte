// Stores the firmware file that signs download to update themselves.
// One file is kept at a time: uploading a new one replaces the old.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The sign's flash has room for an app of this size (the "min_spiffs"
// partition layout set in platformio.ini).
export const MAX_FIRMWARE_BYTES = 0x1E0000;
const MIN_FIRMWARE_BYTES = 100 * 1024;
const ESP_IMAGE_MAGIC = 0xE9; // every ESP32 app image starts with this byte

const fail = (error) => ({ ok: false, error });

export function validateFirmware(buffer, version) {
    if (typeof version !== 'string' || !/^[0-9A-Za-z._-]{1,32}$/.test(version)) {
        return fail('Give the firmware a version such as 1.8.0 (letters, numbers, dots and dashes).');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length < MIN_FIRMWARE_BYTES) {
        return fail('That file is too small to be firmware. Upload firmware.bin from the .pio/build/esp32dev folder.');
    }
    if (buffer.length > MAX_FIRMWARE_BYTES) {
        return fail('That file is too large to fit on the sign.');
    }
    if (buffer[0] !== ESP_IMAGE_MAGIC) {
        return fail('That file is not ESP32 firmware. Upload firmware.bin from the .pio/build/esp32dev folder.');
    }
    return { ok: true };
}

export function createFirmwareStore(dataDir) {
    const dir = join(dataDir, 'firmware');
    const binPath = join(dir, 'firmware.bin');
    const metaPath = join(dir, 'firmware.json');

    return {
        // { version, size, md5, uploadedAt } or null if nothing is uploaded.
        info() {
            if (!existsSync(metaPath) || !existsSync(binPath)) return null;
            try {
                return JSON.parse(readFileSync(metaPath, 'utf8'));
            } catch {
                return null;
            }
        },
        save(buffer, version) {
            const checked = validateFirmware(buffer, version);
            if (!checked.ok) return checked;
            mkdirSync(dir, { recursive: true });
            const info = {
                version,
                size: buffer.length,
                // The sign checks this after downloading, so a damaged
                // download is never installed.
                md5: createHash('md5').update(buffer).digest('hex'),
                uploadedAt: new Date().toISOString(),
            };
            // Write to temporary names first so a sign never downloads
            // a half-written file.
            writeFileSync(`${binPath}.tmp`, buffer);
            writeFileSync(`${metaPath}.tmp`, JSON.stringify(info));
            renameSync(`${binPath}.tmp`, binPath);
            renameSync(`${metaPath}.tmp`, metaPath);
            return { ok: true, info };
        },
        stream() {
            return createReadStream(binPath);
        },
    };
}
