/**
 * Unified Device API - Capability-Based Device Communication
 *
 * Single API class for all AttachPart devices (Candide, Bartleby, etc.)
 * Device capabilities are discovered via get-device-info and determine
 * which commands are available.
 *
 * Design: Thin client - device is authority, no local state storage.
 * Principle: "Host leads the dance" - we initiate all discovery.
 */

//======================================================================
// CONSTANTS
//======================================================================

const API_TIMEOUT_MS = 15000;  // 15 seconds for command timeout

//======================================================================
// UNIFIED DEVICE API CLASS
//======================================================================

class UnifiedDeviceAPI {
    constructor() {
        // Registry reference (API uses registry for all I/O)
        this._registry = null;
        this._portName = null;

        // Transport for chunked messages
        this.transport = null;

        // Device info (populated after discovery)
        this.deviceInfo = null;
        this.capabilities = [];

        // Command state (single command at a time)
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmd = null;
        this._timeoutHandle = null;

        // SysEx assembly buffer
        this._sysexBuffer = [];

        // Firmware update state
        this._firmwareProgressCallback = null;
        this._firmwareResolve = null;
        this._firmwareReject = null;
        this._firmwareReadyResolve = null;
        this._firmwareReadyReject = null;
        this._eraseTimeoutHandle = null;

        // Log callback
        this._logFn = null;

        // Callbacks
        this._onSaveStatusChanged = null;
        this._onExternalPatchChange = null;

        // Incoming command handler (for controller role)
        this._onIncomingCommand = null;
    }

    //======================================================================
    // PUBLIC: Connection & Discovery
    //======================================================================

    /**
     * Set registry and port name for this API
     * API uses registry for all MIDI I/O - never touches ports directly.
     * @param {DeviceRegistry} registry
     * @param {string} portName
     */
    setRegistry(registry, portName) {
        this._registry = registry;
        this._portName = portName;

        // Initialize chunked transport (sends via registry)
        this.transport = new ChunkedTransport(
            (sysexData) => { this._registry.send(this._portName, sysexData); return true; },
            (data, success) => this._handleTransportComplete(data, success),
            () => Date.now(),
            (msg, type) => this._log(msg, type)
        );

        this._log(`API configured for ${portName}`);
    }

    /**
     * Discover device capabilities
     * Sends get-device-info and parses capabilities array.
     * @returns {Promise<boolean>} - true if discovery succeeded
     */
    async discover() {
        this._log('Discovering device capabilities...', 'info');

        try {
            const info = await this._sendCommand({ cmd: 'get-device-info' });

            if (!info) {
                this._log('Discovery failed: no response', 'error');
                return false;
            }

            if (info.status === 'error' || info.error) {
                this._log(`Discovery failed: ${info.error || info.message}`, 'error');
                return false;
            }

            this.deviceInfo = info;

            // Extract capabilities - handle both old and new formats
            if (info.capabilities && Array.isArray(info.capabilities)) {
                this.capabilities = info.capabilities;
                this._log(`Device: ${info.name || info.project} v${info.version}`, 'success');
                this._log(`Capabilities: [${this.capabilities.join(', ')}]`, 'info');
            } else {
                // Legacy device - no capabilities array
                this.capabilities = [];
                const name = info.name || info.project || 'Unknown';
                this._log(`Device: ${name} v${info.version} (no capabilities declared)`, 'warning');
                this._log('Assuming legacy mode - update firmware for full protocol support', 'warning');
            }

            return true;
        } catch (err) {
            this._log(`Discovery failed: ${err.message}`, 'error');
            return false;
        }
    }

    /**
     * Check if device has a specific capability
     * @param {string} cap - Capability name from CAPABILITIES
     * @returns {boolean}
     */
    hasCapability(cap) {
        return this.capabilities.includes(cap);
    }

    /**
     * Check capability with logging (for debugging)
     * @param {string} cap - Capability name
     * @returns {boolean}
     */
    checkCapability(cap) {
        const has = this.hasCapability(cap);
        if (!has) {
            const name = this.deviceInfo?.name || this.deviceInfo?.project || 'device';
            this._log(`Capability '${cap}' not available on ${name}`, 'warning');
        }
        return has;
    }

