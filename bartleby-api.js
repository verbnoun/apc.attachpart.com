/**
 * Bartleby API - Device Communication Layer
 *
 * PURE LOGIC - No display/UI code
 *
 * Communication flow:
 *   Web → Bartleby: Simple SysEx (small JSON commands)
 *   Bartleby → Web: Chunked Transport (large JSON responses)
 *
 * Design: Thin client - device is authority, no local state storage.
 * Connection is managed by DeviceRegistry - this class only handles communication.
 */

//======================================================================
// CONSTANTS
//======================================================================

const BARTLEBY_SYSEX_MANUFACTURER_ID = 0x7D;  // Educational/Development
const BARTLEBY_SYSEX_DEVICE_ID = 0x00;        // Broadcast

//======================================================================
// BARTLEBY API CLASS
//======================================================================

class BartlebyAPI {
    constructor() {
        // Connection state (set by connectToDevice)
        this.midiInput = null;
        this.midiOutput = null;

        // Command state (single command at a time)
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmd = null;

        // SysEx assembly buffer
        this._sysexBuffer = [];
        this._inSysex = false;

        // Log callback
        this._logFn = null;

        // Chunked transport for receiving large responses
        this._transport = null;
        this._transportTaskInterval = null;

        // Callbacks (device-driven broadcasts)
        this._onSaveStatusChanged = null;
    }

    //======================================================================
    // PUBLIC: Connection (called by app after DeviceRegistry detects device)
    //======================================================================

    /**
     * Connect to Bartleby device
     * NOTE: Does NOT set onmidimessage - DeviceRegistry owns the MIDI input handler
     * and calls handleMidiMessage() for SysEx routing.
     *
     * @param {MIDIInput} input - MIDI input port
     * @param {MIDIOutput} output - MIDI output port
     * @param {Function} logFn - Optional log callback(message, type)
     */
    connectToDevice(input, output, logFn = null) {
        this.midiInput = input;
        this.midiOutput = output;
        this._logFn = logFn;

        // Initialize chunked transport for receiving responses
        this._initTransport();

        // NOTE: Do NOT set onmidimessage here - DeviceRegistry manages it
        // and routes SysEx to us via handleMidiMessage()

        this._log(`Connected to ${input.name}`);
    }

    /**
     * Handle incoming MIDI message (called by DeviceRegistry for SysEx)
     * @param {MIDIMessageEvent} event - MIDI message event
     */
    handleMidiMessage(event) {
        this._handleMidiMessage(event);
    }

    /**
     * Disconnect from device
     */
    disconnect() {
        this._handleDeviceDisconnected();
    }

    /**
     * Check if connected to device
     * @returns {boolean}
     */
    isConnected() {
        return this.midiInput !== null && this.midiOutput !== null;
    }

    //======================================================================
    // PUBLIC: Config API Commands
    //======================================================================

    /**
     * Initialize editor session
     * Transitions device to EDITOR state (forces MPE mode)
     *
     * Polls every 1s until device responds (device may ignore during HANDSHAKE).
     *
     * @returns {Promise<Object>} - { status: "editor-active", config: {...} }
     */
    async init() {
        const POLL_INTERVAL_MS = 1000;

        while (true) {
            if (!this.isConnected()) {
                throw new Error('Not connected to device');
            }

            const responsePromise = this._sendCommand({ cmd: 'init' });

            const result = await Promise.race([
                responsePromise.then(r => ({ type: 'response', data: r })),
                new Promise(r => setTimeout(() => r({ type: 'poll' }), POLL_INTERVAL_MS))
            ]);

            if (result.type === 'response') {
                return result.data;
            }

            this._clearPending();
            this._log('Init: polling...', 'info');
        }
    }

    /**
     * Exit editor session without saving
     * @returns {Promise<Object>} - { status: "editor-inactive" }
     */
    async eject() {
        return this._sendCommand({ cmd: 'eject' });
    }

    /**
     * Save config to flash and exit editor
     * @returns {Promise<Object>}
     */
    async saveAndExit() {
        return this._sendCommand({ cmd: 'save-and-exit' });
    }

