/**
 * Firmware Uploader — manages firmware upload lifecycle
 *
 * Handles erase → transfer → verify phases with progress tracking.
 * Extracted from UnifiedDeviceAPI to isolate firmware upload state.
 */

class FirmwareUploader {
    constructor(sendFn, transport, logFn) {
        this._sendFn = sendFn;          // (sysexData) => void
        this._transport = transport;      // ChunkedTransport instance
        this._log = logFn || (() => {});

        this._active = false;
        this._progressCallback = null;

        // Erase phase
        this._firmwareReadyResolve = null;
        this._firmwareReadyReject = null;
        this._eraseTimeoutHandle = null;

        // Transfer phase (per-segment)
        this._segmentResolve = null;
        this._segmentReject = null;
        this._segmentTimeoutHandle = null;

        // Verify phase
        this._firmwareResolve = null;
        this._firmwareReject = null;
        this._verifyTimeoutHandle = null;
    }

    get active() {
        return this._active;
    }

    /**
     * Upload firmware binary to device
     * Three phases: erase → transfer segments → verify
     * @param {Uint8Array} firmwareBin - Firmware binary data
     * @param {Function} progressCallback - ({ phase, percent, ... }) => void
     * @returns {Promise<Object>} - Final firmware response from device
     */
    async upload(firmwareBin, progressCallback) {
        const SEGMENT_SIZE = 32768;  // 32KB
        const totalSize = firmwareBin.length;
        const totalSegments = Math.ceil(totalSize / SEGMENT_SIZE);

        this._active = true;
        this._progressCallback = progressCallback;
        this._log(`Firmware: ${totalSize} bytes, ${totalSegments} segments`);

        try {
            // Phase 1: Send upload command and wait for erase to complete
            const readyResponse = await this._waitForFirmwareReady(totalSize);
            this._log(`Device ready: segment_size=${readyResponse.segment_size || SEGMENT_SIZE}`);

            if (progressCallback) {
                progressCallback({ phase: 'transferring', percent: 0 });
            }

            // Phase 2: Send each segment via chunked transport
            for (let i = 0; i < totalSegments; i++) {
                const offset = i * SEGMENT_SIZE;
                const segment = firmwareBin.slice(offset, offset + SEGMENT_SIZE);
                this._log(`Sending segment ${i + 1}/${totalSegments} (${segment.length} bytes)`);
                await this._sendFirmwareSegment(segment, i);
            }

            // Phase 3: Wait for firmware verification
            return await new Promise((resolve, reject) => {
                this._firmwareResolve = resolve;
                this._firmwareReject = reject;

                this._verifyTimeoutHandle = setTimeout(() => {
                    this._firmwareResolve = null;
                    this._firmwareReject = null;
                    this._verifyTimeoutHandle = null;
                    reject(new Error('Firmware verification timeout'));
                }, 30000);
            });
        } catch (err) {
            this._reset();
            throw err;
        }
    }

    /**
     * Handle a firmware-related response from the device
     * @param {string} responseType - Classified response type
     * @param {Object} json - Parsed response JSON
     * @returns {boolean} - true if response was handled
     */
    handleResponse(responseType, json) {
        switch (responseType) {
            case 'erasing':
                this._log(`Erase started: ${json.sectors} sectors`);
                if (this._progressCallback) {
                    this._progressCallback({ phase: 'erasing', percent: 0, sectors: json.sectors });
                }
                return true;

            case 'erase-progress':
                this._log(`Erase: ${json.sector}/${json.total} (${json.percent}%)`);
                if (this._progressCallback) {
                    this._progressCallback({
                        phase: 'erasing', percent: json.percent,
                        sector: json.sector, total: json.total
                    });
                }
                return true;

            case 'ready-for-firmware':
                this._log('Erase complete, device ready');
                if (this._firmwareReadyResolve) {
                    clearTimeout(this._eraseTimeoutHandle);
                    this._eraseTimeoutHandle = null;
                    const resolve = this._firmwareReadyResolve;
                    this._firmwareReadyResolve = null;
                    this._firmwareReadyReject = null;
                    resolve(json);
                }
                return true;

            case 'segment-done':
                this._log(`Segment ${json.segment} done, progress: ${json.progress}%`);
                if (this._segmentResolve) {
                    clearTimeout(this._segmentTimeoutHandle);
                    this._segmentTimeoutHandle = null;
                    const resolve = this._segmentResolve;
                    this._segmentResolve = null;
                    this._segmentReject = null;
                    resolve(json);
                }
                if (this._progressCallback) {
                    this._progressCallback({ phase: 'transferring', percent: json.progress });
                }
                return true;

            case 'flashing-progress':
                this._log(`Flashing: ${json.progress}%`);
                if (this._progressCallback) {
                    this._progressCallback({ phase: 'flashing', percent: json.progress });
                }
                return true;

            case 'firmware-ready':
                this._log('Firmware written successfully');
                if (this._progressCallback) {
                    this._progressCallback({ phase: 'complete', percent: 100 });
                }
                if (this._firmwareResolve) {
                    const resolve = this._firmwareResolve;
                    this._reset();
                    resolve(json);
                }
                return true;

            case 'firmware-validated':
                this._log('Firmware validated, awaiting restart');
                if (this._progressCallback) {
                    this._progressCallback({ phase: 'validated', percent: 100 });
                }
                if (this._firmwareResolve) {
                    const resolve = this._firmwareResolve;
                    this._reset();
                    resolve(json);
                }
                return true;

            case 'error':
                this._log(`Firmware error: ${json.error}`, 'error');
                this._rejectActive(new Error(json.error));
                return true;

            default:
                return false;
        }
    }

