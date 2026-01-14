/**
 * Candide API - Thin Client Command Interface
 *
 * Single point of contact for all device communication.
 * Uses existing transport.js, chunked-transport.js, and midi-connection.js.
 *
 * Design: Thin client - device is authority, no local state storage.
 */

//======================================================================
// CONSTANTS
//======================================================================

const API_TIMEOUT_MS = 15000;  // 15 seconds for command timeout

//======================================================================
// CANDIDE API CLASS
//======================================================================

class CandideAPI {
    constructor() {
        // Connection state
        this.midiAccess = null;
        this.midiInput = null;
        this.midiOutput = null;
        this.transport = null;

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

        // Connection monitoring callbacks
        this._onDeviceFound = null;
        this._onDeviceDisconnected = null;

        // Save status callback (for auto-save UI updates)
        this._onSaveStatusChanged = null;

        // External patch change callback (encoder/console while in EDITOR mode)
        this._onExternalPatchChange = null;
    }

    //======================================================================
    // PUBLIC: Connection
    //======================================================================

    /**
     * Start monitoring for device connection (call on page load)
     * Will auto-detect device and call onDeviceFound when available.
     *
     * @param {Function} logFn - Log callback(message, type)
     * @param {Object} callbacks - { onDeviceFound, onDeviceDisconnected }
     * @returns {Promise<Object|null>} - Device info if already connected, null if waiting
     */
    async startMonitoring(logFn, callbacks) {
        this._logFn = logFn || ((msg, type) => console.log(`[${type}] ${msg}`));
        this._onDeviceFound = callbacks.onDeviceFound;
        this._onDeviceDisconnected = callbacks.onDeviceDisconnected;

        this._log('Requesting Web MIDI access...');

        // Get MIDI access and check for device
        const result = await connectToCandide();
        this.midiAccess = result.midiAccess;

        // Start monitoring for connect/disconnect events
        startDeviceMonitoring(this.midiAccess, {
            onDeviceFound: (deviceResult) => {
                // Only trigger if not already connected
                if (!this.isConnected()) {
                    this._log(`Device detected: ${deviceResult.input.name}`);
                    callbacks.onDeviceFound?.(deviceResult);
                }
            },
            onDeviceDisconnected: ({ portName }) => {
                this._log(`Device disconnected: ${portName}`);
                this._handleDeviceDisconnected();
                callbacks.onDeviceDisconnected?.({ portName });
            }
        }, this.midiInput?.name || null);

        // If device already present, return it for immediate connection
        if (result.input && result.output) {
            this._log(`Device already present: ${result.input.name}`);
            return result;
        }

        this._log('Waiting for device...');
        return null;
    }

    /**
     * Connect to a detected device
     * Called after startMonitoring detects a device.
     *
     * @param {Object} deviceResult - { input, output } from device detection
     */
    connectToDevice(deviceResult) {
        const { input, output } = deviceResult;

        this.midiInput = input;
        this.midiOutput = output;

        // Set up MIDI input handler
        this.midiInput.onmidimessage = (event) => this._handleMidiMessage(event);

        // Initialize chunked transport
        this.transport = new ChunkedTransport(
            (sysexData) => { this.midiOutput.send(sysexData); return true; },
            (data, success) => this._handleTransportComplete(data, success),
            () => Date.now(),
            (msg, type) => this._log(msg, type)
        );

        // Update monitoring to track this specific port for disconnect and reconnect
        if (this.midiAccess) {
            startDeviceMonitoring(this.midiAccess, {
                onDeviceFound: (deviceResult) => {
                    // Only trigger if not already connected (handles reconnect after disconnect)
                    if (!this.isConnected()) {
                        this._log(`Device detected: ${deviceResult.input.name}`);
                        this._onDeviceFound?.(deviceResult);
                    }
                },
                onDeviceDisconnected: ({ portName }) => {
                    this._log(`Device disconnected: ${portName}`);
                    this._handleDeviceDisconnected();
                    this._onDeviceDisconnected?.({ portName });
                }
            }, input.name);
        }

        this._log(`Connected to ${input.name}`);
    }

    /**
     * Handle device disconnection (internal cleanup)
     * @private
     */
    _handleDeviceDisconnected() {
        // Cancel any pending command
        if (this._pendingReject) {
            const reject = this._pendingReject;
            this._clearPending();
            reject(new Error('Device disconnected'));
        }

        // Clean up connection state without closing ports (they're already gone)
        if (this.transport) {
            this.transport.abort();
            this.transport = null;
        }

        if (this.midiInput) {
            this.midiInput.onmidimessage = null;
            this.midiInput = null;
        }

        this.midiOutput = null;
    }