    /**
     * Get current config (must be in EDITOR state)
     * @returns {Promise<Object>} - { status: "config", config: {...} }
     */
    async getConfig() {
        return this._sendCommand({ cmd: 'config-get' });
    }

    /**
     * Set config (must be in EDITOR state)
     * @param {Object} config - Partial or full config object
     * @returns {Promise<Object>} - { status: "config", config: {...} }
     */
    async setConfig(config) {
        return this._sendCommand({ cmd: 'config-set', ...config });
    }

    /**
     * Manual save - triggers immediate save to flash
     * @returns {Promise<Object>}
     */
    async save() {
        return this._sendCommand({ cmd: 'save' });
    }

    /**
     * Get device info including firmware version
     * @returns {Promise<Object>} - { project, version, versionNumber }
     */
    async getDeviceInfo() {
        return this._sendCommand({ cmd: 'get-device-info' });
    }

    /**
     * Factory reset config to defaults
     * WARNING: Device will reboot after reset
     * @returns {Promise<Object>}
     */
    async configReset() {
        return this._sendCommand({ cmd: 'config-reset' });
    }

    //======================================================================
    // PUBLIC: Firmware Update Commands
    //======================================================================

    /**
     * Upload firmware binary to device staging area
     * Flow:
     *   1. Send upload-firmware command with size
     *   2. Device erases staging area, sends progress
     *   3. Device sends ready-for-firmware
     *   4. Send firmware data via chunked transport
     *   5. Device validates and sends firmware-ready
     *
     * @param {Uint8Array} firmwareBin - Firmware binary data
     * @param {Function} progressCallback - Progress callback({phase, percent})
     * @returns {Promise} Resolves when firmware is staged and ready
     */
    async uploadFirmware(firmwareBin, progressCallback) {
        const totalSize = firmwareBin.length;
        this._firmwareProgressCallback = progressCallback;

        this._log(`Firmware: ${totalSize} bytes`);

        // Step 1: Send command and wait for device to be ready
        const readyResponse = await this._waitForFirmwareReady(totalSize);
        this._log(`Device ready for firmware`);

        if (progressCallback) {
            progressCallback({ phase: 'transferring', percent: 0 });
        }

        // Step 2: Send firmware via transport
        return new Promise((resolve, reject) => {
            this._firmwareResolve = resolve;
            this._firmwareReject = reject;

            // Send firmware data
            if (!this._transport.send(firmwareBin)) {
                this._firmwareProgressCallback = null;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                reject(new Error('Transport busy'));
                return;
            }

            // Timeout for transfer + validation (60 seconds)
            this._firmwareTimeoutHandle = setTimeout(() => {
                this._firmwareProgressCallback = null;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                reject(new Error('Firmware upload timeout'));
            }, 60000);
        });
    }

    /**
     * Wait for device to be ready for firmware data
     * @private
     */
    _waitForFirmwareReady(totalSize) {
        return new Promise((resolve, reject) => {
            this._firmwareReadyResolve = resolve;
            this._firmwareReadyReject = reject;

            // Timeout for erase (2 minutes)
            this._eraseTimeoutHandle = setTimeout(() => {
                this._firmwareReadyResolve = null;
                this._firmwareReadyReject = null;
                reject(new Error('Firmware erase timeout'));
            }, 120000);

            // Send command
            const cmdObj = { cmd: 'upload-firmware', size: totalSize };
            const jsonStr = JSON.stringify(cmdObj);
            const jsonBytes = new TextEncoder().encode(jsonStr);

            const sysex = new Uint8Array(3 + jsonBytes.length + 1);
            sysex[0] = 0xF0;
            sysex[1] = BARTLEBY_SYSEX_MANUFACTURER_ID;
            sysex[2] = BARTLEBY_SYSEX_DEVICE_ID;
            sysex.set(jsonBytes, 3);
            sysex[sysex.length - 1] = 0xF7;

            this._log(`TX: upload-firmware (size=${totalSize})`, 'tx');
            this.midiOutput.send(sysex);
        });
    }

    /**
     * Restart device to boot staged firmware
     * Connection will be lost after this call.
     * @returns {Promise<Object>}
     */
    async restartDevice() {
        return this._sendCommand({ cmd: 'restart-device' });
    }