    /**
     * Get device name
     * @returns {string}
     */
    getDeviceName() {
        return this.deviceInfo?.name || this.deviceInfo?.project || 'Unknown';
    }

    /**
     * Check if connected (registry is set and port is connected)
     * @returns {boolean}
     */
    isConnected() {
        return this._registry !== null &&
               this._portName !== null &&
               this._registry.isConnected(this._portName);
    }

    /**
     * Reset API state (called when device disconnects)
     * Note: API doesn't manage ports - registry does
     */
    disconnect() {
        if (this._timeoutHandle) {
            clearTimeout(this._timeoutHandle);
            this._timeoutHandle = null;
        }

        if (this.transport) {
            this.transport.abort();
            this.transport = null;
        }

        this._registry = null;
        this._portName = null;
        this.deviceInfo = null;
        this.capabilities = [];
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmd = null;

        this._log('Disconnected');
    }

    //======================================================================
    // PUBLIC: Callbacks
    //======================================================================

    onSaveStatusChanged(callback) {
        this._onSaveStatusChanged = callback;
    }

    onExternalPatchChange(callback) {
        this._onExternalPatchChange = callback;
    }

    /**
     * Set handler for incoming commands (controller role)
     * When a synth sends get-control-surface or set-patch, this callback is invoked.
     * @param {Function} callback - (cmd, portName) => response object or null
     */
    onIncomingCommand(callback) {
        this._onIncomingCommand = callback;
    }

    //======================================================================
    // PUBLIC: IDENTITY Commands (all devices)
    //======================================================================

    async getDeviceInfo() {
        return this._sendCommand({ cmd: 'get-device-info' });
    }

    //======================================================================
    // PUBLIC: CONTROLLER Commands
    //======================================================================

    async getControlSurface() {
        this._requireCapability(CAPABILITIES.CONTROLLER, 'get-control-surface');
        return this._sendCommand({ cmd: 'get-control-surface' });
    }

    /**
     * Send patch data to controller (AP Protocol v3.0)
     * @param {string} name - Patch name
     * @param {Array} controls - Array of {input, label, cc}
     * @returns {Promise<Object>} - { status: "ok", op: "set-patch" }
     */
    async setPatch(name, controls) {
        this._requireCapability(CAPABILITIES.CONTROLLER, 'set-patch');
        return this._sendCommand({ cmd: 'set-patch', name, controls });
    }

    //======================================================================
    // PUBLIC: CONFIG Commands
    //======================================================================

    async getConfig() {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-get');
        return this._sendCommand({ cmd: 'config-get' });
    }

    //======================================================================
    // PUBLIC: PATCHES Commands
    //======================================================================

    async listPatches() {
        this._requireCapability(CAPABILITIES.PATCHES, 'list-patches');
        return this._sendCommand({ cmd: 'list-patches' });
    }

    async getPatch(index) {
        this._requireCapability(CAPABILITIES.PATCHES, 'get-patch');
        return this._sendCommand({ cmd: 'get-patch', index });
    }

    async selectPatch(index) {
        this._requireCapability(CAPABILITIES.PATCHES, 'select-patch');
        return this._sendCommand({ cmd: 'select-patch', index });
    }

    async createPatch(name) {
        this._requireCapability(CAPABILITIES.PATCHES, 'create-patch');
        return this._sendCommand({ cmd: 'create-patch', name });
    }

    async deletePatch(index) {
        this._requireCapability(CAPABILITIES.PATCHES, 'delete-patch');
        return this._sendCommand({ cmd: 'delete-patch', index });
    }

    async renamePatch(index, name) {
        this._requireCapability(CAPABILITIES.PATCHES, 'rename-patch');
        return this._sendCommand({ cmd: 'rename-patch', index, name });
    }

    async movePatch(from, to) {
        this._requireCapability(CAPABILITIES.PATCHES, 'move-patch');
        // Using fromIdx/toIdx to avoid macOS CoreMIDI bug with certain byte patterns
        return this._sendCommand({ cmd: 'move-patch', fromIdx: from, toIdx: to });
    }