    /**
     * Connect to Candide device (legacy method for backwards compatibility)
     * @param {Function} logFn - Optional log callback(message, type)
     * @deprecated Use startMonitoring() and connectToDevice() instead
     */
    async connect(logFn) {
        this._logFn = logFn || ((msg, type) => console.log(`[${type}] ${msg}`));

        this._log('Requesting Web MIDI access...');

        // Connect via midi-connection.js
        const result = await connectToCandide();

        if (!result.input || !result.output) {
            // Build detailed error message
            const diag = result.diagnostics;
            let errorMsg = 'Candide device not found. Make sure it is connected via USB.\n\n';
            errorMsg += `Searched for ports containing: ${diag.searchTerms.join(', ')}\n\n`;
            if (diag.availableInputs.length === 0) {
                errorMsg += 'No MIDI input ports found.\n';
            } else {
                errorMsg += `Available MIDI inputs (${diag.availableInputs.length}):\n`;
                diag.availableInputs.forEach(i => {
                    errorMsg += `  - ${i.name} (${i.manufacturer || 'unknown'})\n`;
                });
            }
            throw new Error(errorMsg);
        }

        this.midiAccess = result.midiAccess;
        this.midiInput = result.input;
        this.midiOutput = result.output;

        // Set up MIDI input handler
        this.midiInput.onmidimessage = (event) => this._handleMidiMessage(event);

        // Initialize chunked transport
        this.transport = new ChunkedTransport(
            (sysexData) => { this.midiOutput.send(sysexData); return true; },
            (data, success) => this._handleTransportComplete(data, success),
            () => Date.now(),
            (msg, type) => this._log(msg, type)
        );

        this._log(`Connected to ${result.input.name}`);
    }

    /**
     * Disconnect from device
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

        if (this.midiInput) {
            this.midiInput.onmidimessage = null;
            this.midiInput.close();
            this.midiInput = null;
        }

        if (this.midiOutput) {
            this.midiOutput.close();
            this.midiOutput = null;
        }

        this.midiAccess = null;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingCmd = null;

        this._log('Disconnected');
    }

    /**
     * Check if connected
     */
    isConnected() {
        return this.midiOutput !== null;
    }

    /**
     * Get pending command name (for UI busy indicator)
     */
    getPendingCommand() {
        return this._pendingCmd;
    }

    /**
     * Register callback for save status changes
     * Device sends 'unsaved', 'saving', 'saved' status updates for auto-save
     * @param {Function} callback - Called with status string
     */
    onSaveStatusChanged(callback) {
        this._onSaveStatusChanged = callback;
    }

    /**
     * Register callback for external patch changes
     * Device sends patch change notifications when encoder/console changes patch in EDITOR mode
     * @param {Function} callback - Called with {status, op, index, current_index}
     */
    onExternalPatchChange(callback) {
        this._onExternalPatchChange = callback;
    }

    //======================================================================
    // PUBLIC: Lifecycle Commands
    //======================================================================

    /** Enter editor mode */
    async init() {
        return this._sendCommand({ cmd: 'init' });
    }

    /** Exit editor mode without saving */
    async eject() {
        return this._sendCommand({ cmd: 'eject' });
    }

    /** Save patches to QSPI */
    async save() {
        return this._sendCommand({ cmd: 'save' });
    }

    /** Save patches and exit editor mode */
    async saveAndExit() {
        return this._sendCommand({ cmd: 'save-and-exit' });
    }

    //======================================================================
    // PUBLIC: Firmware Update Commands
    //======================================================================

