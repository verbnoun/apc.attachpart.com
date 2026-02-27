import { describe, it, expect } from 'vitest';

describe('mcoded7Encode / mcoded7Decode', () => {
    it('round-trips empty data', () => {
        const encoded = mcoded7Encode(new Uint8Array(0));
        expect(encoded.length).toBe(0);
        expect(mcoded7Decode(encoded).length).toBe(0);
    });

    it('round-trips single byte (no high bit)', () => {
        const input = new Uint8Array([0x42]);
        const decoded = mcoded7Decode(mcoded7Encode(input));
        expect(decoded).toEqual(input);
    });

    it('round-trips single byte with high bit set', () => {
        const input = new Uint8Array([0xFF]);
        const encoded = mcoded7Encode(input);
        // All encoded bytes must be 7-bit safe
        for (const b of encoded) {
            expect(b).toBeLessThanOrEqual(0x7F);
        }
        const decoded = mcoded7Decode(encoded);
        expect(decoded).toEqual(input);
    });

    it('round-trips full 7-byte group', () => {
        const input = new Uint8Array([0x01, 0x82, 0x03, 0x84, 0x05, 0x86, 0x07]);
        const encoded = mcoded7Encode(input);
        expect(encoded.length).toBe(8); // 1 MSB byte + 7 data bytes
        const decoded = mcoded7Decode(encoded);
        expect(decoded).toEqual(input);
    });

    it('round-trips partial group (3 bytes)', () => {
        const input = new Uint8Array([0xAA, 0xBB, 0xCC]);
        const decoded = mcoded7Decode(mcoded7Encode(input));
        expect(decoded).toEqual(input);
    });

    it('round-trips multi-group data', () => {
        const input = new Uint8Array(15);
        for (let i = 0; i < 15; i++) input[i] = i * 17;
        const decoded = mcoded7Decode(mcoded7Encode(input));
        expect(decoded).toEqual(input);
    });

    it('round-trips JSON payload', () => {
        const json = JSON.stringify({ cmd: 'get-patch', index: 0 });
        const input = new TextEncoder().encode(json);
        const decoded = mcoded7Decode(mcoded7Encode(input));
        const result = new TextDecoder().decode(decoded);
        expect(result).toBe(json);
    });

    it('round-trips all-zero bytes', () => {
        const input = new Uint8Array(14); // 2 full groups
        const decoded = mcoded7Decode(mcoded7Encode(input));
        expect(decoded).toEqual(input);
    });

    it('round-trips all-0xFF bytes', () => {
        const input = new Uint8Array(7).fill(0xFF);
        const decoded = mcoded7Decode(mcoded7Encode(input));
        expect(decoded).toEqual(input);
    });

    it('handles null/undefined input gracefully', () => {
        expect(mcoded7Encode(null).length).toBe(0);
        expect(mcoded7Decode(null).length).toBe(0);
    });

    it('accepts plain array input', () => {
        const input = [0x01, 0x82, 0x03];
        const encoded = mcoded7Encode(input);
        expect(encoded).toBeInstanceOf(Uint8Array);
        const decoded = mcoded7Decode(encoded);
        expect(Array.from(decoded)).toEqual(input);
    });
});

describe('crc16', () => {
    it('returns 0 for empty data', () => {
        expect(crc16(new Uint8Array(0))).toBe(0);
    });

    it('produces consistent results', () => {
        const data = new Uint8Array([0x01, 0x02, 0x03]);
        expect(crc16(data)).toBe(crc16(data));
    });

    it('produces 16-bit value', () => {
        const data = new Uint8Array([0xFF, 0xFE, 0xFD]);
        const result = crc16(data);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xFFFF);
    });

    it('detects single-bit change', () => {
        const a = new Uint8Array([0x00]);
        const b = new Uint8Array([0x01]);
        expect(crc16(a)).not.toBe(crc16(b));
    });

    it('detects byte order change', () => {
        const a = new Uint8Array([0x01, 0x02]);
        const b = new Uint8Array([0x02, 0x01]);
        expect(crc16(a)).not.toBe(crc16(b));
    });

    // Known CRC-16-CCITT test vector: "123456789" = 0x31C3
    it('matches known test vector', () => {
        const data = new TextEncoder().encode('123456789');
        expect(crc16(data)).toBe(0x31C3);
    });
});

