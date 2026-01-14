/**
 * Device Registry - Multi-Device MIDI Connection Manager
 *
 * Manages connections to multiple AttachPart devices (Bartleby, Candide)
 * and provides lightning-fast MIDI routing between them.
 *
 * Architecture:
 *   - Single MIDIAccess object shared across all devices
 *   - Each device has independent input/output ports
 *   - When linked: Bartleby input routes directly to Candide output
 *   - Hot-plug support via statechange monitoring
 */

//======================================================================
// DEVICE DEFINITIONS
//======================================================================

const DEVICE_CONFIGS = {
    bartleby: {
        searchTerms: ['bartleby', 'pico'],
        type: 'controller',
        displayName: 'Bartleby'
    },
    candide: {
        searchTerms: ['candide', 'daisy', 'seed'],
        type: 'synth',
        displayName: 'Candide'
    }
};

//======================================================================
// DEVICE REGISTRY CLASS
//======================================================================

class DeviceRegistry {
    constructor() {
        this.midiAccess = null;
        this.devices = {
            bartleby: { input: null, output: null, name: null },
            candide: { input: null, output: null, name: null }
        };
        this._routingEnabled = false;
        this._onDeviceChange = null;
        this._onBartlebyConnected = null;
        this._onBartlebyDisconnected = null;
        this._onCandideConnected = null;
        this._onCandideDisconnected = null;
        this._logFn = null;
        this._midiLoggingEnabled = false;  // Controlled by log panel expand/collapse
        this._bartlebyApi = null;  // Reference for SysEx routing
        this._onMidiThrough = null;  // Callback for incoming MIDI display updates
    }

    //==================================================================
    // PUBLIC API
    //==================================================================

    /**
     * Initialize the registry and start device monitoring
     * @param {Function} logFn - Logging callback (message, type)
     * @returns {Promise<void>}
     */
    async init(logFn = null) {
        this._logFn = logFn;

        if (!navigator.requestMIDIAccess) {
            this._log('Web MIDI API not supported', 'error');
            throw new Error('Web MIDI API not supported');
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
            this._log('MIDI access granted');
        } catch (error) {
            this._log('MIDI access denied: ' + error.message, 'error');
            throw error;
        }

        // Initial scan
        this._scanAndConnect();

        // Monitor for hot-plug
        this.midiAccess.onstatechange = (event) => {
            const port = event.port;
            this._log(`Port ${port.state}: ${port.name} (${port.type})`);

            if (port.state === 'connected') {
                this._scanAndConnect();
            } else if (port.state === 'disconnected') {
                this._handleDisconnect(port.name);
            }
        };
    }

    /**
     * Set callback for device state changes
     * @param {Function} callback - Called when any device connects/disconnects
     */
    onDeviceChange(callback) {
        this._onDeviceChange = callback;
    }

    /**
     * Check if both devices are connected and linked
     * @returns {boolean}
     */
    isLinked() {
        return this.devices.bartleby.input !== null &&
               this.devices.candide.output !== null;
    }

    /**
     * Get device connection status
     * @param {string} deviceId - 'bartleby' or 'candide'
     * @returns {Object} - { connected, name }
     */
    getDeviceStatus(deviceId) {
        const device = this.devices[deviceId];
        return {
            connected: device.input !== null,
            name: device.name
        };
    }

    /**
     * Get Candide output port (for expression pad / direct MIDI)
     * @returns {MIDIOutput|null}
     */
    getCandideOutput() {
        return this.devices.candide.output;
    }

    /**
     * Get Candide input port (for SysEx responses)
     * @returns {MIDIInput|null}
     */
    getCandideInput() {
        return this.devices.candide.input;
    }

    /**
     * Get Bartleby output port (for config commands)
     * @returns {MIDIOutput|null}
     */
    getBartlebyOutput() {
        return this.devices.bartleby.output;
    }

    /**
     * Get Bartleby input port (for SysEx responses)
     * @returns {MIDIInput|null}
     */
    getBartlebyInput() {
        return this.devices.bartleby.input;
    }

    /**
     * Set callback for Bartleby connection
     * Called when Bartleby connects so app can initialize BartlebyAPI
     * @param {Function} callback - Called with no args when Bartleby connects
     */
    onBartlebyConnected(callback) {
        this._onBartlebyConnected = callback;
    }