    /**
     * Upload firmware binary to device
     * Async protocol:
     *   1. Send upload-firmware command
     *   2. Device immediately ACKs with "erasing" status
     *   3. Device sends erase-progress updates during erase
     *   4. Device sends ready-for-firmware when erase complete
     *   5. Send segments via transport
     *   6. Device sends segment-done after each
     *   7. Device sends firmware-ready when all done
     *
     * @param {Uint8Array} firmwareBin - Firmware binary data
     * @param {Function} progressCallback - Progress callback({phase, percent, sector?, total?})
     * @returns {Promise} Resolves when firmware is written and ready
     */
    async uploadFirmware(firmwareBin, progressCallback) {
        const SEGMENT_SIZE = 32768;  // 32KB (matches device rx_buffer)
        const totalSize = firmwareBin.length;
        const totalSegments = Math.ceil(totalSize / SEGMENT_SIZE);

        this._log(`Firmware: ${totalSize} bytes, ${totalSegments} segments`);
        this._firmwareProgressCallback = progressCallback;

        // Step 1: Send command and wait for erase to complete
        // This is async - device immediately ACKs, then sends progress, then ready-for-firmware
        const readyResponse = await this._waitForFirmwareReady(totalSize);

        this._log(`Device ready: segment_size=${readyResponse.segment_size}, total_segments=${readyResponse.total_segments}`);

        if (progressCallback) {
            progressCallback({ phase: 'transferring', percent: 0 });
        }

        // Step 2: Send each segment via separate transport transfer
        for (let i = 0; i < totalSegments; i++) {
            const offset = i * SEGMENT_SIZE;
            const segment = firmwareBin.slice(offset, offset + SEGMENT_SIZE);

            this._log(`Sending segment ${i + 1}/${totalSegments} (${segment.length} bytes)`);

            await this._sendFirmwareSegment(segment, i, totalSegments);

            // Progress is reported by device via segment-done message
        }

        // Step 3: Wait for firmware-ready (final verification complete)
        return new Promise((resolve, reject) => {
            this._firmwareResolve = resolve;
            this._firmwareReject = reject;

            // Timeout for final verification (30 seconds)
            this._timeoutHandle = setTimeout(() => {
                this._firmwareProgressCallback = null;
                this._firmwareResolve = null;
                this._firmwareReject = null;
                reject(new Error('Firmware verification timeout'));
            }, 30000);
        });
    }

    /**
     * Send upload-firmware command and wait for ready-for-firmware
     * Handles async erase: erasing -> erase-progress -> ready-for-firmware
     * @private
     */
    _waitForFirmwareReady(totalSize) {
        return new Promise((resolve, reject) => {
            this._firmwareReadyResolve = resolve;
            this._firmwareReadyReject = reject;

            // Extended timeout for erase (2 minutes for large firmware)
            this._eraseTimeoutHandle = setTimeout(() => {
                this._firmwareReadyResolve = null;
                this._firmwareReadyReject = null;
                reject(new Error('Firmware erase timeout'));
            }, 120000);

            // Send command - device immediately responds with "erasing"
            const cmdObj = { cmd: 'upload-firmware', size: totalSize };
            const sysex = encodeJsonToSysEx(cmdObj);
            this.midiOutput.send(sysex);
            this._log(`TX: upload-firmware (size=${totalSize})`, 'tx');
        });
    }

    /**
     * Send a single firmware segment via transport
     * @private
     */
    _sendFirmwareSegment(segment, index, totalSegments) {
        return new Promise((resolve, reject) => {
            this._segmentResolve = resolve;
            this._segmentReject = reject;
            this._currentSegmentIndex = index;

            // Timeout for this segment (60 seconds)
            this._segmentTimeoutHandle = setTimeout(() => {
                this._segmentResolve = null;
                this._segmentReject = null;
                reject(new Error(`Segment ${index} timeout`));
            }, 60000);

            // Send segment via transport
            if (!this.transport.send(segment)) {
                clearTimeout(this._segmentTimeoutHandle);
                this._segmentResolve = null;
                this._segmentReject = null;
                reject(new Error('Transport busy'));
            }
        });
    }

    /**
     * Restart device after firmware update
     * Connection will be lost after this call.
     */
    async restartDevice() {
        await this._sendCommand({ cmd: 'restart-device' });
        // Device will restart, connection will be lost
    }

    /**
     * Get device information including firmware version
     * @returns {Promise} Device info object {project, version}
     */
    async getDeviceInfo() {
        return this._sendCommand({ cmd: 'get-device-info' });
    }

    //======================================================================
    // PUBLIC: Patch List Commands
    //======================================================================

    /** Get list of patch names and current index */
    async listPatches() {
        return this._sendCommand({ cmd: 'list-patches' });
    }

    /** Select patch by index */
    async selectPatch(index) {
        return this._sendCommand({ cmd: 'select-patch', index });
    }

    /** Create new patch with name */
    async createPatch(name) {
        return this._sendCommand({ cmd: 'create-patch', name });
    }

    /** Delete patch by index */
    async deletePatch(index) {
        return this._sendCommand({ cmd: 'delete-patch', index });
    }

    /** Rename patch */
    async renamePatch(index, name) {
        return this._sendCommand({ cmd: 'rename-patch', index, name });
    }

