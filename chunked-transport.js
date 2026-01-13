/**
 * Chunked Transport Protocol for Candide Web Editor
 * Reliable bidirectional transfer of large payloads over MIDI SysEx
 *
 * Based on ap_sysex_transport.c from lib/ap_sysex_transport/
 */

//======================================================================
// CONSTANTS
//======================================================================

const TRANSPORT_CONST = {
    CHUNK_SIZE: 256,
    TIMEOUT_MS: 500,
    MAX_RETRIES: 5,
    MAX_BUFFER_SIZE: 32768,

    // Message types (matches ap_sysex_transport.h)
    MSG_START: 0x01,
    MSG_CHUNK: 0x02,
    MSG_ACK: 0x03,
    MSG_NAK: 0x04,
    MSG_END: 0x05,
    MSG_COMPLETE: 0x06,
    MSG_ABORT: 0x07,

    // Error codes
    ERR_CRC_FAIL: 0x01,
    ERR_OUT_OF_SEQ: 0x02,
    ERR_BUFFER_FULL: 0x03,
    ERR_TIMEOUT: 0x04,
    ERR_MAX_RETRIES: 0x05,

    // States
    STATE_IDLE: 'IDLE',
    STATE_SENDING: 'SENDING',
    STATE_WAIT_ACK: 'WAIT_ACK',
    STATE_RECEIVING: 'RECEIVING',
    STATE_WAIT_COMPLETE: 'WAIT_COMPLETE',
    STATE_ERROR: 'ERROR'
};

//======================================================================
// CHUNKED TRANSPORT CLASS
//======================================================================

class ChunkedTransport {
    /**
     * @param {Function} sendFn - callback(sysexData) to send complete SysEx message
     * @param {Function} completeFn - callback(data, success) when transfer completes
     * @param {Function} timeFn - callback() returns current time in milliseconds
     * @param {Function} logFn - callback(message, type) to log to UI
     */
    constructor(sendFn, completeFn, timeFn, logFn) {
        this.sendFn = sendFn;
        this.completeFn = completeFn;
        this.timeFn = timeFn;
        this.logFn = logFn || ((msg) => console.log(msg));

        // Current state
        this.state = TRANSPORT_CONST.STATE_IDLE;

        // Sender state
        this.txData = null;
        this.txTotalBytes = 0;
        this.txTotalChunks = 0;
        this.txCurrentChunk = 0;
        this.txRetryCount = 0;
        this.txLastSendTime = 0;
        this.txStartAcked = false;

        // Receiver state
        this.rxBuffer = new Uint8Array(TRANSPORT_CONST.MAX_BUFFER_SIZE);
        this.rxReceivedBytes = 0;
        this.rxExpectedChunk = 0;
        this.rxTotalChunks = 0;

        // Timeout handle
        this.timeoutHandle = null;
    }

    //======================================================================
    // PUBLIC API
    //======================================================================

    /**
     * Start sending data
     * @param {Uint8Array} data - data to send
     * @returns {boolean} true if started successfully
     */
    send(data) {
        if (this.state !== TRANSPORT_CONST.STATE_IDLE) {
            this.logFn('Cannot send: busy in state ' + this.state, 'error');
            return false;
        }

        this.txData = data;
        this.txTotalBytes = data.length;
        this.txTotalChunks = Math.ceil(data.length / TRANSPORT_CONST.CHUNK_SIZE);
        this.txCurrentChunk = 0;
        this.txRetryCount = 0;
        this.txStartAcked = false;

        this.logFn(`Starting TX: ${this.txTotalBytes} bytes, ${this.txTotalChunks} chunks`, 'transport');

        return this._sendStart();
    }

    /**
     * Handle incoming transport message (after mcoded7 decode)
     * @param {Uint8Array} data - decoded transport message
     */
    receive(data) {
        if (data.length < 1) {
            this.logFn('Empty transport message', 'error');
            return;
        }

        const msgType = data[0];

        switch (msgType) {
            case TRANSPORT_CONST.MSG_START:
                this._handleStart(data);
                break;
            case TRANSPORT_CONST.MSG_CHUNK:
                this._handleChunk(data);
                break;
            case TRANSPORT_CONST.MSG_ACK:
                this._handleAck(data);
                break;
            case TRANSPORT_CONST.MSG_NAK:
                this._handleNak(data);
                break;
            case TRANSPORT_CONST.MSG_END:
                this._handleEnd(data);
                break;
            case TRANSPORT_CONST.MSG_COMPLETE:
                this._handleComplete(data);
                break;
            case TRANSPORT_CONST.MSG_ABORT:
                this._handleAbort(data);
                break;
            default:
                console.warn('[Transport] Unknown message type:', msgType);
        }
    }

