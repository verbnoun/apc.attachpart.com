/**
 * Relay Sniffer - Passive transport protocol decoder
 *
 * Decodes chunked SysEx transfers by observing relay traffic.
 * Used to sniff exchange messages between synth and controller.
 * Depends on: transport.js (isCandideSysEx, mcoded7Decode, crc16, crc32)
 */

class RelaySniffer {
    constructor(onJson) {
        this._onJson = onJson;
        this._reset();
    }

    _reset() {
        this._rxBuffer = null;
        this._rxReceivedBytes = 0;
        this._rxExpectedChunk = 0;
        this._rxTotalChunks = 0;
        this._active = false;
    }

    receive(sysexData) {
        if (!isCandideSysEx(sysexData)) return;

        const payload = sysexData.slice(3, sysexData.length - 1);
        const decoded = mcoded7Decode(new Uint8Array(payload));
        if (!decoded || decoded.length === 0) return;

        const type = decoded[0];

        if (type >= 0x08) {
            try {
                const str = new TextDecoder().decode(decoded);
                this._onJson(JSON.parse(str));
            } catch (e) { /* not JSON */ }
            return;
        }

        switch (type) {
            case 0x01: this._handleStart(decoded); break;
            case 0x02: this._handleChunk(decoded); break;
            case 0x05: this._handleEnd(decoded); break;
        }
    }

    _handleStart(data) {
        if (data.length < 7) return;
        this._rxTotalChunks = (data[1] << 8) | data[2];
        const totalBytes = ((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0;
        if (totalBytes > 32768 || totalBytes === 0) { this._reset(); return; }
        this._rxBuffer = new Uint8Array(totalBytes);
        this._rxReceivedBytes = 0;
        this._rxExpectedChunk = 0;
        this._active = true;
    }

    _handleChunk(data) {
        if (!this._active || data.length < 6) return;
        const seq = (data[1] << 8) | data[2];
        const chunkLen = data[3] === 0 ? 256 : data[3];
        if (data.length < 4 + chunkLen + 2) return;

        const payload = data.slice(4, 4 + chunkLen);
        const rxCrc = (data[4 + chunkLen] << 8) | data[4 + chunkLen + 1];
        if (crc16(payload) !== rxCrc) return;

        if (seq !== this._rxExpectedChunk) return;

        this._rxBuffer.set(payload, this._rxReceivedBytes);
        this._rxReceivedBytes += chunkLen;
        this._rxExpectedChunk++;
    }

    _handleEnd(data) {
        if (!this._active || data.length < 9) return;
        const expectedBytes = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
        const expectedCrc = ((data[5] << 24) | (data[6] << 16) | (data[7] << 8) | data[8]) >>> 0;

        if (this._rxReceivedBytes !== expectedBytes) { this._reset(); return; }

        const assembled = this._rxBuffer.slice(0, this._rxReceivedBytes);
        const computedCrc = crc32(assembled);
        if (computedCrc !== expectedCrc) { this._reset(); return; }

        try {
            const str = new TextDecoder().decode(assembled);
            this._onJson(JSON.parse(str));
        } catch (e) { /* malformed JSON */ }

        this._reset();
    }
}