    /** Move patch from one index to another */
    async movePatch(from, to) {
        // NOTE: Using fromIdx/toIdx instead of from/to to avoid a macOS CoreMIDI bug
        // where certain byte patterns in mcoded7 encoding cause 15-second delays
        return this._sendCommand({ cmd: 'move-patch', fromIdx: from, toIdx: to });
    }

    //======================================================================
    // PUBLIC: Patch Data Commands
    //======================================================================

    /** Get full patch data by index */
    async getPatch(index) {
        console.log(`[API] getPatch(${index}) called`);
        console.trace('getPatch call stack');
        return this._sendCommand({ cmd: 'get-patch', index });
    }

    //======================================================================
    // PUBLIC: Parameter Commands (granular updates)
    //======================================================================

    /** Update single parameter value */
    async updateParam(index, param, value) {
        return this._sendCommand({ cmd: 'update-param', index, param, value });
    }

    /** Update parameter range (min/max) */
    async updateRange(index, param, min, max) {
        return this._sendCommand({ cmd: 'update-range', index, param, min, max });
    }

    /** Toggle module enable/disable */
    async toggleModule(index, module, enabled) {
        return this._sendCommand({ cmd: 'toggle-module', index, module, enabled });
    }

    /** Toggle modulation routing enable/disable */
    async toggleModulation(index, target, source, enabled) {
        return this._sendCommand({ cmd: 'toggle-modulation', index, target, source, enabled });
    }

    /** Update modulation amount */
    async updateModulationAmount(index, param, value) {
        return this._sendCommand({ cmd: 'update-modulation-amount', index, param, value });
    }

    /**
     * Toggle MIDI CC control for a parameter
     * @param {number} index - Patch index
     * @param {string} param - Parameter name
     * @param {boolean} enabled - Enable or disable CC
     * @returns {Promise} Response with {enabled, cc} - cc is assigned number when enabled
     */
    async toggleCC(index, param, enabled) {
        return this._sendCommand({ cmd: 'toggle-cc', index, param, enabled });
    }

    /**
     * Move module within patch (reorder for priority)
     * @param {number} index - Patch index
     * @param {string} fromModule - Module name to move
     * @param {string} toModule - Module name to move to (swap positions)
     * @returns {Promise} Response
     */
    async moveModule(index, fromModule, toModule) {
        return this._sendCommand({ cmd: 'move-module', index, fromModule, toModule });
    }

    //======================================================================
    // PUBLIC: MIDI Note helpers (for testing synth)
    //======================================================================

    /** Send MIDI note on */
    sendNoteOn(channel, note, velocity) {
        if (!this.midiOutput) return;
        const msg = buildMidi1NoteOn(channel, note, velocity);
        this.midiOutput.send(msg);
        this._log(`TX: Note On ch=${channel} note=${note} vel=${Math.round(velocity * 127)}`, 'tx');
    }

    /** Send MIDI note off */
    sendNoteOff(channel, note, velocity = 0) {
        if (!this.midiOutput) return;
        const msg = buildMidi1NoteOff(channel, note, velocity);
        this.midiOutput.send(msg);
        this._log(`TX: Note Off ch=${channel} note=${note}`, 'tx');
    }

    /** Send MIDI channel pressure */
    sendChannelPressure(channel, pressure) {
        if (!this.midiOutput) return;
        const msg = buildMidi1ChannelPressure(channel, pressure);
        this.midiOutput.send(msg);
        // Don't log continuously during drag to avoid spam
    }

    /** Send MIDI pitch bend */
    sendPitchBend(channel, bend) {
        if (!this.midiOutput) return;
        const msg = buildMidi1PitchBend(channel, bend);
        this.midiOutput.send(msg);
        // Don't log continuously during drag to avoid spam
    }

    /**
     * Send MIDI Control Change
     * @param {number} channel - MIDI channel (0-15)
     * @param {number} cc - Controller number (0-127)
     * @param {number} value - Normalized value (0.0-1.0), converted to 0-127
     */
    sendCC(channel, cc, value) {
        if (!this.midiOutput) return;
        // Convert normalized 0.0-1.0 to MIDI 7-bit value 0-127
        const value7 = Math.round(Math.max(0, Math.min(1, value)) * 127);
        const msg = new Uint8Array([
            0xB0 | (channel & 0x0F),  // Control Change status
            cc & 0x7F,                 // Controller number
            value7 & 0x7F              // Value
        ]);
        this.midiOutput.send(msg);
        // Don't log continuously during drag to avoid spam
    }