    /**
     * Send controller-available notification to synth
     * Triggers synth to initiate exchange with the specified controller
     * @param {Object} controllerInfo - { device, port }
     * @returns {Promise<Object>}
     */
    async sendControllerAvailable(controllerInfo) {
        this._requireCapability(CAPABILITIES.SYNTH, 'controller-available');
        return this._sendCommand({ cmd: 'controller-available', ...controllerInfo });
    }

    //======================================================================
    // PUBLIC: CONFIG Commands
    //======================================================================

    /**
     * Initialize editor session (for devices with CONFIG capability)
     * Transitions device to EDITOR state.
     * Polls every 1s until device responds (device may ignore during HANDSHAKE).
     * @returns {Promise<Object>} - { status: "editor-active", config: {...} }
     */
    async init() {
        this._requireCapability(CAPABILITIES.CONFIG, 'init');

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
        this._requireCapability(CAPABILITIES.CONFIG, 'eject');
        return this._sendCommand({ cmd: 'eject' });
    }

    /**
     * Save config and exit editor session
     * @returns {Promise<Object>}
     */
    async saveAndExit() {
        this._requireCapability(CAPABILITIES.CONFIG, 'save-and-exit');
        return this._sendCommand({ cmd: 'save-and-exit' });
    }

    async getConfig() {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-get');
        return this._sendCommand({ cmd: 'config-get' });
    }

    async setConfig(config) {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-set');
        return this._sendCommand({ cmd: 'config-set', ...config });
    }

    async configReset() {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-reset');
        return this._sendCommand({ cmd: 'config-reset' });
    }

    //======================================================================
    // PUBLIC: SAVE Command (works with PATCHES or CONFIG)
    //======================================================================

    async save() {
        // Save works if device has either PATCHES or CONFIG capability
        if (!this.hasCapability(CAPABILITIES.PATCHES) && !this.hasCapability(CAPABILITIES.CONFIG)) {
            const name = this.getDeviceName();
            throw new Error(`Command 'save' requires PATCHES or CONFIG capability (${name} has neither)`);
        }
        return this._sendCommand({ cmd: 'save' });
    }

    //======================================================================
    // PUBLIC: PARAMS Commands (real-time patch editing)
    //======================================================================

