import { describe, it, expect, beforeEach } from 'vitest';

describe('ChunkedTransport', () => {
    let transport;
    let sent;       // Captured SysEx messages
    let completions; // Captured completion callbacks
    let currentTime;

    /** Decode a SysEx message sent by transport back to raw transport bytes */
    function decodeSent(sysex) {
        // Strip F0 7D 00 ... F7 framing, mcoded7 decode payload
        const payload = sysex.slice(3, sysex.length - 1);
        return mcoded7Decode(new Uint8Array(payload));
    }

    /** Build a raw transport message, mcoded7 encode + SysEx wrap (simulates peer) */
    function wrapTransport(rawMsg) {
        const encoded = mcoded7Encode(rawMsg);
        const sysex = new Uint8Array(encoded.length + 4);
        sysex[0] = 0xF0;
        sysex[1] = 0x7D;
        sysex[2] = 0x00;
        sysex.set(encoded, 3);
        sysex[sysex.length - 1] = 0xF7;
        return sysex;
    }

    /** Feed a raw transport message to transport.receive() (decode first) */
    function feedRaw(rawMsg) {
        // ChunkedTransport.receive() expects decoded transport bytes, not SysEx
        transport.receive(rawMsg instanceof Uint8Array ? rawMsg : new Uint8Array(rawMsg));
    }

    beforeEach(() => {
        sent = [];
        completions = [];
        currentTime = 0;

        transport = new ChunkedTransport(
            (sysex) => sent.push(new Uint8Array(sysex)),
            (data, success) => completions.push({ data, success }),
            () => currentTime,
            () => {} // suppress logging
        );
    });

    // ---- State management ----

    it('starts in IDLE state', () => {
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
    });

    it('rejects send when not IDLE', () => {
        transport.send(new Uint8Array(10));
        expect(transport.send(new Uint8Array(5))).toBe(false);
    });

    // ---- Send flow ----

    it('sends START message on send()', () => {
        const result = transport.send(new Uint8Array(10));
        expect(result).not.toBe(false);
        expect(sent.length).toBe(1);
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_WAIT_ACK);

        // Decode and verify START message
        const raw = decodeSent(sent[0]);
        expect(raw[0]).toBe(TRANSPORT_CONST.MSG_START);
    });

    it('calculates chunk count correctly', () => {
        // 10 bytes = 1 chunk (< 256)
        transport.send(new Uint8Array(10));
        expect(transport.txTotalChunks).toBe(1);

        // Reset and try 512 bytes = 2 chunks
        transport.state = TRANSPORT_CONST.STATE_IDLE;
        transport.send(new Uint8Array(512));
        expect(transport.txTotalChunks).toBe(2);

        // 256 bytes = 1 chunk
        transport.state = TRANSPORT_CONST.STATE_IDLE;
        transport.send(new Uint8Array(256));
        expect(transport.txTotalChunks).toBe(1);

        // 257 bytes = 2 chunks
        transport.state = TRANSPORT_CONST.STATE_IDLE;
        transport.send(new Uint8Array(257));
        expect(transport.txTotalChunks).toBe(2);
    });

    it('sends first chunk after START ACK', () => {
        transport.send(new Uint8Array(10));
        const startSent = sent.length;

        // ACK START (seq 0xFFFF)
        feedRaw([TRANSPORT_CONST.MSG_ACK, 0xFF, 0xFF]);

        expect(sent.length).toBe(startSent + 1); // chunk sent
        expect(transport.txStartAcked).toBe(true);
    });

    it('completes single-chunk transfer', () => {
        const data = new Uint8Array(10);
        for (let i = 0; i < 10; i++) data[i] = i;

        transport.send(data);

        // ACK START
        feedRaw([TRANSPORT_CONST.MSG_ACK, 0xFF, 0xFF]);
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_WAIT_ACK);

        // ACK CHUNK 0
        feedRaw([TRANSPORT_CONST.MSG_ACK, 0x00, 0x00]);
        // Should have sent END, now waiting for COMPLETE
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_WAIT_COMPLETE);

        // COMPLETE success
        feedRaw([TRANSPORT_CONST.MSG_COMPLETE, 0x00]);
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
        expect(completions.length).toBe(1);
        expect(completions[0].success).toBe(true);
    });

    it('fails on COMPLETE with error status', () => {
        transport.send(new Uint8Array(10));
        feedRaw([TRANSPORT_CONST.MSG_ACK, 0xFF, 0xFF]);
        feedRaw([TRANSPORT_CONST.MSG_ACK, 0x00, 0x00]);

        // COMPLETE with error
        feedRaw([TRANSPORT_CONST.MSG_COMPLETE, 0x01]);
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
        expect(completions[0].success).toBe(false);
    });

    // ---- Retry and timeout ----

    it('retries on NAK', () => {
        transport.send(new Uint8Array(10));
        const msgCount = sent.length;

        feedRaw([TRANSPORT_CONST.MSG_NAK, 0x00, 0x00, TRANSPORT_CONST.ERR_CRC_FAIL]);

        expect(sent.length).toBe(msgCount + 1); // retransmitted
        expect(transport.txRetryCount).toBe(1);
    });

    it('aborts after max retries', () => {
        transport.send(new Uint8Array(10));

        for (let i = 0; i <= TRANSPORT_CONST.MAX_RETRIES; i++) {
            feedRaw([TRANSPORT_CONST.MSG_NAK, 0x00, 0x00, TRANSPORT_CONST.ERR_CRC_FAIL]);
        }

        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
        expect(completions.length).toBe(1);
        expect(completions[0].success).toBe(false);
    });

    it('handles timeout via task()', () => {
        transport.send(new Uint8Array(10));
        const msgCount = sent.length;

        // Advance time past timeout
        currentTime = TRANSPORT_CONST.TIMEOUT_MS + 1;
        transport.task();

        expect(transport.txRetryCount).toBe(1);
        expect(sent.length).toBe(msgCount + 1); // retransmitted
    });

    it('task() does nothing when IDLE', () => {
        currentTime = 99999;
        transport.task();
        expect(sent.length).toBe(0);
    });

    // ---- Abort ----

    it('abort resets to IDLE', () => {
        transport.send(new Uint8Array(10));
        transport.abort();
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
    });

    it('abort does nothing when already IDLE', () => {
        transport.abort();
        expect(sent.length).toBe(0);
    });

    it('abort sends ABORT message', () => {
        transport.send(new Uint8Array(10));
        const msgCount = sent.length;
        transport.abort();
        expect(sent.length).toBe(msgCount + 1);
        const raw = decodeSent(sent[sent.length - 1]);
        expect(raw[0]).toBe(TRANSPORT_CONST.MSG_ABORT);
    });

    // ---- Receive flow ----

    it('receives START and transitions to RECEIVING', () => {
        const startMsg = new Uint8Array(7);
        startMsg[0] = TRANSPORT_CONST.MSG_START;
        startMsg[1] = 0; startMsg[2] = 1; // 1 chunk
        startMsg[3] = 0; startMsg[4] = 0; startMsg[5] = 0; startMsg[6] = 10; // 10 bytes

        feedRaw(startMsg);

        expect(transport.state).toBe(TRANSPORT_CONST.STATE_RECEIVING);
        expect(sent.length).toBe(1); // ACK sent
    });

    it('rejects START with buffer overflow', () => {
        const startMsg = new Uint8Array(7);
        startMsg[0] = TRANSPORT_CONST.MSG_START;
        startMsg[1] = 0; startMsg[2] = 1;
        // Request more than MAX_BUFFER_SIZE
        const tooBig = TRANSPORT_CONST.MAX_BUFFER_SIZE + 1;
        startMsg[3] = (tooBig >> 24) & 0xFF;
        startMsg[4] = (tooBig >> 16) & 0xFF;
        startMsg[5] = (tooBig >> 8) & 0xFF;
        startMsg[6] = tooBig & 0xFF;

        feedRaw(startMsg);

        expect(transport.state).not.toBe(TRANSPORT_CONST.STATE_RECEIVING);
        // NAK should have been sent
        const raw = decodeSent(sent[0]);
        expect(raw[0]).toBe(TRANSPORT_CONST.MSG_NAK);
    });

    it('receives a complete single-chunk transfer', () => {
        const payload = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
        const payloadCrc16 = crc16(payload);
        const payloadCrc32 = crc32(payload);

        // START: 1 chunk, 5 bytes
        feedRaw([TRANSPORT_CONST.MSG_START, 0, 1, 0, 0, 0, 5]);

        // CHUNK 0: seq=0, len=5, payload, CRC-16
        const chunkMsg = new Uint8Array(4 + 5 + 2);
        chunkMsg[0] = TRANSPORT_CONST.MSG_CHUNK;
        chunkMsg[1] = 0; chunkMsg[2] = 0; // seq 0
        chunkMsg[3] = 5; // length
        chunkMsg.set(payload, 4);
        chunkMsg[9] = (payloadCrc16 >> 8) & 0xFF;
        chunkMsg[10] = payloadCrc16 & 0xFF;
        feedRaw(chunkMsg);

        // END: 5 bytes, CRC-32
        const endMsg = new Uint8Array(9);
        endMsg[0] = TRANSPORT_CONST.MSG_END;
        endMsg[1] = 0; endMsg[2] = 0; endMsg[3] = 0; endMsg[4] = 5;
        endMsg[5] = (payloadCrc32 >> 24) & 0xFF;
        endMsg[6] = (payloadCrc32 >> 16) & 0xFF;
        endMsg[7] = (payloadCrc32 >> 8) & 0xFF;
        endMsg[8] = payloadCrc32 & 0xFF;
        feedRaw(endMsg);

        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
        expect(completions.length).toBe(1);
        expect(completions[0].success).toBe(true);
        expect(Array.from(completions[0].data)).toEqual(Array.from(payload));
    });

    it('NAKs chunk with bad CRC', () => {
        feedRaw([TRANSPORT_CONST.MSG_START, 0, 1, 0, 0, 0, 5]);

        const chunkMsg = new Uint8Array(4 + 5 + 2);
        chunkMsg[0] = TRANSPORT_CONST.MSG_CHUNK;
        chunkMsg[1] = 0; chunkMsg[2] = 0;
        chunkMsg[3] = 5;
        chunkMsg.set([1, 2, 3, 4, 5], 4);
        chunkMsg[9] = 0xFF; // bad CRC
        chunkMsg[10] = 0xFF;
        feedRaw(chunkMsg);

        // Should have sent ACK for START + NAK for chunk
        const lastSent = decodeSent(sent[sent.length - 1]);
        expect(lastSent[0]).toBe(TRANSPORT_CONST.MSG_NAK);
        expect(lastSent[3]).toBe(TRANSPORT_CONST.ERR_CRC_FAIL);
    });

    it('NAKs out-of-sequence chunk', () => {
        feedRaw([TRANSPORT_CONST.MSG_START, 0, 2, 0, 0, 0, 10]);

        // Send chunk seq=1 (expected seq=0)
        const payload = new Uint8Array(5);
        const crcVal = crc16(payload);
        const chunkMsg = new Uint8Array(4 + 5 + 2);
        chunkMsg[0] = TRANSPORT_CONST.MSG_CHUNK;
        chunkMsg[1] = 0; chunkMsg[2] = 1; // seq 1 (wrong)
        chunkMsg[3] = 5;
        chunkMsg.set(payload, 4);
        chunkMsg[9] = (crcVal >> 8) & 0xFF;
        chunkMsg[10] = crcVal & 0xFF;
        feedRaw(chunkMsg);

        const lastSent = decodeSent(sent[sent.length - 1]);
        expect(lastSent[0]).toBe(TRANSPORT_CONST.MSG_NAK);
        expect(lastSent[3]).toBe(TRANSPORT_CONST.ERR_OUT_OF_SEQ);
    });

    it('handles ABORT from peer', () => {
        transport.send(new Uint8Array(10));
        feedRaw([TRANSPORT_CONST.MSG_ABORT, 0x00]);
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
        expect(completions[0].success).toBe(false);
    });

    it('ignores empty message', () => {
        transport.receive(new Uint8Array(0));
        expect(transport.state).toBe(TRANSPORT_CONST.STATE_IDLE);
    });
});