describe('crc32', () => {
    it('returns 0 for empty data', () => {
        expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    });

    it('produces unsigned 32-bit value', () => {
        const data = new Uint8Array([0x01, 0x02, 0x03]);
        const result = crc32(data);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xFFFFFFFF);
    });

    it('detects single-bit change', () => {
        const a = new Uint8Array([0x00]);
        const b = new Uint8Array([0x01]);
        expect(crc32(a)).not.toBe(crc32(b));
    });

    // Known CRC-32 test vector: "123456789" = 0xCBF43926
    it('matches known test vector', () => {
        const data = new TextEncoder().encode('123456789');
        expect(crc32(data)).toBe(0xCBF43926);
    });
});

describe('encodeJsonToSysEx / decodeSysExToJson', () => {
    it('round-trips a JSON command', () => {
        const cmd = { cmd: 'get-device-info' };
        const sysex = encodeJsonToSysEx(cmd);

        // Verify SysEx framing
        expect(sysex[0]).toBe(0xF0);
        expect(sysex[1]).toBe(0x7D);
        expect(sysex[2]).toBe(0x00);
        expect(sysex[sysex.length - 1]).toBe(0xF7);

        const decoded = decodeSysExToJson(sysex);
        expect(decoded).toEqual(cmd);
    });

    it('round-trips complex JSON', () => {
        const cmd = {
            cmd: 'update-param',
            module: 'CARRIER',
            param: 'CARRIER_RATIO',
            value: 2.5,
            nested: { a: [1, 2, 3] }
        };
        expect(decodeSysExToJson(encodeJsonToSysEx(cmd))).toEqual(cmd);
    });

    it('returns null for too-short message', () => {
        expect(decodeSysExToJson(new Uint8Array([0xF0, 0xF7]))).toBeNull();
    });

    it('returns null for wrong manufacturer ID', () => {
        const bad = new Uint8Array([0xF0, 0x01, 0x00, 0x00, 0xF7]);
        expect(decodeSysExToJson(bad)).toBeNull();
    });

    it('returns null for missing SysEx start', () => {
        const bad = new Uint8Array([0x00, 0x7D, 0x00, 0x00, 0xF7]);
        expect(decodeSysExToJson(bad)).toBeNull();
    });

    it('returns null for missing SysEx end', () => {
        const bad = new Uint8Array([0xF0, 0x7D, 0x00, 0x00, 0x00]);
        expect(decodeSysExToJson(bad)).toBeNull();
    });

    it('accepts plain array input for decode', () => {
        const cmd = { cmd: 'test' };
        const sysex = Array.from(encodeJsonToSysEx(cmd));
        expect(decodeSysExToJson(sysex)).toEqual(cmd);
    });
});

describe('isCandideSysEx', () => {
    it('returns true for valid Candide SysEx', () => {
        expect(isCandideSysEx(new Uint8Array([0xF0, 0x7D, 0x00, 0x42, 0xF7]))).toBe(true);
    });

    it('returns false for wrong manufacturer', () => {
        expect(isCandideSysEx(new Uint8Array([0xF0, 0x01, 0x00, 0x42, 0xF7]))).toBe(false);
    });

    it('returns false for too-short message', () => {
        expect(isCandideSysEx(new Uint8Array([0xF0, 0x7D]))).toBe(false);
    });

    it('returns false for wrong start byte', () => {
        expect(isCandideSysEx(new Uint8Array([0x00, 0x7D, 0x00, 0x42]))).toBe(false);
    });

    it('accepts plain array', () => {
        expect(isCandideSysEx([0xF0, 0x7D, 0x00, 0x42, 0xF7])).toBe(true);
    });
});