    /**
     * Call periodically to handle timeouts
     */
    task() {
        if (this.state !== TRANSPORT_CONST.STATE_WAIT_ACK &&
            this.state !== TRANSPORT_CONST.STATE_WAIT_COMPLETE) {
            return;
        }

        const now = this.timeFn();
        const elapsed = now - this.txLastSendTime;

        if (elapsed > TRANSPORT_CONST.TIMEOUT_MS) {
            console.warn('[Transport] Timeout in state', this.state);
            this._handleTimeout();
        }
    }

    /**
     * Abort current transfer
     */
    abort() {
        if (this.state === TRANSPORT_CONST.STATE_IDLE) return;

        console.log('[Transport] Aborting transfer');
        this._sendAbort(0x00);
        this._reset(false);
    }

    //======================================================================
    // RECEIVER HANDLERS
    //======================================================================

    _handleStart(data) {
        if (data.length < 7) {
            console.error('[Transport] START too short');
            return;
        }

        this.rxTotalChunks = (data[1] << 8) | data[2];
        const totalBytes = (data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6];

        if (totalBytes > TRANSPORT_CONST.MAX_BUFFER_SIZE) {
            console.error('[Transport] Buffer too small for', totalBytes, 'bytes');
            this._sendNak(0, TRANSPORT_CONST.ERR_BUFFER_FULL);
            return;
        }

        this.rxReceivedBytes = 0;
        this.rxExpectedChunk = 0;
        this.state = TRANSPORT_CONST.STATE_RECEIVING;

        console.log(`[Transport] RX START: ${totalBytes} bytes, ${this.rxTotalChunks} chunks`);
        this._sendAck(0xFFFF);  // ACK START with special sequence
    }

    _handleChunk(data) {
        if (this.state !== TRANSPORT_CONST.STATE_RECEIVING) {
            console.error('[Transport] CHUNK but not receiving');
            return;
        }

        if (data.length < 6) {
            console.error('[Transport] CHUNK too short');
            return;
        }

        const seq = (data[1] << 8) | data[2];
        const chunkLen = data[3] === 0 ? 256 : data[3];  // 0 means 256

        if (data.length < 4 + chunkLen + 2) {
            console.error('[Transport] CHUNK payload incomplete');
            this._sendNak(seq, TRANSPORT_CONST.ERR_CRC_FAIL);
            return;
        }

        // Extract payload and CRC
        const payload = data.slice(4, 4 + chunkLen);
        const receivedCrc = (data[4 + chunkLen] << 8) | data[4 + chunkLen + 1];
        const computedCrc = crc16(payload);

        if (receivedCrc !== computedCrc) {
            console.error(`[Transport] CHUNK ${seq} CRC mismatch: got ${receivedCrc.toString(16)}, expected ${computedCrc.toString(16)}`);
            this._sendNak(seq, TRANSPORT_CONST.ERR_CRC_FAIL);
            return;
        }

        // Check sequence
        if (seq !== this.rxExpectedChunk) {
            if (seq === this.rxExpectedChunk - 1) {
                // Duplicate, just re-ACK
                console.log(`[Transport] CHUNK ${seq} duplicate, re-ACK`);
                this._sendAck(seq);
            } else {
                console.error(`[Transport] CHUNK out of sequence: got ${seq}, expected ${this.rxExpectedChunk}`);
                this._sendNak(seq, TRANSPORT_CONST.ERR_OUT_OF_SEQ);
            }
            return;
        }

        // Check buffer space
        if (this.rxReceivedBytes + chunkLen > TRANSPORT_CONST.MAX_BUFFER_SIZE) {
            console.error('[Transport] CHUNK would overflow buffer');
            this._sendNak(seq, TRANSPORT_CONST.ERR_BUFFER_FULL);
            return;
        }

        // Store chunk
        this.rxBuffer.set(payload, this.rxReceivedBytes);
        this.rxReceivedBytes += chunkLen;
        this.rxExpectedChunk++;

        console.log(`[Transport] RX CHUNK ${seq}: ${chunkLen} bytes (${this.rxReceivedBytes}/${this.txTotalBytes || '?'} total)`);
        this._sendAck(seq);
    }