    //======================================================================
    // PUBLIC: Transport task (call periodically)
    //======================================================================

    /** Process transport timeouts - call from setInterval */
    task() {
        if (this.transport) {
            this.transport.task();
        }
    }

    //======================================================================
    // PRIVATE: Command handling
    //======================================================================

    /**
     * Send command and wait for response
     * @private
     */
    _sendCommand(cmdObj) {
        return new Promise((resolve, reject) => {
            // Gate: must be connected
            if (!this.midiOutput) {
                console.log(`[API] _sendCommand(${cmdObj.cmd}) rejected: not connected`);
                reject(new Error('Not connected'));
                return;
            }

            // Gate: must be idle (one command at a time)
            if (this._pendingResolve) {
                console.log(`[API] _sendCommand(${cmdObj.cmd}) rejected: busy with ${this._pendingCmd}`);
                reject(new Error(`Busy: waiting for ${this._pendingCmd}`));
                return;
            }

            // Store promise callbacks
            this._pendingResolve = resolve;
            this._pendingReject = reject;
            this._pendingCmd = cmdObj.cmd;

            // Send command via direct SysEx (commands are small)
            const sysex = encodeJsonToSysEx(cmdObj);
            console.log(`[API] _sendCommand sending: ${cmdObj.cmd}`);
            this.midiOutput.send(sysex);
            this._log(`TX: ${cmdObj.cmd}`, 'tx');

            // Set timeout
            this._timeoutHandle = setTimeout(() => {
                const cmd = this._pendingCmd;
                this._clearPending();
                reject(new Error(`Timeout: ${cmd}`));
            }, API_TIMEOUT_MS);
        });
    }

    /**
     * Resolve pending command with response
     * @private
     */
    _resolve(data) {
        if (this._pendingResolve) {
            const resolve = this._pendingResolve;
            this._clearPending();
            resolve(data);
        }
    }

    /**
     * Reject pending command with error
     * @private
     */
    _reject(error) {
        if (this._pendingReject) {
            const reject = this._pendingReject;
            this._clearPending();
            reject(error instanceof Error ? error : new Error(error));
        }
    }

    /**
     * Clear pending command state
     * @private
     */
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

    /**
     * Handle incoming MIDI message
     * @private
     */
    _handleMidiMessage(event) {
        const data = Array.from(event.data);

        // Check for SysEx start (F0)
        if (data[0] === 0xF0) {
            this._sysexBuffer = data;

            // Check if complete in single packet
            if (data[data.length - 1] === 0xF7) {
                this._processSysEx(this._sysexBuffer);
                this._sysexBuffer = [];
            }
        } else if (this._sysexBuffer.length > 0) {
            // Continue buffering
            this._sysexBuffer.push(...data);

            // Check if complete
            if (data[data.length - 1] === 0xF7) {
                this._processSysEx(this._sysexBuffer);
                this._sysexBuffer = [];
            }
        }
    }