    /**
     * Set callback for Bartleby disconnection
     * @param {Function} callback
     */
    onBartlebyDisconnected(callback) {
        this._onBartlebyDisconnected = callback;
    }

    /**
     * Set callback for Candide connection
     * @param {Function} callback
     */
    onCandideConnected(callback) {
        this._onCandideConnected = callback;
    }

    /**
     * Set callback for Candide disconnection
     * @param {Function} callback
     */
    onCandideDisconnected(callback) {
        this._onCandideDisconnected = callback;
    }

    /**
     * Enable/disable MIDI message logging
     * When disabled, no logging happens in the hot path (zero latency)
     * @param {boolean} enabled
     */
    setMidiLogging(enabled) {
        this._midiLoggingEnabled = enabled;
    }

    /**
     * Set callback for incoming MIDI (called AFTER forwarding to Candide)
     * Used by UI to display incoming notes/expression without affecting throughput
     * @param {Function} callback - Called with MIDI data bytes
     */
    onMidiThrough(callback) {
        this._onMidiThrough = callback;
    }

    /**
     * Set the BartlebyAPI instance for SysEx routing
     * CRITICAL: DeviceRegistry owns the MIDI input handler for Bartleby.
     * BartlebyAPI must NOT set onmidimessage - DeviceRegistry routes SysEx to it.
     * @param {BartlebyAPI} api
     */
    setBartlebyApi(api) {
        this._bartlebyApi = api;
    }

    //==================================================================
    // INTERNAL: Device Detection
    //==================================================================

    /**
     * Scan all ports and connect matching devices
     * @private
     */
    _scanAndConnect() {
        const inputs = Array.from(this.midiAccess.inputs.values());
        const outputs = Array.from(this.midiAccess.outputs.values());

        for (const deviceId in DEVICE_CONFIGS) {
            // Skip if already connected
            if (this.devices[deviceId].input) continue;

            const config = DEVICE_CONFIGS[deviceId];
            const result = this._detectDevice(inputs, outputs, config.searchTerms);

            if (result) {
                this._connectDevice(deviceId, result.input, result.output);
                this._log(`${config.displayName} connected: ${result.input.name}`);
            }
        }
    }