    _handleEnd(data) {
        if (this.state !== TRANSPORT_CONST.STATE_RECEIVING) {
            console.error('[Transport] END but not receiving');
            return;
        }

        if (data.length < 9) {
            console.error('[Transport] END too short');
            return;
        }

        const expectedBytes = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
        const expectedCrc = ((data[5] << 24) | (data[6] << 16) | (data[7] << 8) | data[8]) >>> 0;

        // Verify byte count
        if (this.rxReceivedBytes !== expectedBytes) {
            this.logFn(`RX END byte count mismatch: got ${this.rxReceivedBytes}, expected ${expectedBytes}`, 'error');
            this._sendComplete(0x02);  // Byte count mismatch
            this._reset(false);
            return;
        }

        // Verify CRC-32
        const receivedData = this.rxBuffer.slice(0, this.rxReceivedBytes);
        const computedCrc = crc32(receivedData);

        if (computedCrc !== expectedCrc) {
            this.logFn(`RX END CRC32 mismatch: got 0x${computedCrc.toString(16)}, expected 0x${expectedCrc.toString(16)}`, 'error');
            this._sendComplete(0x01);  // CRC mismatch
            this._reset(false);
            return;
        }

        // Success!
        this.logFn(`RX END: transfer complete (${this.rxReceivedBytes} bytes)`, 'success');
        this._sendComplete(0x00);

        // Call completion handler with received data
        const data_copy = new Uint8Array(receivedData);
        this._reset(true, data_copy);
    }

    //======================================================================
    // SENDER HANDLERS
    //======================================================================

    _handleAck(data) {
        if (data.length < 3) {
            console.error('[Transport] ACK too short');
            return;
        }

        const seq = (data[1] << 8) | data[2];

        if (this.state === TRANSPORT_CONST.STATE_WAIT_ACK && !this.txStartAcked) {
            // ACK for START
            if (seq !== 0xFFFF) {
                console.warn('[Transport] Expected START ACK (0xFFFF), got', seq);
                return;
            }

            console.log('[Transport] TX START ACK received');
            this.txStartAcked = true;
            this.txCurrentChunk = 0;
            this.state = TRANSPORT_CONST.STATE_SENDING;
            this._sendNextChunk();

        } else if (this.state === TRANSPORT_CONST.STATE_WAIT_ACK && this.txStartAcked) {
            // ACK for CHUNK
            if (seq !== this.txCurrentChunk) {
                console.warn(`[Transport] ACK sequence mismatch: got ${seq}, expected ${this.txCurrentChunk}`);
                return;
            }

            console.log(`[Transport] TX CHUNK ${seq} ACK received`);
            this.txCurrentChunk++;
            this.txRetryCount = 0;
            this.state = TRANSPORT_CONST.STATE_SENDING;
            this._sendNextChunk();
        }
    }

    _handleNak(data) {
        if (data.length < 4) {
            console.error('[Transport] NAK too short');
            return;
        }

        const seq = (data[1] << 8) | data[2];
        const error = data[3];

        console.error(`[Transport] NAK received for seq ${seq}, error ${error}`);

        // Retry current message
        this._handleTimeout();
    }

    _handleComplete(data) {
        if (this.state !== TRANSPORT_CONST.STATE_WAIT_COMPLETE) {
            console.warn('[Transport] COMPLETE but not waiting');
            return;
        }

        if (data.length < 2) {
            console.error('[Transport] COMPLETE too short');
            return;
        }

        const status = data[1];

        if (status === 0x00) {
            console.log('[Transport] TX COMPLETE: transfer successful');
            this._reset(true);
        } else {
            console.error('[Transport] TX COMPLETE: transfer failed with status', status);
            this._reset(false);
        }
    }

    _handleAbort(data) {
        console.warn('[Transport] ABORT received');
        this._reset(false);
    }

    _handleTimeout() {
        this.txRetryCount++;

        if (this.txRetryCount > TRANSPORT_CONST.MAX_RETRIES) {
            console.error('[Transport] Max retries exceeded');
            this._sendAbort(TRANSPORT_CONST.ERR_MAX_RETRIES);
            this._reset(false);
            return;
        }

        console.warn(`[Transport] Retry ${this.txRetryCount}/${TRANSPORT_CONST.MAX_RETRIES}`);

        // Retransmit based on state
        if (this.state === TRANSPORT_CONST.STATE_WAIT_ACK && !this.txStartAcked) {
            this._sendStart();
        } else if (this.state === TRANSPORT_CONST.STATE_WAIT_ACK && this.txStartAcked) {
            this._sendChunk(this.txCurrentChunk);
        } else if (this.state === TRANSPORT_CONST.STATE_WAIT_COMPLETE) {
            this._sendEnd();
        }
    }

    //======================================================================
    // MESSAGE BUILDERS & SENDERS
    //======================================================================

    _sendStart() {
        const msg = new Uint8Array(7);
        msg[0] = TRANSPORT_CONST.MSG_START;
        msg[1] = (this.txTotalChunks >> 8) & 0xFF;
        msg[2] = this.txTotalChunks & 0xFF;
        msg[3] = (this.txTotalBytes >> 24) & 0xFF;
        msg[4] = (this.txTotalBytes >> 16) & 0xFF;
        msg[5] = (this.txTotalBytes >> 8) & 0xFF;
        msg[6] = this.txTotalBytes & 0xFF;

        console.log('[Transport] TX START');
        this.state = TRANSPORT_CONST.STATE_WAIT_ACK;
        this.txLastSendTime = this.timeFn();
        return this._encodeAndSend(msg);
    }

