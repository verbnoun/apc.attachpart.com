import { describe, it, expect, beforeEach } from 'vitest';

describe('RelaySniffer', () => {
    let sniffer;
    let received;

    /** Wrap raw transport bytes in SysEx (F0 7D 00 [mcoded7 encoded payload] F7) */
    function wrapSysEx(rawBytes) {
        const encoded = mcoded7Encode(rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes));
        const sysex = new Uint8Array(encoded.length + 4);
        sysex[0] = 0xF0;
        sysex[1] = 0x7D;
        sysex[2] = 0x00;
        sysex.set(encoded, 3);
        sysex[sysex.length - 1] = 0xF7;
        return sysex;
    }

    /** Create a non-chunked JSON SysEx message (type >= 0x08, just JSON bytes) */
    function makeJsonSysEx(json) {
        return encodeJsonToSysEx(json);
    }

    beforeEach(() => {
        received = [];
        sniffer = new RelaySniffer(json => received.push(json));
    });

    // ---- Simple (non-chunked) messages ----

    it('decodes simple JSON SysEx', () => {
        const msg = makeJsonSysEx({ cmd: 'controller-available' });
        sniffer.receive(msg);
        expect(received.length).toBe(1);
        expect(received[0].cmd).toBe('controller-available');
    });

    it('ignores non-Candide SysEx', () => {
        const bad = new Uint8Array([0xF0, 0x01, 0x00, 0x42, 0xF7]);
        sniffer.receive(bad);
        expect(received.length).toBe(0);
    });

    // ---- Chunked transfer ----

    it('assembles a single-chunk transfer', () => {
        const json = { cmd: 'set-patch', name: 'Test' };
        const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
        const payloadCrc16 = crc16(jsonBytes);
        const payloadCrc32 = crc32(jsonBytes);

        // START: 1 chunk, N bytes
        const start = new Uint8Array(7);
        start[0] = 0x01; // MSG_START
        start[1] = 0; start[2] = 1; // 1 chunk
        start[3] = (jsonBytes.length >> 24) & 0xFF;
        start[4] = (jsonBytes.length >> 16) & 0xFF;
        start[5] = (jsonBytes.length >> 8) & 0xFF;
        start[6] = jsonBytes.length & 0xFF;
        sniffer.receive(wrapSysEx(start));
        expect(received.length).toBe(0); // Not yet

        // CHUNK 0
        const chunk = new Uint8Array(4 + jsonBytes.length + 2);
        chunk[0] = 0x02; // MSG_CHUNK
        chunk[1] = 0; chunk[2] = 0; // seq 0
        chunk[3] = jsonBytes.length & 0xFF;
        chunk.set(jsonBytes, 4);
        chunk[4 + jsonBytes.length] = (payloadCrc16 >> 8) & 0xFF;
        chunk[4 + jsonBytes.length + 1] = payloadCrc16 & 0xFF;
        sniffer.receive(wrapSysEx(chunk));
        expect(received.length).toBe(0); // Not yet

        // END
        const end = new Uint8Array(9);
        end[0] = 0x05; // MSG_END
        end[1] = (jsonBytes.length >> 24) & 0xFF;
        end[2] = (jsonBytes.length >> 16) & 0xFF;
        end[3] = (jsonBytes.length >> 8) & 0xFF;
        end[4] = jsonBytes.length & 0xFF;
        end[5] = (payloadCrc32 >> 24) & 0xFF;
        end[6] = (payloadCrc32 >> 16) & 0xFF;
        end[7] = (payloadCrc32 >> 8) & 0xFF;
        end[8] = payloadCrc32 & 0xFF;
        sniffer.receive(wrapSysEx(end));

        expect(received.length).toBe(1);
        expect(received[0].cmd).toBe('set-patch');
        expect(received[0].name).toBe('Test');
    });

    it('rejects chunk with bad CRC-16', () => {
        const jsonBytes = new TextEncoder().encode('{"cmd":"test"}');

        // START
        const start = new Uint8Array(7);
        start[0] = 0x01;
        start[1] = 0; start[2] = 1;
        start[3] = 0; start[4] = 0; start[5] = 0; start[6] = jsonBytes.length;
        sniffer.receive(wrapSysEx(start));

        // CHUNK with bad CRC
        const chunk = new Uint8Array(4 + jsonBytes.length + 2);
        chunk[0] = 0x02;
        chunk[1] = 0; chunk[2] = 0;
        chunk[3] = jsonBytes.length;
        chunk.set(jsonBytes, 4);
        chunk[4 + jsonBytes.length] = 0xFF; // bad
        chunk[4 + jsonBytes.length + 1] = 0xFF;
        sniffer.receive(wrapSysEx(chunk));

        // END (even if sent, should fail since chunk was rejected)
        const payloadCrc32 = crc32(jsonBytes);
        const end = new Uint8Array(9);
        end[0] = 0x05;
        end[1] = 0; end[2] = 0; end[3] = 0; end[4] = jsonBytes.length;
        end[5] = (payloadCrc32 >> 24) & 0xFF;
        end[6] = (payloadCrc32 >> 16) & 0xFF;
        end[7] = (payloadCrc32 >> 8) & 0xFF;
        end[8] = payloadCrc32 & 0xFF;
        sniffer.receive(wrapSysEx(end));

        // Byte count mismatch (0 received vs expected) → reset, no JSON
        expect(received.length).toBe(0);
    });

    it('rejects out-of-sequence chunk', () => {
        const jsonBytes = new TextEncoder().encode('{"cmd":"test"}');
        const payloadCrc16 = crc16(jsonBytes);

        // START (expecting 2 chunks)
        const start = new Uint8Array(7);
        start[0] = 0x01;
        start[1] = 0; start[2] = 2;
        start[3] = 0; start[4] = 0; start[5] = 0; start[6] = jsonBytes.length * 2;
        sniffer.receive(wrapSysEx(start));

        // Send chunk seq=1 instead of seq=0
        const chunk = new Uint8Array(4 + jsonBytes.length + 2);
        chunk[0] = 0x02;
        chunk[1] = 0; chunk[2] = 1; // seq 1 (should be 0)
        chunk[3] = jsonBytes.length;
        chunk.set(jsonBytes, 4);
        chunk[4 + jsonBytes.length] = (payloadCrc16 >> 8) & 0xFF;
        chunk[4 + jsonBytes.length + 1] = payloadCrc16 & 0xFF;
        sniffer.receive(wrapSysEx(chunk));

        // No bytes should have been stored (sniffer silently drops)
        expect(received.length).toBe(0);
    });

    it('rejects END with byte count mismatch', () => {
        const jsonBytes = new TextEncoder().encode('{"a":1}');
        const payloadCrc16 = crc16(jsonBytes);

        // START
        sniffer.receive(wrapSysEx(new Uint8Array([0x01, 0, 1, 0, 0, 0, jsonBytes.length])));

        // CHUNK
        const chunk = new Uint8Array(4 + jsonBytes.length + 2);
        chunk[0] = 0x02;
        chunk[1] = 0; chunk[2] = 0;
        chunk[3] = jsonBytes.length;
        chunk.set(jsonBytes, 4);
        chunk[4 + jsonBytes.length] = (payloadCrc16 >> 8) & 0xFF;
        chunk[4 + jsonBytes.length + 1] = payloadCrc16 & 0xFF;
        sniffer.receive(wrapSysEx(chunk));

        // END with wrong byte count
        const end = new Uint8Array(9);
        end[0] = 0x05;
        end[1] = 0; end[2] = 0; end[3] = 0; end[4] = 99; // wrong count
        end[5] = 0; end[6] = 0; end[7] = 0; end[8] = 0;
        sniffer.receive(wrapSysEx(end));

        expect(received.length).toBe(0);
    });

    it('resets after completed transfer', () => {
        // First transfer
        const json1 = makeJsonSysEx({ cmd: 'first' });
        sniffer.receive(json1);
        expect(received.length).toBe(1);

        // Second transfer
        const json2 = makeJsonSysEx({ cmd: 'second' });
        sniffer.receive(json2);
        expect(received.length).toBe(2);
        expect(received[1].cmd).toBe('second');
    });

    it('ignores START with oversized buffer', () => {
        const start = new Uint8Array(7);
        start[0] = 0x01;
        start[1] = 0; start[2] = 1;
        start[3] = 0xFF; start[4] = 0xFF; start[5] = 0xFF; start[6] = 0xFF; // way too big
        sniffer.receive(wrapSysEx(start));

        // Should not be in active state
        expect(received.length).toBe(0);
    });
});