    /**
     * Handle transport transfer failure during segment send
     * @returns {boolean} - true if a segment failure was handled
     */
    handleTransportFailure() {
        if (this._segmentReject) {
            clearTimeout(this._segmentTimeoutHandle);
            this._segmentTimeoutHandle = null;
            const reject = this._segmentReject;
            this._segmentResolve = null;
            this._segmentReject = null;
            reject(new Error('Segment transport failed'));
            return true;
        }
        return false;
    }

    /**
     * Abort any active upload, rejecting pending promises
     */
    abort() {
        if (!this._active) return;
        this._rejectActive(new Error('Upload aborted'));
    }

    // --- Private ---

    _waitForFirmwareReady(totalSize) {
        return new Promise((resolve, reject) => {
            this._firmwareReadyResolve = resolve;
            this._firmwareReadyReject = reject;

            this._eraseTimeoutHandle = setTimeout(() => {
                this._firmwareReadyResolve = null;
                this._firmwareReadyReject = null;
                this._eraseTimeoutHandle = null;
                reject(new Error('Firmware erase timeout'));
            }, 120000);

            const cmdObj = { cmd: 'upload-firmware', size: totalSize };
            const sysex = encodeJsonToSysEx(cmdObj);
            this._sendFn(sysex);
            this._log(`upload-firmware (size=${totalSize})`, 'tx');
        });
    }

    _sendFirmwareSegment(segment, index) {
        return new Promise((resolve, reject) => {
            this._segmentResolve = resolve;
            this._segmentReject = reject;

            this._segmentTimeoutHandle = setTimeout(() => {
                this._segmentResolve = null;
                this._segmentReject = null;
                this._segmentTimeoutHandle = null;
                reject(new Error(`Segment ${index} timeout`));
            }, 60000);

            if (!this._transport.send(segment)) {
                clearTimeout(this._segmentTimeoutHandle);
                this._segmentTimeoutHandle = null;
                this._segmentResolve = null;
                this._segmentReject = null;
                reject(new Error('Transport busy'));
            }
        });
    }

    _rejectActive(error) {
        const reject = this._firmwareReadyReject || this._segmentReject || this._firmwareReject;
        this._reset();
        if (reject) reject(error);
    }

    _reset() {
        if (this._eraseTimeoutHandle) clearTimeout(this._eraseTimeoutHandle);
        if (this._segmentTimeoutHandle) clearTimeout(this._segmentTimeoutHandle);
        if (this._verifyTimeoutHandle) clearTimeout(this._verifyTimeoutHandle);
        this._eraseTimeoutHandle = null;
        this._segmentTimeoutHandle = null;
        this._verifyTimeoutHandle = null;
        this._firmwareReadyResolve = null;
        this._firmwareReadyReject = null;
        this._segmentResolve = null;
        this._segmentReject = null;
        this._firmwareResolve = null;
        this._firmwareReject = null;
        this._progressCallback = null;
        this._active = false;
    }
}

window.FirmwareUploader = FirmwareUploader;