    /**
     * Register callback for save status changes (device-driven)
     * @param {Function} callback - Called with status: 'saved' | 'saving' | 'unsaved'
     */
    onSaveStatusChanged(callback) {
        this._onSaveStatusChanged = callback;
    }

    //======================================================================
    // PUBLIC: Task Loop
    //======================================================================

    /**
     * Call periodically (e.g., every 100ms) to handle transport timeouts
     */
    task() {
        if (this._transport) {
            this._transport.task();
        }
    }

    //======================================================================
    // PRIVATE: Transport Initialization
    //======================================================================

    _initTransport() {
        this._transport = new BartlebyChunkedTransport(
            // Send function
            (sysexData) => {
                if (this.midiOutput) {
                    this.midiOutput.send(sysexData);
                    return true;
                }
                return false;
            },
            // Complete function
            (data, success) => {
                if (success && data) {
                    try {
                        const jsonStr = new TextDecoder().decode(data);
                        this._log(`RX (transport): ${jsonStr.substring(0, 100)}...`, 'rx');
                        const response = JSON.parse(jsonStr);
                        this._handleResponse(response);
                    } catch (e) {
                        this._log(`JSON parse error: ${e.message}`, 'error');
                        if (this._pendingReject) {
                            const reject = this._pendingReject;
                            this._clearPending();
                            reject(new Error(`JSON parse error: ${e.message}`));
                        }
                    }
                } else {
                    this._log('Transport transfer failed', 'error');
                    if (this._pendingReject) {
                        const reject = this._pendingReject;
                        this._clearPending();
                        reject(new Error('Transport transfer failed'));
                    }
                }
            },
            // Time function
            () => Date.now(),
            // Log function
            (msg, type) => this._log(msg, type || 'transport')
        );
    }

    //======================================================================
    // PRIVATE: MIDI Communication
    //======================================================================

