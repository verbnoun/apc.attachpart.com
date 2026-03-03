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

        // Firmware uploader (created in setRegistry)
        this._firmwareUploader = null;

        // Log callback
        this._logFn = null;

        // Callbacks
        this._onSaveStatusChanged = null;
        this._onExternalPatchChange = null;
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

        // Initialize firmware uploader (uses transport for segment transfer)
        this._firmwareUploader = new FirmwareUploader(
            (sysexData) => { this._registry.send(this._portName, sysexData); },
            this.transport,
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

        if (this._firmwareUploader) {
            this._firmwareUploader.abort();
            this._firmwareUploader = null;
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

    async updateParam(index, param, options) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-param');
        // Support both old signature (index, param, value) and new (index, param, {value, priority})
        const opts = typeof options === 'object' ? options : { value: options };
        const cmd = { cmd: 'update-param', index, param };
        if (opts.value !== undefined) cmd.value = opts.value;
        if (opts.priority !== undefined) cmd.priority = opts.priority;
        if (opts.storeOnly) cmd.store_only = true;
        return this._sendCommand(cmd);
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
        return this._firmwareUploader.upload(firmwareBin, progressCallback);
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

            // Value feedback (0x10, 0x11) is binary, not mcoded7 — handled by DeviceRegistry
            if (data[3] === 0x10 || data[3] === 0x11) {
                return;
            }

            // DM Protocol (0x20, 0x21) — binary, before mcoded7 decode
            if (data[3] === 0x20) {
                this._handleDmChannel(data);
                return;
            }

            if (data[3] === 0x21) {
                this._handleDmFeedback(data);
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
            if (this._firmwareUploader?.active && this._firmwareUploader.handleTransportFailure()) {
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
        if (responseType === 'restarting') return pendingCmd === 'restart-device';
        if (responseType === 'device-info') return pendingCmd === 'get-device-info';
        if (responseType === 'config') return pendingCmd === 'config-get' || pendingCmd === 'config-set';
        if (responseType === 'control-surface') return pendingCmd === 'get-control-surface';
        if (responseType === 'mutation-ack') {
            return json.op === pendingCmd;
        }

        return false;
    }

    _routeResponse(json) {
        const responseType = this._classifyResponse(json);

        // Save status updates
        if (responseType === 'save-status') {
            const statusText = json.status === 'saved' ? 'Complete' : json.status;
            this._log(`Save status: ${statusText}`);
            if (this._onSaveStatusChanged) {
                this._onSaveStatusChanged(json.status);
            }
            // When we're waiting for a save response, 'saved' IS the response
            if (this._pendingCmd === 'save' && json.status === 'saved') {
                this._resolve(json);
            }
            return;
        }

        // Firmware responses — delegate to uploader
        if (this._firmwareUploader?.active) {
            if (this._firmwareUploader.handleResponse(responseType, json)) {
                return;
            }
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

    //======================================================================
    // PRIVATE: DM Protocol Stubs (Phase 1 — log and discard)
    //======================================================================

    _handleDmChannel(data) {
        this._log('DM: ignoring 0x20 channel message', 'info');
    }

    _handleDmFeedback(data) {
        this._log('DM: ignoring 0x21 feedback message', 'info');
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
