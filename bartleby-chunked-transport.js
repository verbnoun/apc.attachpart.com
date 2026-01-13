/**
 * Chunked Transport Protocol for Bartleby Communication
 *
 * PURE LOGIC - No display/UI code
 *
 * Reliable bidirectional transfer of large payloads over MIDI SysEx
 * Based on ap_sysex_transport.c from lib/ap_sysex_transport/
 */

//======================================================================
// CONSTANTS
//======================================================================

const BARTLEBY_TRANSPORT_CONST = {
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

class BartlebyChunkedTransport {
    /**
     * @param {Function} sendFn - callback(sysexData) to send complete SysEx message
     * @param {Function} completeFn - callback(data, success) when transfer completes
     * @param {Function} timeFn - callback() returns current time in milliseconds
     * @param {Function} logFn - callback(message, type) to log to UI (optional)
     */
    constructor(sendFn, completeFn, timeFn, logFn) {
        this.sendFn = sendFn;
        this.completeFn = completeFn;
        this.timeFn = timeFn;
        this.logFn = logFn || ((msg) => console.log(msg));

        // Current state
        this.state = BARTLEBY_TRANSPORT_CONST.STATE_IDLE;

        // Sender state
        this.txData = null;
        this.txTotalBytes = 0;
        this.txTotalChunks = 0;
        this.txCurrentChunk = 0;
        this.txRetryCount = 0;
        this.txLastSendTime = 0;
        this.txStartAcked = false;

        // Receiver state
        this.rxBuffer = new Uint8Array(BARTLEBY_TRANSPORT_CONST.MAX_BUFFER_SIZE);
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
        if (this.state !== BARTLEBY_TRANSPORT_CONST.STATE_IDLE) {
            this.logFn('Cannot send: busy in state ' + this.state, 'error');
            return false;
        }

        this.txData = data;
        this.txTotalBytes = data.length;
        this.txTotalChunks = Math.ceil(data.length / BARTLEBY_TRANSPORT_CONST.CHUNK_SIZE);
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
            case BARTLEBY_TRANSPORT_CONST.MSG_START:
                this._handleStart(data);
                break;
            case BARTLEBY_TRANSPORT_CONST.MSG_CHUNK:
                this._handleChunk(data);
                break;
            case BARTLEBY_TRANSPORT_CONST.MSG_ACK:
                this._handleAck(data);
                break;
            case BARTLEBY_TRANSPORT_CONST.MSG_NAK:
                this._handleNak(data);
                break;
            case BARTLEBY_TRANSPORT_CONST.MSG_END:
                this._handleEnd(data);
                break;
            case BARTLEBY_TRANSPORT_CONST.MSG_COMPLETE:
                this._handleComplete(data);
                break;
            case BARTLEBY_TRANSPORT_CONST.MSG_ABORT:
                this._handleAbort(data);
                break;
            default:
                console.warn('[BartlebyTransport] Unknown message type:', msgType);
        }
    }

    /**
     * Call periodically to handle timeouts
     */
    task() {
        if (this.state !== BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK &&
            this.state !== BARTLEBY_TRANSPORT_CONST.STATE_WAIT_COMPLETE) {
            return;
        }

        const now = this.timeFn();
        const elapsed = now - this.txLastSendTime;

        if (elapsed > BARTLEBY_TRANSPORT_CONST.TIMEOUT_MS) {
            console.warn('[BartlebyTransport] Timeout in state', this.state);
            this._handleTimeout();
        }
    }

    /**
     * Abort current transfer
     */
    abort() {
        if (this.state === BARTLEBY_TRANSPORT_CONST.STATE_IDLE) return;

        console.log('[BartlebyTransport] Aborting transfer');
        this._sendAbort(0x00);
        this._reset(false);
    }

    //======================================================================
    // RECEIVER HANDLERS
    //======================================================================

    _handleStart(data) {
        if (data.length < 7) {
            console.error('[BartlebyTransport] START too short');
            return;
        }

        this.rxTotalChunks = (data[1] << 8) | data[2];
        const totalBytes = (data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6];

        if (totalBytes > BARTLEBY_TRANSPORT_CONST.MAX_BUFFER_SIZE) {
            console.error('[BartlebyTransport] Buffer too small for', totalBytes, 'bytes');
            this._sendNak(0, BARTLEBY_TRANSPORT_CONST.ERR_BUFFER_FULL);
            return;
        }

        this.rxReceivedBytes = 0;
        this.rxExpectedChunk = 0;
        this.state = BARTLEBY_TRANSPORT_CONST.STATE_RECEIVING;

        console.log(`[BartlebyTransport] RX START: ${totalBytes} bytes, ${this.rxTotalChunks} chunks`);
        this._sendAck(0xFFFF);  // ACK START with special sequence
    }

    _handleChunk(data) {
        if (this.state !== BARTLEBY_TRANSPORT_CONST.STATE_RECEIVING) {
            console.error('[BartlebyTransport] CHUNK but not receiving');
            return;
        }

        if (data.length < 6) {
            console.error('[BartlebyTransport] CHUNK too short');
            return;
        }

        const seq = (data[1] << 8) | data[2];
        const chunkLen = data[3] === 0 ? 256 : data[3];  // 0 means 256

        if (data.length < 4 + chunkLen + 2) {
            console.error('[BartlebyTransport] CHUNK payload incomplete');
            this._sendNak(seq, BARTLEBY_TRANSPORT_CONST.ERR_CRC_FAIL);
            return;
        }

        // Extract payload and CRC
        const payload = data.slice(4, 4 + chunkLen);
        const receivedCrc = (data[4 + chunkLen] << 8) | data[4 + chunkLen + 1];
        const computedCrc = bartlebyCrc16(payload);

        if (receivedCrc !== computedCrc) {
            console.error(`[BartlebyTransport] CHUNK ${seq} CRC mismatch: got ${receivedCrc.toString(16)}, expected ${computedCrc.toString(16)}`);
            this._sendNak(seq, BARTLEBY_TRANSPORT_CONST.ERR_CRC_FAIL);
            return;
        }

        // Check sequence
        if (seq !== this.rxExpectedChunk) {
            if (seq === this.rxExpectedChunk - 1) {
                // Duplicate, just re-ACK
                console.log(`[BartlebyTransport] CHUNK ${seq} duplicate, re-ACK`);
                this._sendAck(seq);
            } else {
                console.error(`[BartlebyTransport] CHUNK out of sequence: got ${seq}, expected ${this.rxExpectedChunk}`);
                this._sendNak(seq, BARTLEBY_TRANSPORT_CONST.ERR_OUT_OF_SEQ);
            }
            return;
        }

        // Check buffer space
        if (this.rxReceivedBytes + chunkLen > BARTLEBY_TRANSPORT_CONST.MAX_BUFFER_SIZE) {
            console.error('[BartlebyTransport] CHUNK would overflow buffer');
            this._sendNak(seq, BARTLEBY_TRANSPORT_CONST.ERR_BUFFER_FULL);
            return;
        }

        // Store chunk
        this.rxBuffer.set(payload, this.rxReceivedBytes);
        this.rxReceivedBytes += chunkLen;
        this.rxExpectedChunk++;

        console.log(`[BartlebyTransport] RX CHUNK ${seq}: ${chunkLen} bytes (${this.rxReceivedBytes}/${this.txTotalBytes || '?'} total)`);
        this._sendAck(seq);
    }

    _handleEnd(data) {
        if (this.state !== BARTLEBY_TRANSPORT_CONST.STATE_RECEIVING) {
            console.error('[BartlebyTransport] END but not receiving');
            return;
        }

        if (data.length < 9) {
            console.error('[BartlebyTransport] END too short');
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
        const computedCrc = bartlebyCrc32(receivedData);

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
            console.error('[BartlebyTransport] ACK too short');
            return;
        }

        const seq = (data[1] << 8) | data[2];

        if (this.state === BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK && !this.txStartAcked) {
            // ACK for START
            if (seq !== 0xFFFF) {
                console.warn('[BartlebyTransport] Expected START ACK (0xFFFF), got', seq);
                return;
            }

            console.log('[BartlebyTransport] TX START ACK received');
            this.txStartAcked = true;
            this.txCurrentChunk = 0;
            this.state = BARTLEBY_TRANSPORT_CONST.STATE_SENDING;
            this._sendNextChunk();

        } else if (this.state === BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK && this.txStartAcked) {
            // ACK for CHUNK
            if (seq !== this.txCurrentChunk) {
                console.warn(`[BartlebyTransport] ACK sequence mismatch: got ${seq}, expected ${this.txCurrentChunk}`);
                return;
            }

            console.log(`[BartlebyTransport] TX CHUNK ${seq} ACK received`);
            this.txCurrentChunk++;
            this.txRetryCount = 0;
            this.state = BARTLEBY_TRANSPORT_CONST.STATE_SENDING;
            this._sendNextChunk();
        }
    }

    _handleNak(data) {
        if (data.length < 4) {
            console.error('[BartlebyTransport] NAK too short');
            return;
        }

        const seq = (data[1] << 8) | data[2];
        const error = data[3];

        console.error(`[BartlebyTransport] NAK received for seq ${seq}, error ${error}`);

        // Retry current message
        this._handleTimeout();
    }

    _handleComplete(data) {
        if (this.state !== BARTLEBY_TRANSPORT_CONST.STATE_WAIT_COMPLETE) {
            console.warn('[BartlebyTransport] COMPLETE but not waiting');
            return;
        }

        if (data.length < 2) {
            console.error('[BartlebyTransport] COMPLETE too short');
            return;
        }

        const status = data[1];

        if (status === 0x00) {
            console.log('[BartlebyTransport] TX COMPLETE: transfer successful');
            this._reset(true);
        } else {
            console.error('[BartlebyTransport] TX COMPLETE: transfer failed with status', status);
            this._reset(false);
        }
    }

    _handleAbort(data) {
        console.warn('[BartlebyTransport] ABORT received');
        this._reset(false);
    }

    _handleTimeout() {
        this.txRetryCount++;

        if (this.txRetryCount > BARTLEBY_TRANSPORT_CONST.MAX_RETRIES) {
            console.error('[BartlebyTransport] Max retries exceeded');
            this._sendAbort(BARTLEBY_TRANSPORT_CONST.ERR_MAX_RETRIES);
            this._reset(false);
            return;
        }

        console.warn(`[BartlebyTransport] Retry ${this.txRetryCount}/${BARTLEBY_TRANSPORT_CONST.MAX_RETRIES}`);

        // Retransmit based on state
        if (this.state === BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK && !this.txStartAcked) {
            this._sendStart();
        } else if (this.state === BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK && this.txStartAcked) {
            this._sendChunk(this.txCurrentChunk);
        } else if (this.state === BARTLEBY_TRANSPORT_CONST.STATE_WAIT_COMPLETE) {
            this._sendEnd();
        }
    }

    //======================================================================
    // MESSAGE BUILDERS & SENDERS
    //======================================================================

    _sendStart() {
        const msg = new Uint8Array(7);
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_START;
        msg[1] = (this.txTotalChunks >> 8) & 0xFF;
        msg[2] = this.txTotalChunks & 0xFF;
        msg[3] = (this.txTotalBytes >> 24) & 0xFF;
        msg[4] = (this.txTotalBytes >> 16) & 0xFF;
        msg[5] = (this.txTotalBytes >> 8) & 0xFF;
        msg[6] = this.txTotalBytes & 0xFF;

        console.log('[BartlebyTransport] TX START');
        this.state = BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK;
        this.txLastSendTime = this.timeFn();
        return this._encodeAndSend(msg);
    }

    _sendChunk(chunkNum) {
        const offset = chunkNum * BARTLEBY_TRANSPORT_CONST.CHUNK_SIZE;
        const remaining = this.txTotalBytes - offset;
        const chunkLen = Math.min(BARTLEBY_TRANSPORT_CONST.CHUNK_SIZE, remaining);

        const payload = this.txData.slice(offset, offset + chunkLen);
        const crcValue = bartlebyCrc16(payload);

        const msg = new Uint8Array(4 + chunkLen + 2);
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_CHUNK;
        msg[1] = (chunkNum >> 8) & 0xFF;
        msg[2] = chunkNum & 0xFF;
        msg[3] = chunkLen & 0xFF;  // 256 becomes 0
        msg.set(payload, 4);
        msg[4 + chunkLen] = (crcValue >> 8) & 0xFF;
        msg[4 + chunkLen + 1] = crcValue & 0xFF;

        console.log(`[BartlebyTransport] TX CHUNK ${chunkNum}: ${chunkLen} bytes`);
        this.state = BARTLEBY_TRANSPORT_CONST.STATE_WAIT_ACK;
        this.txLastSendTime = this.timeFn();
        return this._encodeAndSend(msg);
    }

    _sendEnd() {
        const crcValue = bartlebyCrc32(this.txData);

        const msg = new Uint8Array(9);
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_END;
        msg[1] = (this.txTotalBytes >> 24) & 0xFF;
        msg[2] = (this.txTotalBytes >> 16) & 0xFF;
        msg[3] = (this.txTotalBytes >> 8) & 0xFF;
        msg[4] = this.txTotalBytes & 0xFF;
        msg[5] = (crcValue >> 24) & 0xFF;
        msg[6] = (crcValue >> 16) & 0xFF;
        msg[7] = (crcValue >> 8) & 0xFF;
        msg[8] = crcValue & 0xFF;

        console.log('[BartlebyTransport] TX END');
        this.state = BARTLEBY_TRANSPORT_CONST.STATE_WAIT_COMPLETE;
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
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_ACK;
        msg[1] = (seq >> 8) & 0xFF;
        msg[2] = seq & 0xFF;

        console.log(`[BartlebyTransport] TX ACK ${seq === 0xFFFF ? 'START' : seq}`);
        this._encodeAndSend(msg);
    }

    _sendNak(seq, error) {
        const msg = new Uint8Array(4);
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_NAK;
        msg[1] = (seq >> 8) & 0xFF;
        msg[2] = seq & 0xFF;
        msg[3] = error;

        console.log(`[BartlebyTransport] TX NAK ${seq}, error ${error}`);
        this._encodeAndSend(msg);
    }

    _sendComplete(status) {
        const msg = new Uint8Array(2);
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_COMPLETE;
        msg[1] = status;

        console.log(`[BartlebyTransport] TX COMPLETE status ${status}`);
        this._encodeAndSend(msg);
    }

    _sendAbort(reason) {
        const msg = new Uint8Array(2);
        msg[0] = BARTLEBY_TRANSPORT_CONST.MSG_ABORT;
        msg[1] = reason;

        console.log(`[BartlebyTransport] TX ABORT reason ${reason}`);
        this._encodeAndSend(msg);
    }

    /**
     * Encode transport message with mcoded7 and wrap in SysEx
     */
    _encodeAndSend(msg) {
        // mcoded7 encode
        const encoded = bartlebyMcoded7Encode(msg);

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
        this.state = BARTLEBY_TRANSPORT_CONST.STATE_IDLE;
        this.txData = null;

        if (this.completeFn) {
            this.completeFn(data, success);
        }
    }
}