    _sendCommand(cmdObj) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected()) {
                reject(new Error('Not connected to device'));
                return;
            }

            if (this._pendingResolve) {
                reject(new Error('Command already in progress'));
                return;
            }

            this._pendingResolve = resolve;
            this._pendingReject = reject;
            this._pendingCmd = cmdObj.cmd;

            const jsonStr = JSON.stringify(cmdObj);
            const jsonBytes = new TextEncoder().encode(jsonStr);

            // SysEx format: F0 7D 00 <json bytes> F7
            const sysex = new Uint8Array(3 + jsonBytes.length + 1);
            sysex[0] = 0xF0;
            sysex[1] = BARTLEBY_SYSEX_MANUFACTURER_ID;
            sysex[2] = BARTLEBY_SYSEX_DEVICE_ID;
            sysex.set(jsonBytes, 3);
            sysex[sysex.length - 1] = 0xF7;

            this._log(`TX: ${jsonStr}`, 'tx');
            this.midiOutput.send(sysex);
        });
    }

    _handleMidiMessage(event) {
        const data = event.data;

        // SysEx handling
        if (data[0] === 0xF0) {
            this._sysexBuffer = Array.from(data);
            this._inSysex = !data.includes(0xF7);
        } else if (this._inSysex) {
            this._sysexBuffer.push(...data);
            if (data.includes(0xF7)) {
                this._inSysex = false;
            }
        }

        if (this._sysexBuffer.length > 0 && this._sysexBuffer[this._sysexBuffer.length - 1] === 0xF7) {
            this._processSysex(new Uint8Array(this._sysexBuffer));
            this._sysexBuffer = [];
        }
    }

    _processSysex(sysex) {
        // Check manufacturer ID
        if (sysex.length < 5 || sysex[1] !== BARTLEBY_SYSEX_MANUFACTURER_ID || sysex[2] !== BARTLEBY_SYSEX_DEVICE_ID) {
            return;
        }

        // Extract and decode payload
        const payload = sysex.slice(3, -1);
        if (payload.length === 0) return;

        const decoded = bartlebyMcoded7Decode(payload);
        if (decoded.length === 0) {
            this._log('Empty decoded payload', 'warn');
            return;
        }

        const msgType = decoded[0];

        // Transport protocol messages (0x01-0x07)
        if (msgType >= BARTLEBY_TRANSPORT_CONST.MSG_START && msgType <= BARTLEBY_TRANSPORT_CONST.MSG_ABORT) {
            if (this._transport) {
                this._transport.receive(decoded);
            }
            return;
        }

        // JSON response
        try {
            const jsonStr = new TextDecoder().decode(decoded);
            this._log(`RX: ${jsonStr.substring(0, 80)}...`, 'rx');
            const response = JSON.parse(jsonStr);
            this._handleResponse(response);
        } catch (e) {
            this._log(`JSON parse error: ${e.message}`, 'error');
        }
    }

    _handleResponse(response) {
        // Handle save-status broadcast
        if (response.status === 'save-status' && response.state) {
            this._log(`Save status: ${response.state}`, 'info');
            this._onSaveStatusChanged?.(response.state);

            if (this._pendingCmd === 'save' && this._pendingResolve) {
                const resolve = this._pendingResolve;
                this._clearPending();
                resolve(response);
            }
            return;
        }

        // Handle firmware update responses
        if (response.status === 'erasing') {
            this._log(`Erase started`);
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'erasing', percent: 0 });
            }
            return;
        }

        if (response.status === 'erase-progress') {
            this._log(`Erase: ${response.percent}%`);
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'erasing', percent: response.percent });
            }
            return;
        }

        if (response.status === 'ready-for-firmware') {
            this._log(`Device ready for firmware data`);
            if (this._eraseTimeoutHandle) {
                clearTimeout(this._eraseTimeoutHandle);
                this._eraseTimeoutHandle = null;
            }
            if (this._firmwareReadyResolve) {
                const resolve = this._firmwareReadyResolve;
                this._firmwareReadyResolve = null;
                this._firmwareReadyReject = null;
                resolve(response);
            }
            return;
        }

        if (response.status === 'transfer-progress') {
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'transferring', percent: response.percent });
            }
            return;
        }

        if (response.status === 'firmware-ready' || response.status === 'firmware-validated') {
            this._log('Firmware staged successfully');
            if (this._firmwareTimeoutHandle) {
                clearTimeout(this._firmwareTimeoutHandle);
                this._firmwareTimeoutHandle = null;
            }
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'complete', percent: 100 });
            }
            if (this._firmwareResolve) {
                const resolve = this._firmwareResolve;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                this._firmwareProgressCallback = null;
                resolve(response);
            }
            return;
        }

        // Handle firmware error
        if (response.status === 'error' && (this._firmwareReadyReject || this._firmwareReject)) {
            this._log(`Firmware error: ${response.message}`, 'error');
            if (this._eraseTimeoutHandle) {
                clearTimeout(this._eraseTimeoutHandle);
                this._eraseTimeoutHandle = null;
            }
            if (this._firmwareTimeoutHandle) {
                clearTimeout(this._firmwareTimeoutHandle);
                this._firmwareTimeoutHandle = null;
            }
            const reject = this._firmwareReadyReject || this._firmwareReject;
            this._firmwareReadyResolve = null;
            this._firmwareReadyReject = null;
            this._firmwareResolve = null;
            this._firmwareReject = null;
            this._firmwareProgressCallback = null;
            reject(new Error(response.message));
            return;
        }

        if (this._pendingResolve) {
            const resolve = this._pendingResolve;
            this._clearPending();

            if (response.status === 'error') {
                this._log(`Error: ${response.message}`, 'error');
            }

            resolve(response);
        }
    }

    _clearPending() {
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmd = null;
    }

    _handleDeviceDisconnected() {
        if (this._transport) {
            this._transport.abort();
        }

        if (this._pendingReject) {
            const reject = this._pendingReject;
            this._clearPending();
            reject(new Error('Device disconnected'));
        }

        if (this.midiInput) {
            this.midiInput.onmidimessage = null;
            this.midiInput = null;
        }

        this.midiOutput = null;
        this._transport = null;
    }

    _log(message, type = 'info') {
        this._logFn?.(message, type);
    }
}