    /**
     * Process complete SysEx message
     * @private
     */
    _processSysEx(data) {
        try {
            // Check if from Candide
            if (!isCandideSysEx(data)) {
                return;
            }

            // Extract and decode payload
            const payload = data.slice(3, -1);
            const decoded = mcoded7Decode(payload);

            if (decoded.length === 0) {
                this._log('Empty decoded payload', 'error');
                return;
            }

            // Check if transport protocol message (0x01-0x07)
            if (decoded[0] >= 0x01 && decoded[0] <= 0x07) {
                if (this.transport) {
                    this.transport.receive(decoded);
                }
                return;
            }

            // Otherwise it's JSON - decode and route
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

    /**
     * Handle transport completion
     * @private
     */
    _handleTransportComplete(data, success) {
        if (!success) {
            this._log('Transport transfer failed', 'error');
            // Check if this was a segment transfer
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

        // If no data, this was acknowledgment of our send (e.g., firmware segment)
        // The actual response comes via separate JSON message
        if (!data || data.length === 0) {
            return;
        }

        // Decode as JSON
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

    /**
     * Classify response type from JSON content
     * @private
     */
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
        if (json.status === 'device-info') return 'device-info';
        if (json.patches && Array.isArray(json.patches)) return 'list-patches';
        if (json.index !== undefined && json.name && !json.status) return 'get-patch';
        if (json.status === 'ok') return 'mutation-ack';
        return 'unknown';
    }

    /**
     * Check if response type matches the pending command
     * @private
     */
    _responseMatchesCommand(responseType, pendingCmd, json) {
        // Error responses match any command
        if (responseType === 'error') return true;

        // Specific response types for specific commands
        if (responseType === 'editor-active') return pendingCmd === 'init';
        if (responseType === 'editor-inactive') return pendingCmd === 'eject';

        // Save status messages are handled separately (not via pending command)
        if (responseType === 'save-status') return false;
        if (responseType === 'list-patches') return pendingCmd === 'list-patches';
        if (responseType === 'get-patch') return pendingCmd === 'get-patch';
        if (responseType === 'ready-for-firmware') return pendingCmd === 'upload-firmware';
        if (responseType === 'restarting') return pendingCmd === 'restart-device';
        if (responseType === 'device-info') return pendingCmd === 'get-device-info';

        // Firmware progress/completion are handled separately (not via pending command)
        if (responseType === 'flashing-progress') return false;
        if (responseType === 'firmware-ready') return false;
        if (responseType === 'firmware-validated') return false;

        // Mutation ACKs - check op field matches command
        if (responseType === 'mutation-ack') {
            return json.op === pendingCmd;
        }

        return false;
    }

    /**
     * Route response to appropriate handler
     * Validates that response matches pending command before resolving
     * @private
     */
    _routeResponse(json) {
        // Classify the response
        const responseType = this._classifyResponse(json);

        // Handle save status updates (unsaved, saving, saved)
        if (responseType === 'save-status') {
            this._log(`Save status: ${json.status}`);
            if (this._onSaveStatusChanged) {
                this._onSaveStatusChanged(json.status);
            }
            return;
        }

        // Handle erasing acknowledgment (firmware upload started)
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

        // Handle erase progress
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

        // Handle ready-for-firmware (erase complete)
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

        // Handle segment completion (during firmware upload)
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

        // Handle firmware progress (during firmware upload, no pending command)
        if (responseType === 'flashing-progress') {
            this._log(`Flashing: ${json.progress}%`);
            if (this._firmwareProgressCallback) {
                this._firmwareProgressCallback({ phase: 'flashing', percent: json.progress });
            }
            return;
        }

        // Handle firmware write complete (legacy: firmware-ready)
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

        // Handle firmware validated (new flow: separate restart step)
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

        // Handle firmware error (during erase or transfer)
        if (responseType === 'error' && (this._firmwareReadyReject || this._firmwareReject)) {
            this._log(`Firmware error: ${json.error}`, 'error');
            // Clear erase timeout if active
            if (this._eraseTimeoutHandle) {
                clearTimeout(this._eraseTimeoutHandle);
                this._eraseTimeoutHandle = null;
            }
            // Clear final timeout if active
            if (this._timeoutHandle) {
                clearTimeout(this._timeoutHandle);
                this._timeoutHandle = null;
            }
            // Reject whichever promise is pending
            const reject = this._firmwareReadyReject || this._firmwareReject;
            this._firmwareReadyResolve = null;
            this._firmwareReadyReject = null;
            this._firmwareResolve = null;
            this._firmwareReject = null;
            this._firmwareProgressCallback = null;
            reject(new Error(json.error));
            return;
        }

        // Handle external patch change (encoder/console while in EDITOR mode)
        // This is an unsolicited notification, not a response to our command
        if (json.op === 'select-patch' && !this._pendingCmd) {
            this._log(`External patch change: index=${json.current_index}`);
            if (this._onExternalPatchChange) {
                this._onExternalPatchChange(json);
            }
            return;
        }

        const pending = this._pendingCmd;

        // No pending command - unexpected response
        if (!pending) {
            this._log(`Response with no pending command: ${JSON.stringify(json)}`, 'warn');
            return;
        }

        // Handle errors immediately
        if (responseType === 'error') {
            this._log(`Error: ${json.error}`, 'error');
            this._reject(new Error(json.error));
            return;
        }

        // Handle save progress (don't resolve, just log)
        if (responseType === 'saving-progress') {
            this._log(`Saving: ${json.progress}%`);
            return;
        }

        // Verify response matches pending command
        if (!this._responseMatchesCommand(responseType, pending, json)) {
            this._log(`Mismatched response: got ${responseType}/${json.op || ''} but pending=${pending}`, 'warn');
            return;
        }

        // Response matches - resolve
        this._resolve(json);
    }

    /**
     * Log helper
     * @private
     */
    _log(msg, type = 'info') {
        if (this._logFn) {
            this._logFn(msg, type);
        }
    }
}

// Export for use in app.js (global scope for browser)
window.CandideAPI = CandideAPI;
