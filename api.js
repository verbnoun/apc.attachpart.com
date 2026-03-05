/**
 * Unified Device API - Capability-Based Device Communication
 *
 * Single API class for all AttachPart devices (Candide, Bartleby, etc.)
 * Device capabilities are discovered via get-device-info and determine
 * which commands are available.
 *
 * Design: Thin client - device is authority, no local state storage.
 * Principle: "Host leads the dance" - we initiate all discovery.
 *
 * Command model: fire-and-forget mutations + per-type response queues
 * for queries. No single-command bottleneck — multiple concurrent queries
 * resolve independently via FIFO queues keyed by response type.
 */

//======================================================================
// CONSTANTS
//======================================================================

const API_TIMEOUT_MS = 15000;  // 15 seconds for query timeout

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

        // Response queues for query() — per-type FIFO
        this._responseQueues = {};

        // SysEx assembly buffer
        this._sysexBuffer = [];

        // Firmware uploader (created in setRegistry)
        this._firmwareUploader = null;

        // Log callback
        this._logFn = null;

        // Callbacks — existing
        this._onSaveStatusChanged = null;
        this._onExternalPatchChange = null;
        this._onDmNotification = null;
        this._onDmFeedback = null;

        // Callbacks — reactive data (fire when no queued waiter)
        this._onPatchData = null;
        this._onPatchList = null;
        this._onConfig = null;
        this._onDeviceInfo = null;
        this._onControlSurface = null;
        this._onEditorStatus = null;
        this._onMutationAck = null;
        this._onError = null;
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

        // Initialize DM chunked transport (0x20 channel)
        this.dmTransport = new ChunkedTransport(
            (sysexData) => { this._registry.send(this._portName, sysexData); return true; },
            (data, success) => this._handleDmTransportComplete(data, success),
            () => Date.now(),
            (msg, type) => this._log(`DM transport: ${msg}`, type),
            { sysexPrefix: [0x7D, 0x00, 0x20] }
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
            const info = await this.query({ cmd: 'get-device-info' }, 'device-info');

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
        if (this._firmwareUploader) {
            this._firmwareUploader.abort();
            this._firmwareUploader = null;
        }

        if (this.transport) {
            this.transport.abort();
            this.transport = null;
        }

        if (this.dmTransport) {
            this.dmTransport.abort();
            this.dmTransport = null;
        }

        // Reject all pending query waiters
        for (const [type, queue] of Object.entries(this._responseQueues)) {
            for (const entry of queue) {
                clearTimeout(entry.timer);
                entry.reject(new Error('Disconnected'));
            }
        }
        this._responseQueues = {};

        this._registry = null;
        this._portName = null;
        this.deviceInfo = null;
        this.capabilities = [];

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

    onDmNotification(callback) {
        this._onDmNotification = callback;
    }

    onDmFeedback(callback) {
        this._onDmFeedback = callback;
    }

    onPatchData(callback) {
        this._onPatchData = callback;
    }

    onPatchList(callback) {
        this._onPatchList = callback;
    }

    onConfig(callback) {
        this._onConfig = callback;
    }

    onDeviceInfo(callback) {
        this._onDeviceInfo = callback;
    }

    onControlSurface(callback) {
        this._onControlSurface = callback;
    }

    onEditorStatus(callback) {
        this._onEditorStatus = callback;
    }

    onMutationAck(callback) {
        this._onMutationAck = callback;
    }

    onError(callback) {
        this._onError = callback;
    }

    //======================================================================
    // PUBLIC: IDENTITY Commands (all devices)
    //======================================================================

    getDeviceInfo() {
        return this.query({ cmd: 'get-device-info' }, 'device-info');
    }

    //======================================================================
    // PUBLIC: CONTROLLER Commands
    //======================================================================

    getControlSurface() {
        this._requireCapability(CAPABILITIES.CONTROLLER, 'get-control-surface');
        return this.query({ cmd: 'get-control-surface' }, 'control-surface');
    }

    /**
     * Send patch data to controller (AP Protocol v3.0)
     * @param {string} name - Patch name
     * @param {Array} controls - Array of {input, label, cc}
     */
    setPatch(name, controls) {
        this._requireCapability(CAPABILITIES.CONTROLLER, 'set-patch');
        this._send({ cmd: 'set-patch', name, controls });
    }

    //======================================================================
    // PUBLIC: CONFIG Commands
    //======================================================================

    getConfig() {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-get');
        return this.query({ cmd: 'config-get' }, 'config');
    }

    //======================================================================
    // PUBLIC: PATCHES Commands
    //======================================================================

    listPatches() {
        this._requireCapability(CAPABILITIES.PATCHES, 'list-patches');
        return this.query({ cmd: 'list-patches' }, 'list-patches');
    }

    getPatch(index) {
        this._requireCapability(CAPABILITIES.PATCHES, 'get-patch');
        return this.query({ cmd: 'get-patch', index }, 'get-patch');
    }

    selectPatch(index) {
        this._requireCapability(CAPABILITIES.PATCHES, 'select-patch');
        this._send({ cmd: 'select-patch', index });
    }

    createPatch(name) {
        this._requireCapability(CAPABILITIES.PATCHES, 'create-patch');
        this._send({ cmd: 'create-patch', name });
    }

    deletePatch(index) {
        this._requireCapability(CAPABILITIES.PATCHES, 'delete-patch');
        this._send({ cmd: 'delete-patch', index });
    }

    renamePatch(index, name) {
        this._requireCapability(CAPABILITIES.PATCHES, 'rename-patch');
        this._send({ cmd: 'rename-patch', index, name });
    }

    movePatch(from, to) {
        this._requireCapability(CAPABILITIES.PATCHES, 'move-patch');
        // Using fromIdx/toIdx to avoid macOS CoreMIDI bug with certain byte patterns
        this._send({ cmd: 'move-patch', fromIdx: from, toIdx: to });
    }

    /**
     * Send pair command to device
     * Synth: stores controller MUID, triggers exchange
     * Controller: stores synth MUID (informational)
     * @param {number} targetMuid - MUID of the device to pair with
     * @returns {Promise<Object>}
     */
    sendPair(targetMuid) {
        return this.query({ cmd: 'pair', muid: targetMuid }, 'mutation-ack');
    }

    /**
     * Send unpair command to device
     * Clears pairing state on the device
     */
    sendUnpair() {
        this._send({ cmd: 'unpair' });
    }

    /**
     * @deprecated Use sendPair() instead. Kept for backward compat.
     */
    sendControllerAvailable(controllerInfo) {
        this._log('sendControllerAvailable is deprecated — use sendPair()', 'warning');
        this._send({ cmd: 'controller-available', ...controllerInfo });
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

            try {
                const result = await this.query({ cmd: 'init' }, 'editor-active', POLL_INTERVAL_MS);
                return result;
            } catch (e) {
                if (e.message.startsWith('Timeout:')) {
                    this._log('Init: polling...', 'info');
                    continue;
                }
                throw e;
            }
        }
    }

    /**
     * Exit editor session without saving
     */
    eject() {
        this._requireCapability(CAPABILITIES.CONFIG, 'eject');
        this._send({ cmd: 'eject' });
    }

    /**
     * Save config and exit editor session
     */
    saveAndExit() {
        this._requireCapability(CAPABILITIES.CONFIG, 'save-and-exit');
        this._send({ cmd: 'save-and-exit' });
    }

    setConfig(config) {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-set');
        return this.query({ cmd: 'config-set', ...config }, 'config');
    }

    configReset() {
        this._requireCapability(CAPABILITIES.CONFIG, 'config-reset');
        this._send({ cmd: 'config-reset' });
    }

    //======================================================================
    // PUBLIC: SAVE Command (works with PATCHES or CONFIG)
    //======================================================================

    save() {
        // Save works if device has either PATCHES or CONFIG capability
        if (!this.hasCapability(CAPABILITIES.PATCHES) && !this.hasCapability(CAPABILITIES.CONFIG)) {
            const name = this.getDeviceName();
            throw new Error(`Command 'save' requires PATCHES or CONFIG capability (${name} has neither)`);
        }
        return this.query({ cmd: 'save' }, 'save-status');
    }

    //======================================================================
    // PUBLIC: PARAMS Commands (real-time patch editing)
    //======================================================================

    updateParam(index, param, options) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-param');
        // Support both old signature (index, param, value) and new (index, param, {value, priority})
        const opts = typeof options === 'object' ? options : { value: options };
        const cmd = { cmd: 'update-param', index, param };
        if (opts.value !== undefined) cmd.value = opts.value;
        if (opts.priority !== undefined) cmd.priority = opts.priority;
        if (opts.storeOnly) cmd.store_only = true;
        this._send(cmd);
    }

    updateRange(index, param, min, max) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-range');
        this._send({ cmd: 'update-range', index, param, min, max });
    }

    toggleModule(index, module, enabled) {
        this._requireCapability(CAPABILITIES.PARAMS, 'toggle-module');
        this._send({ cmd: 'toggle-module', index, module, enabled });
    }

    toggleModulation(index, target, source, enabled) {
        this._requireCapability(CAPABILITIES.PARAMS, 'toggle-modulation');
        this._send({ cmd: 'toggle-modulation', index, target, source, enabled });
    }

    updateModulationAmount(index, param, value) {
        this._requireCapability(CAPABILITIES.PARAMS, 'update-modulation-amount');
        this._send({ cmd: 'update-modulation-amount', index, param, value });
    }

    toggleCC(index, param, enabled) {
        this._requireCapability(CAPABILITIES.PARAMS, 'toggle-cc');
        this._send({ cmd: 'toggle-cc', index, param, enabled });
    }

    moveModule(index, fromModule, toModule) {
        this._requireCapability(CAPABILITIES.PARAMS, 'move-module');
        this._send({ cmd: 'move-module', index, fromModule, toModule });
    }

    //======================================================================
    // PUBLIC: FIRMWARE Commands
    //======================================================================

    async uploadFirmware(firmwareBin, progressCallback) {
        this._requireCapability(CAPABILITIES.FIRMWARE, 'upload-firmware');
        return this._firmwareUploader.upload(firmwareBin, progressCallback);
    }

    restartDevice() {
        this._requireCapability(CAPABILITIES.FIRMWARE, 'restart-device');
        this._send({ cmd: 'restart-device' });
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
        if (this.dmTransport) {
            this.dmTransport.task();
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
    // PRIVATE: Command sending
    //======================================================================

    /**
     * Fire-and-forget send. Encodes command to SysEx and sends via registry.
     * No promise, no pending state, no timeout.
     */
    _send(cmdObj) {
        if (!this._registry || !this._portName) {
            this._log(`${cmdObj.cmd} rejected: not connected`, 'error');
            return;
        }
        const sysex = encodeDmJsonToSysEx(cmdObj);
        this._registry.send(this._portName, sysex);
        this._log(cmdObj.cmd, 'tx');
    }

    /**
     * Query with response. Sends command and returns a Promise that resolves
     * when a response of the specified type arrives. Multiple concurrent queries
     * of the same type are allowed — each registers in a per-type FIFO queue.
     *
     * @param {Object} cmdObj - Command to send (e.g., { cmd: 'get-patch', index: 0 })
     * @param {string} responseType - Expected response type from _classifyResponse()
     * @param {number} timeoutMs - Timeout in milliseconds (default: API_TIMEOUT_MS)
     * @returns {Promise<Object>} - Resolved with the response JSON
     */
    query(cmdObj, responseType, timeoutMs = API_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!this._registry || !this._portName) {
                this._log(`${cmdObj.cmd} rejected: not connected`, 'error');
                reject(new Error('Not connected'));
                return;
            }

            if (!this._responseQueues[responseType]) {
                this._responseQueues[responseType] = [];
            }

            const entry = { resolve, reject, timer: null };

            entry.timer = setTimeout(() => {
                const q = this._responseQueues[responseType];
                const idx = q?.indexOf(entry);
                if (idx >= 0) q.splice(idx, 1);
                reject(new Error(`Timeout: ${cmdObj.cmd}`));
            }, timeoutMs);

            this._responseQueues[responseType].push(entry);

            const sysex = encodeDmJsonToSysEx(cmdObj);
            this._registry.send(this._portName, sysex);
            this._log(cmdObj.cmd, 'tx');
        });
    }

    //======================================================================
    // PRIVATE: Response queue helpers
    //======================================================================

    /**
     * Resolve the oldest queued waiter for a response type.
     * @returns {boolean} true if a waiter was resolved
     */
    _resolveQueue(type, json) {
        const q = this._responseQueues[type];
        if (q?.length > 0) {
            const entry = q.shift();
            clearTimeout(entry.timer);
            entry.resolve(json);
            return true;
        }
        return false;
    }

    /**
     * Reject the oldest queued waiter across all types.
     * Used for error responses where the target type is ambiguous.
     * @returns {boolean} true if a waiter was rejected
     */
    _rejectFirstQueue(error) {
        for (const [type, q] of Object.entries(this._responseQueues)) {
            if (q.length > 0) {
                const entry = q.shift();
                clearTimeout(entry.timer);
                entry.reject(error);
                return true;
            }
        }
        return false;
    }

    /**
     * Check if any waiter is queued for a response type.
     */
    _hasQueuedWaiter(type) {
        return (this._responseQueues[type]?.length ?? 0) > 0;
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
            this._rejectFirstQueue(new Error('Transport transfer failed'));
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
            this._rejectFirstQueue(error);
        }
    }

    _handleDmTransportComplete(data, success) {
        if (!success || !data) return;
        try {
            const json = JSON.parse(new TextDecoder().decode(data));
            if (json.notification) {
                this._log(`DM notification (chunked): ${json.notification}`);
                if (this._onDmNotification) {
                    this._onDmNotification(json);
                }
            } else {
                this._routeResponse(json);
            }
        } catch (e) {
            this._log(`DM transport: malformed JSON: ${e.message}`, 'error');
        }
    }

    //======================================================================
    // PRIVATE: Response classification and dispatch
    //======================================================================

    _classifyResponse(json) {
        if (json.error || json.status === 'error') return 'error';
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

    _routeResponse(json) {
        const responseType = this._classifyResponse(json);

        // Save status updates — always fire callback, resolve queue only on 'saved'
        if (responseType === 'save-status') {
            const statusText = json.status === 'saved' ? 'Complete' : json.status;
            this._log(`Save status: ${statusText}`);
            if (this._onSaveStatusChanged) {
                this._onSaveStatusChanged(json.status);
            }
            if (json.status === 'saved') {
                this._resolveQueue('save-status', json);
            }
            return;
        }

        // Firmware responses — delegate to uploader
        if (this._firmwareUploader?.active) {
            if (this._firmwareUploader.handleResponse(responseType, json)) {
                return;
            }
        }

        // External patch change (unsolicited select-patch with no queued waiter)
        if (json.op === 'select-patch' && !this._hasQueuedWaiter('mutation-ack')) {
            this._log(`External patch change: index=${json.current_index}`);
            if (this._onExternalPatchChange) {
                this._onExternalPatchChange(json);
            }
            return;
        }

        // Error responses — reject oldest queued waiter, or fire callback
        if (responseType === 'error') {
            const msg = json.error || json.message || 'Unknown error';
            this._log(`Error: ${msg}`, 'error');
            if (!this._rejectFirstQueue(new Error(msg))) {
                this._onError?.(json);
            }
            return;
        }

        // Try to resolve a queued waiter first
        if (this._resolveQueue(responseType, json)) {
            return;
        }

        // No queued waiter — fire reactive data callback
        switch (responseType) {
            case 'get-patch':       this._onPatchData?.(json); break;
            case 'list-patches':    this._onPatchList?.(json); break;
            case 'config':          this._onConfig?.(json); break;
            case 'device-info':     this._onDeviceInfo?.(json); break;
            case 'control-surface': this._onControlSurface?.(json); break;
            case 'editor-active':
            case 'editor-inactive': this._onEditorStatus?.(json); break;
            case 'mutation-ack':    this._onMutationAck?.(json); break;
        }
    }

    //======================================================================
    // PRIVATE: DM Protocol handling
    //======================================================================

    _handleDmChannel(data) {
        // Strip F0/F7 framing: data is [F0][7D][00][20][...][F7]
        const inner = data.slice(1, -1);  // [7D][00][20][...]

        const format = classifyDmFormat(inner);

        if (format === 'direct-json') {
            // Extract JSON bytes after [7D][00][20]
            const jsonBytes = inner.slice(3);
            let json;
            try {
                const jsonStr = new TextDecoder().decode(new Uint8Array(jsonBytes));
                json = JSON.parse(jsonStr);
            } catch (e) {
                this._log(`DM: malformed JSON in 0x20 message: ${e.message}`, 'error');
                return;
            }

            // Notifications have "notification" key — fire callback
            if (json.notification) {
                this._log(`DM notification: ${json.notification}`);
                if (this._onDmNotification) {
                    this._onDmNotification(json);
                }
                return;
            }

            // Command response — route through dispatcher
            this._routeResponse(json);

        } else if (format === 'transport') {
            // Chunked transport on 0x20: strip [7D][00][20], mcoded7-decode, feed to dmTransport
            const transportPayload = inner.slice(3);
            const decoded = mcoded7Decode(new Uint8Array(transportPayload));
            if (this.dmTransport) {
                this.dmTransport.receive(decoded);
            }
        } else {
            this._log('DM: invalid 0x20 format', 'warn');
        }
    }

    _handleDmFeedback(data) {
        // Strip F0/F7 framing: data is [F0][7D][00][21][...][F7]
        const inner = data.slice(1, -1);  // [7D][00][21][...]

        const feedback = parseDmFeedback(inner);
        if (!feedback) {
            this._log('DM: invalid 0x21 feedback message', 'warn');
            return;
        }

        this._log(`DM feedback: uid=${feedback.uid} val=${feedback.value} "${feedback.display}"`);
        if (this._onDmFeedback) {
            this._onDmFeedback(feedback);
        }
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