    async updateParam(index, param, value) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-param');
        return this._sendCommand({ cmd: 'update-param', index, param, value });
    }

    async updateRange(index, param, min, max) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-range');
        return this._sendCommand({ cmd: 'update-range', index, param, min, max });
    }

    async toggleModule(index, module, enabled) {
        this._requireCapability(CAPABILITIES.PARAMS, 'toggle-module');
        return this._sendCommand({ cmd: 'toggle-module', index, module, enabled });
    }

    async toggleModulation(index, target, source, enabled) {
        this._requireCapability(CAPABILITIES.PARAMS, 'toggle-modulation');
        return this._sendCommand({ cmd: 'toggle-modulation', index, target, source, enabled });
    }

    async updateModulationAmount(index, param, value) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-modulation-amount');
        return this._sendCommand({ cmd: 'update-modulation-amount', index, param, value });
    }

    async toggleCC(index, param, enabled) {
        this._requireCapability(CAPABILITIES.PARAMS, 'toggle-cc');
        return this._sendCommand({ cmd: 'toggle-cc', index, param, enabled });
    }

    async moveModule(index, fromModule, toModule) {
        this._requireCapability(CAPABILITIES.PARAMS, 'move-module');
        return this._sendCommand({ cmd: 'move-module', index, fromModule, toModule });
    }

    //======================================================================
    // PUBLIC: FIRMWARE Commands
    //======================================================================

    async uploadFirmware(firmwareBin, progressCallback) {
        this._requireCapability(CAPABILITIES.FIRMWARE, 'upload-firmware');

        const SEGMENT_SIZE = 32768;  // 32KB
        const totalSize = firmwareBin.length;
        const totalSegments = Math.ceil(totalSize / SEGMENT_SIZE);

        this._log(`Firmware: ${totalSize} bytes, ${totalSegments} segments`);
        this._firmwareProgressCallback = progressCallback;

        // Step 1: Send command and wait for erase to complete
        const readyResponse = await this._waitForFirmwareReady(totalSize);

        this._log(`Device ready: segment_size=${readyResponse.segment_size || SEGMENT_SIZE}`);

        if (progressCallback) {
            progressCallback({ phase: 'transferring', percent: 0 });
        }

        // Step 2: Send each segment via separate transport transfer
        for (let i = 0; i < totalSegments; i++) {
            const offset = i * SEGMENT_SIZE;
            const segment = firmwareBin.slice(offset, offset + SEGMENT_SIZE);

            this._log(`Sending segment ${i + 1}/${totalSegments} (${segment.length} bytes)`);

            await this._sendFirmwareSegment(segment, i, totalSegments);
        }

        // Step 3: Wait for firmware-ready (final verification complete)
        return new Promise((resolve, reject) => {
            this._firmwareResolve = resolve;
            this._firmwareReject = reject;

            this._timeoutHandle = setTimeout(() => {
                this._firmwareProgressCallback = null;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                reject(new Error('Firmware verification timeout'));
            }, 30000);
        });
    }

    async restartDevice() {
        this._requireCapability(CAPABILITIES.FIRMWARE, 'restart-device');
        return this._sendCommand({ cmd: 'restart-device' });
    }

    //======================================================================
    // PUBLIC: MIDI Helpers (for synths)
    //======================================================================

    sendNoteOn(channel, note, velocity) {
        if (!this._registry) return;
        const msg = buildMidi1NoteOn(channel, note, velocity);
        this._registry.send(this._portName, msg);
    }

    sendNoteOff(channel, note, velocity = 0) {
        if (!this._registry) return;
        const msg = buildMidi1NoteOff(channel, note, velocity);
        this._registry.send(this._portName, msg);
    }

    sendChannelPressure(channel, pressure) {
        if (!this._registry) return;
        const msg = buildMidi1ChannelPressure(channel, pressure);
        this._registry.send(this._portName, msg);
    }

    sendPitchBend(channel, bend) {
        if (!this._registry) return;
        const msg = buildMidi1PitchBend(channel, bend);
        this._registry.send(this._portName, msg);
    }

    sendCC(channel, cc, value) {
        if (!this._registry) return;
        const value7 = Math.round(Math.max(0, Math.min(1, value)) * 127);
        const msg = new Uint8Array([
            0xB0 | (channel & 0x0F),
            cc & 0x7F,
            value7 & 0x7F
        ]);
        this._registry.send(this._portName, msg);
    }

    /**
     * Send raw MIDI data (for special messages like MPE config)
     * @param {Uint8Array|Array} data - Raw MIDI bytes
     */
    sendRaw(data) {
        if (!this._registry) return;
        this._registry.send(this._portName, data);
    }

    /**
     * Send a response (for controller role)
     * Used when APC acts as controller and needs to respond to synth commands.
     * @param {Object} response - JSON response object
     */
    sendResponse(response) {
        if (!this._registry || !this._portName) {
            this._log('Cannot send response: not connected', 'error');
            return;
        }
        const sysex = encodeJsonToSysEx(response);
        this._registry.send(this._portName, sysex);
        this._log(`Response: ${response.op || response.status || 'unknown'}`, 'tx');
    }

    //======================================================================
    // PUBLIC: Transport task (call periodically)
    //======================================================================

    task() {
        if (this.transport) {
            this.transport.task();
        }
    }

    //======================================================================
    // PUBLIC: Handle MIDI message (for external routing)
    //======================================================================

    handleMidiMessage(event) {
        this._handleMidiMessage(event);
    }

    //======================================================================
    // PRIVATE: Capability Guard
    //======================================================================

    _requireCapability(cap, cmd) {
        if (!this.hasCapability(cap)) {
            const name = this.getDeviceName();
            const err = `Command '${cmd}' requires capability '${cap}' (${name} doesn't have it)`;
            this._log(err, 'error');
            throw new Error(err);
        }
    }

    //======================================================================
    // PRIVATE: Command handling
    //======================================================================

    _sendCommand(cmdObj) {
        return new Promise((resolve, reject) => {
            if (!this._registry || !this._portName) {
                this._log(`${cmdObj.cmd} rejected: not connected`, 'error');
                reject(new Error('Not connected'));
                return;
            }

            if (this._pendingResolve) {
                this._log(`${cmdObj.cmd} rejected: busy with ${this._pendingCmd}`, 'error');
                reject(new Error(`Busy: waiting for ${this._pendingCmd}`));
                return;
            }

            this._pendingResolve = resolve;
            this._pendingReject = reject;
            this._pendingCmd = cmdObj.cmd;

            const sysex = encodeJsonToSysEx(cmdObj);
            this._registry.send(this._portName, sysex);
            this._log(cmdObj.cmd, 'tx');

            this._timeoutHandle = setTimeout(() => {
                const cmd = this._pendingCmd;
                this._clearPending();
                reject(new Error(`Timeout: ${cmd}`));
            }, API_TIMEOUT_MS);
        });
    }

    _resolve(data) {
        if (this._pendingResolve) {
            const resolve = this._pendingResolve;
            this._clearPending();
            resolve(data);
        }
    }

    _reject(error) {
        if (this._pendingReject) {
            const reject = this._pendingReject;
            this._clearPending();
            reject(error instanceof Error ? error : new Error(error));
        }
    }

    _clearPending() {
        if (this._timeoutHandle) {
            clearTimeout(this._timeoutHandle);
            this._timeoutHandle = null;
        }
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmd = null;
    }

    //======================================================================
    // PRIVATE: Firmware upload helpers
    //======================================================================

    _waitForFirmwareReady(totalSize) {
        return new Promise((resolve, reject) => {
            this._firmwareReadyResolve = resolve;
            this._firmwareReadyReject = reject;

            this._eraseTimeoutHandle = setTimeout(() => {
                this._firmwareReadyResolve = null;
                this._firmwareReadyReject = null;
                reject(new Error('Firmware erase timeout'));
            }, 120000);

            const cmdObj = { cmd: 'upload-firmware', size: totalSize };
            const sysex = encodeJsonToSysEx(cmdObj);
            this._registry.send(this._portName, sysex);
            this._log(`upload-firmware (size=${totalSize})`, 'tx');
        });
    }

    _sendFirmwareSegment(segment, index, totalSegments) {
        return new Promise((resolve, reject) => {
            this._segmentResolve = resolve;
            this._segmentReject = reject;
            this._currentSegmentIndex = index;

            this._segmentTimeoutHandle = setTimeout(() => {
                this._segmentResolve = null;
                this._segmentReject = null;
                reject(new Error(`Segment ${index} timeout`));
            }, 60000);

            if (!this.transport.send(segment)) {
                clearTimeout(this._segmentTimeoutHandle);
                this._segmentResolve = null;
                this._segmentReject = null;
                reject(new Error('Transport busy'));
            }
        });
    }

    //======================================================================
    // PRIVATE: MIDI message handling
    //======================================================================

    _handleMidiMessage(event) {
        const data = Array.from(event.data);

        if (data[0] === 0xF0) {
            this._sysexBuffer = data;

            if (data[data.length - 1] === 0xF7) {
                this._processSysEx(this._sysexBuffer);
                this._sysexBuffer = [];
            }
        } else if (this._sysexBuffer.length > 0) {
            this._sysexBuffer.push(...data);

            if (data[data.length - 1] === 0xF7) {
                this._processSysEx(this._sysexBuffer);
                this._sysexBuffer = [];
            }
        }
    }

    _processSysEx(data) {
        try {
            if (!isCandideSysEx(data)) {
                return;
            }

            const payload = data.slice(3, -1);
            const decoded = mcoded7Decode(payload);

            if (decoded.length === 0) {
                this._log('Empty decoded payload', 'error');
                return;
            }

            // Transport protocol message
            if (decoded[0] >= 0x01 && decoded[0] <= 0x07) {
                if (this.transport) {
                    this.transport.receive(decoded);
                }
                return;
            }

            // JSON response
            const json = decodeSysExToJson(data);
            if (!json) {
                this._log('Failed to decode JSON', 'error');
                return;
            }

            this._log(`RX: ${json.cmd || json.status || json.op || 'response'}`, 'rx');
            this._routeResponse(json);

        } catch (error) {
            this._log(`Exception processing SysEx: ${error.message}`, 'error');
        }
    }

    _handleTransportComplete(data, success) {
        if (!success) {
            this._log('Transport transfer failed', 'error');
            if (this._segmentReject) {
                clearTimeout(this._segmentTimeoutHandle);
                this._segmentTimeoutHandle = null;
                const reject = this._segmentReject;
                this._segmentResolve = null;
                this._segmentReject = null;
                reject(new Error('Segment transport failed'));
                return;
            }
            this._reject(new Error('Transport transfer failed'));
            return;
        }

        if (!data || data.length === 0) {
            return;
        }

        try {
            const jsonStr = new TextDecoder().decode(data);
            const json = JSON.parse(jsonStr);
            this._log(`RX: ${json.cmd || json.status || 'response'} (chunked)`, 'rx');
            this._routeResponse(json);
        } catch (error) {
            this._log(`Failed to decode transport payload: ${error.message}`, 'error');
            this._reject(error);
        }
    }

    _classifyResponse(json) {
        if (json.error) return 'error';
        if (json.status === 'editor-active') return 'editor-active';
        if (json.status === 'editor-inactive') return 'editor-inactive';
        if (json.status === 'saved') return 'save-status';
        if (json.status === 'saving') return 'save-status';
        if (json.status === 'unsaved') return 'save-status';
        if (json.status === 'erasing') return 'erasing';
        if (json.status === 'erase-progress') return 'erase-progress';
        if (json.status === 'ready-for-firmware') return 'ready-for-firmware';
        if (json.status === 'segment-done') return 'segment-done';
        if (json.status === 'flashing') return 'flashing-progress';
        if (json.status === 'firmware-ready') return 'firmware-ready';
        if (json.status === 'firmware-validated') return 'firmware-validated';
        if (json.status === 'restarting') return 'restarting';
        if (json.status === 'device-info' || json.status === 'ok' && json.op === 'device-info') return 'device-info';
        if (json.status === 'ok' && json.op === 'config') return 'config';
        if (json.status === 'ok' && json.op === 'control-surface') return 'control-surface';
        if (json.patches && Array.isArray(json.patches)) return 'list-patches';
        if (json.index !== undefined && json.name && !json.status) return 'get-patch';
        if (json.status === 'ok') return 'mutation-ack';
        return 'unknown';
    }

    _responseMatchesCommand(responseType, pendingCmd, json) {
        if (responseType === 'error') return true;
        if (responseType === 'editor-active') return pendingCmd === 'init';
        if (responseType === 'editor-inactive') return pendingCmd === 'eject';
        if (responseType === 'save-status') return false;
        if (responseType === 'list-patches') return pendingCmd === 'list-patches';
        if (responseType === 'get-patch') return pendingCmd === 'get-patch';
        if (responseType === 'ready-for-firmware') return pendingCmd === 'upload-firmware';
        if (responseType === 'restarting') return pendingCmd === 'restart-device';
        if (responseType === 'device-info') return pendingCmd === 'get-device-info';
        if (responseType === 'config') return pendingCmd === 'config-get' || pendingCmd === 'config-set';
        if (responseType === 'control-surface') return pendingCmd === 'get-control-surface';
        if (responseType === 'flashing-progress') return false;
        if (responseType === 'firmware-ready') return false;
        if (responseType === 'firmware-validated') return false;

        if (responseType === 'mutation-ack') {
            return json.op === pendingCmd;
        }

        return false;
    }

    _routeResponse(json) {
        // Check for incoming commands (controller role)
        // Incoming commands have a 'cmd' field and come from synths
        if (json.cmd && this._onIncomingCommand) {
            const cmd = json.cmd;
            if (cmd === 'get-control-surface' || cmd === 'set-patch') {
                this._log(`Incoming command: ${cmd}`, 'rx');
                const response = this._onIncomingCommand(json, this._portName);
                if (response) {
                    this.sendResponse(response);
                }
                return;
            }
        }

        const responseType = this._classifyResponse(json);

        // Save status updates
        if (responseType === 'save-status') {
            this._log(`Save status: ${json.status}`);
            if (this._onSaveStatusChanged) {
                this._onSaveStatusChanged(json.status);
            }
            return;
        }

        // Firmware update responses
        if (responseType === 'erasing') {
            this._log(`Erase started: ${json.sectors} sectors`);
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({
                    phase: 'erasing',
                    percent: 0,
                    sectors: json.sectors
                });
            }
            return;
        }

        if (responseType === 'erase-progress') {
            this._log(`Erase: ${json.sector}/${json.total} (${json.percent}%)`);
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({
                    phase: 'erasing',
                    percent: json.percent,
                    sector: json.sector,
                    total: json.total
                });
            }
            return;
        }

        if (responseType === 'ready-for-firmware') {
            this._log(`Erase complete, device ready`);
            if (this._firmwareReadyResolve) {
                clearTimeout(this._eraseTimeoutHandle);
                this._eraseTimeoutHandle = null;
                const resolve = this._firmwareReadyResolve;
                this._firmwareReadyResolve = null;
                this._firmwareReadyReject = null;
                resolve(json);
            }
            return;
        }

        if (responseType === 'segment-done') {
            this._log(`Segment ${json.segment} done, progress: ${json.progress}%`);
            if (this._segmentResolve) {
                clearTimeout(this._segmentTimeoutHandle);
                this._segmentTimeoutHandle = null;
                const resolve = this._segmentResolve;
                this._segmentResolve = null;
                this._segmentReject = null;
                resolve(json);
            }
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'transferring', percent: json.progress });
            }
            return;
        }

        if (responseType === 'flashing-progress') {
            this._log(`Flashing: ${json.progress}%`);
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'flashing', percent: json.progress });
            }
            return;
        }

        if (responseType === 'firmware-ready') {
            this._log('Firmware written successfully');
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'complete', percent: 100 });
            }
            if (this._firmwareResolve) {
                clearTimeout(this._timeoutHandle);
                this._timeoutHandle = null;
                const resolve = this._firmwareResolve;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                this._firmwareProgressCallback = null;
                resolve(json);
            }
            return;
        }

        if (responseType === 'firmware-validated') {
            this._log('Firmware validated, awaiting restart');
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'validated', percent: 100 });
            }
            if (this._firmwareResolve) {
                clearTimeout(this._timeoutHandle);
                this._timeoutHandle = null;
                const resolve = this._firmwareResolve;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                this._firmwareProgressCallback = null;
                resolve(json);
            }
            return;
        }

        // Firmware error
        if (responseType === 'error' && (this._firmwareReadyReject || this._firmwareReject)) {
            this._log(`Firmware error: ${json.error}`, 'error');
            if (this._eraseTimeoutHandle) {
                clearTimeout(this._eraseTimeoutHandle);
                this._eraseTimeoutHandle = null;
            }
            if (this._timeoutHandle) {
                clearTimeout(this._timeoutHandle);
                this._timeoutHandle = null;
            }
            const reject = this._firmwareReadyReject || this._firmwareReject;
            this._firmwareReadyResolve = null;
            this._firmwareReadyReject = null;
            this._firmwareResolve = null;
            this._firmwareReject = null;
            this._firmwareProgressCallback = null;
            reject(new Error(json.error));
            return;
        }

        // External patch change
        if (json.op === 'select-patch' && !this._pendingCmd) {
            this._log(`External patch change: index=${json.current_index}`);
            if (this._onExternalPatchChange) {
                this._onExternalPatchChange(json);
            }
            return;
        }

        const pending = this._pendingCmd;

        if (!pending) {
            this._log(`Response with no pending command: ${JSON.stringify(json)}`, 'warn');
            return;
        }

        if (responseType === 'error') {
            this._log(`Error: ${json.error}`, 'error');
            this._reject(new Error(json.error));
            return;
        }

        if (responseType === 'saving-progress') {
            this._log(`Saving: ${json.progress}%`);
            return;
        }

        if (!this._responseMatchesCommand(responseType, pending, json)) {
            this._log(`Mismatched response: got ${responseType}/${json.op || ''} but pending=${pending}`, 'warn');
            return;
        }

        this._resolve(json);
    }

    _log(msg, type = 'info') {
        if (this._logFn) {
            this._logFn(msg, type);
        }
    }
}

// Keep CandideAPI as an alias for backwards compatibility during transition
window.CandideAPI = UnifiedDeviceAPI;
window.UnifiedDeviceAPI = UnifiedDeviceAPI;