    /**
     * Detect a device by search terms
     * @private
     */
    _detectDevice(inputs, outputs, searchTerms) {
        for (const term of searchTerms) {
            for (const input of inputs) {
                if (input.name?.toLowerCase().includes(term)) {
                    const output = outputs.find(o => o.name === input.name);
                    if (output) {
                        return { input, output, matchedTerm: term };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Connect a device
     * @private
     */
    _connectDevice(deviceId, input, output) {
        this.devices[deviceId] = { input, output, name: input.name };
        this._updateRouting();
        this._onDeviceChange?.();

        // Notify app if device connected (for API initialization)
        if (deviceId === 'bartleby') {
            this._onBartlebyConnected?.();
        } else if (deviceId === 'candide') {
            this._onCandideConnected?.();
        }
    }

    /**
     * Handle device disconnection
     * @private
     */
    _handleDisconnect(portName) {
        for (const deviceId in this.devices) {
            if (this.devices[deviceId].name === portName) {
                const config = DEVICE_CONFIGS[deviceId];
                this._log(`${config.displayName} disconnected`);

                // Clear device
                this.devices[deviceId] = { input: null, output: null, name: null };

                // Disable routing if linked state broken
                if (deviceId === 'bartleby' || deviceId === 'candide') {
                    this._routingEnabled = false;
                }

                // Notify app if device disconnected
                if (deviceId === 'bartleby') {
                    this._onBartlebyDisconnected?.();
                } else if (deviceId === 'candide') {
                    this._onCandideDisconnected?.();
                }

                this._onDeviceChange?.();
                break;
            }
        }
    }

    //==================================================================
    // INTERNAL: Lightning-Fast MIDI Routing
    //==================================================================

    /**
     * Update routing when device state changes
     *
     * CRITICAL: This sets up the hot path for MIDI routing.
     * The handler must be as fast as possible - no logging, no parsing.
     *
     * @private
     */
    _updateRouting() {
        const bart = this.devices.bartleby;
        const cand = this.devices.candide;

        // Enable routing when both devices connected
        if (bart.input && cand.output && !this._routingEnabled) {
            this._log('Enabling MIDI routing: Bartleby -> Candide');

            // Send "init" command to Bartleby to force MPE mode
            // (Web MIDI API = MIDI 1.0, so Bartleby needs to convert MIDI 2.0 → MPE)
            this._sendBartlebyInit();

            // LIGHTNING-FAST ROUTING HANDLER
            // This is the hot path - must be O(1) with no allocations
            // Logging only happens when explicitly enabled (log panel expanded)
            bart.input.onmidimessage = (event) => {
                const data = event.data;

                // Fast path: Forward non-SysEx directly to Candide
                // Check < 0xF0 to exclude all system messages (SysEx, timing, etc.)
                if (data[0] < 0xF0) {
                    cand.output.send(data);

                    // Notify UI for display update (after forwarding - throughput first)
                    this._onMidiThrough?.(data);

                    // Optional logging (only when log panel expanded)
                    if (this._midiLoggingEnabled && this._logFn) {
                        this._logFn(`ROUTE: [${this._formatMidi(data)}] Bartleby -> Candide`, 'midi');
                    }
                } else {
                    // SysEx and system messages: route to BartlebyAPI for config responses
                    // CRITICAL: Do NOT forward to Candide - SysEx is for Bartleby config only
                    if (this._bartlebyApi) {
                        this._bartlebyApi.handleMidiMessage(event);
                    }
                }
            };

            this._routingEnabled = true;
            this._onDeviceChange?.();
        }
    }

    //==================================================================
    // INTERNAL: Bartleby Commands
    //==================================================================

    /**
     * Send "init" command to Bartleby to force MPE mode
     * This is needed because macOS completes MIDI 2.0 handshake but then
     * converts to MIDI 1.0 for web browsers, dropping per-note pitch bend.
     * @private
     */
    _sendBartlebyInit() {
        const bart = this.devices.bartleby;
        if (!bart.output) return;

        // Build SysEx: F0 <json bytes> F7
        const json = JSON.stringify({ cmd: 'init' });
        const jsonBytes = new TextEncoder().encode(json);

        // Validate JSON bytes are 7-bit clean (SysEx requirement)
        for (let i = 0; i < jsonBytes.length; i++) {
            if (jsonBytes[i] > 0x7F) {
                this._log('Bartleby init failed: JSON contains non-7-bit chars', 'error');
                return;
            }
        }

        const sysex = new Uint8Array(jsonBytes.length + 2);
        sysex[0] = 0xF0;  // SysEx start
        sysex.set(jsonBytes, 1);
        sysex[sysex.length - 1] = 0xF7;  // SysEx end

        try {
            bart.output.send(sysex);
            this._log('Sent init to Bartleby (forcing MPE mode)');
        } catch (e) {
            this._log(`Bartleby init failed: ${e.message}`, 'error');
        }
    }

    //==================================================================
    // INTERNAL: Logging
    //==================================================================

    /**
     * Log a message
     * @private
     */
    _log(message, type = 'info') {
        this._logFn?.(message, type);
        console.log(`[DeviceRegistry] ${message}`);
    }

    /**
     * Format MIDI bytes as hex string with message type annotation
     * @private
     */
    _formatMidi(data) {
        const bytes = Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        const status = data[0] & 0xF0;
        const ch = data[0] & 0x0F;
        let type = '';
        switch (status) {
            case 0x80: type = `NoteOff ch${ch}`; break;
            case 0x90: type = `NoteOn ch${ch}`; break;
            case 0xA0: type = `PolyPres ch${ch}`; break;
            case 0xB0: type = `CC ch${ch}`; break;
            case 0xC0: type = `PgmChg ch${ch}`; break;
            case 0xD0: type = `ChanPres ch${ch}`; break;
            case 0xE0: type = `PitchBend ch${ch}`; break;
            default: type = 'Unknown';
        }
        return `${bytes} (${type})`;
    }
}

//======================================================================
// GLOBAL INSTANCE
//======================================================================

const deviceRegistry = new DeviceRegistry();