    _sendChunk(chunkNum) {
        const offset = chunkNum * TRANSPORT_CONST.CHUNK_SIZE;
        const remaining = this.txTotalBytes - offset;
        const chunkLen = Math.min(TRANSPORT_CONST.CHUNK_SIZE, remaining);

        const payload = this.txData.slice(offset, offset + chunkLen);
        const crcValue = crc16(payload);

        const msg = new Uint8Array(4 + chunkLen + 2);
        msg[0] = TRANSPORT_CONST.MSG_CHUNK;
        msg[1] = (chunkNum >> 8) & 0xFF;
        msg[2] = chunkNum & 0xFF;
        msg[3] = chunkLen & 0xFF;  // 256 becomes 0
        msg.set(payload, 4);
        msg[4 + chunkLen] = (crcValue >> 8) & 0xFF;
        msg[4 + chunkLen + 1] = crcValue & 0xFF;

        console.log(`[Transport] TX CHUNK ${chunkNum}: ${chunkLen} bytes`);
        this.state = TRANSPORT_CONST.STATE_WAIT_ACK;
        this.txLastSendTime = this.timeFn();
        return this._encodeAndSend(msg);
    }

    _sendEnd() {
        const crcValue = crc32(this.txData);

        const msg = new Uint8Array(9);
        msg[0] = TRANSPORT_CONST.MSG_END;
        msg[1] = (this.txTotalBytes >> 24) & 0xFF;
        msg[2] = (this.txTotalBytes >> 16) & 0xFF;
        msg[3] = (this.txTotalBytes >> 8) & 0xFF;
        msg[4] = this.txTotalBytes & 0xFF;
        msg[5] = (crcValue >> 24) & 0xFF;
        msg[6] = (crcValue >> 16) & 0xFF;
        msg[7] = (crcValue >> 8) & 0xFF;
        msg[8] = crcValue & 0xFF;

        console.log('[Transport] TX END');
        this.state = TRANSPORT_CONST.STATE_WAIT_COMPLETE;
        this.txLastSendTime = this.timeFn();
        return this._encodeAndSend(msg);
    }

    _sendNextChunk() {
        if (this.txCurrentChunk < this.txTotalChunks) {
            this._sendChunk(this.txCurrentChunk);
        } else {
            // All chunks sent, send END
            this._sendEnd();
        }
    }

    _sendAck(seq) {
        const msg = new Uint8Array(3);
        msg[0] = TRANSPORT_CONST.MSG_ACK;
        msg[1] = (seq >> 8) & 0xFF;
        msg[2] = seq & 0xFF;

        console.log(`[Transport] TX ACK ${seq === 0xFFFF ? 'START' : seq}`);
        this._encodeAndSend(msg);
    }

    _sendNak(seq, error) {
        const msg = new Uint8Array(4);
        msg[0] = TRANSPORT_CONST.MSG_NAK;
        msg[1] = (seq >> 8) & 0xFF;
        msg[2] = seq & 0xFF;
        msg[3] = error;

        console.log(`[Transport] TX NAK ${seq}, error ${error}`);
        this._encodeAndSend(msg);
    }

    _sendComplete(status) {
        const msg = new Uint8Array(2);
        msg[0] = TRANSPORT_CONST.MSG_COMPLETE;
        msg[1] = status;

        console.log(`[Transport] TX COMPLETE status ${status}`);
        this._encodeAndSend(msg);
    }

    _sendAbort(reason) {
        const msg = new Uint8Array(2);
        msg[0] = TRANSPORT_CONST.MSG_ABORT;
        msg[1] = reason;

        console.log(`[Transport] TX ABORT reason ${reason}`);
        this._encodeAndSend(msg);
    }

    /**
     * Encode transport message with mcoded7 and wrap in SysEx
     */
    _encodeAndSend(msg) {
        // mcoded7 encode
        const encoded = mcoded7Encode(msg);

        // Build SysEx: F0 7D 00 [encoded] F7
        const sysex = new Uint8Array(encoded.length + 4);
        sysex[0] = 0xF0;
        sysex[1] = 0x7D;  // Manufacturer ID
        sysex[2] = 0x00;  // Device ID
        sysex.set(encoded, 3);
        sysex[sysex.length - 1] = 0xF7;

        return this.sendFn(sysex);
    }

    //======================================================================
    // HELPERS
    //======================================================================

    _reset(success, data = null) {
        this.state = TRANSPORT_CONST.STATE_IDLE;
        this.txData = null;

        if (this.completeFn) {
            this.completeFn(data, success);
        }
    }
}
