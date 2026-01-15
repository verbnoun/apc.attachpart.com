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
        preferredPortName: 'Bartleby MPE',  // Prefer MPE port for sysex communication
        type: 'controller',
        displayName: 'Bartleby'
    },
    candide: {
        searchTerms: ['candide', 'daisy', 'seed'],
        preferredPortName: 'Candide MPE',   // Prefer MPE port for sysex communication
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

        // Controller exchange relay state
        this._relayEnabled = false;
        this._exchangeInProgress = false;
        this._controllerCapabilities = null;

        // Mock device support
        this._mockBartleby = null;
        this._mockCandide = null;
        this._useMockBartleby = false;
        this._useMockCandide = false;
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
    // MOCK DEVICE API (for testing without hardware)
    //==================================================================

    /**
     * Enable mock Bartleby for testing Candide
     * Use when testing Candide without real Bartleby hardware
     */
    enableMockBartleby() {
        this._useMockBartleby = true;
        this._mockBartleby = new MockBartleby((json) => {
            // Mock sends response - route to Candide
            this._sendJsonToCandide(json);
        });
        this._log('Mock Bartleby enabled');
    }

    /**
     * Enable mock Candide for testing Bartleby
     * Use when testing Bartleby without real Candide hardware
     */
    enableMockCandide() {
        this._useMockCandide = true;
        this._mockCandide = new MockCandide((json) => {
            // Mock sends response - route to Bartleby
            this._sendJsonToBartleby(json);
        });
        this._log('Mock Candide enabled');
    }

    /**
     * Disable all mock devices
     */
    disableMocks() {
        this._useMockBartleby = false;
        this._useMockCandide = false;
        this._mockBartleby = null;
        this._mockCandide = null;
        this._log('Mocks disabled');
    }

    //==================================================================
    // CONTROLLER EXCHANGE RELAY
    //==================================================================

    /**
     * Manually trigger controller exchange
     * Call when both devices are connected to start the exchange flow
     */
    triggerControllerExchange() {
        if (this._exchangeInProgress) {
            this._log('Exchange already in progress', 'warn');
            return;
        }

        this._exchangeInProgress = true;
        this._relayEnabled = true;

        if (this._useMockCandide && this._mockCandide) {
            // Trigger mock Candide
            this._log('Triggering MockCandide exchange');
            this._mockCandide.handleCommand({ cmd: 'controller-available' });
        } else if (this.devices.candide.output) {
            // Trigger real Candide
            this._log('Triggering Candide exchange');
            this._sendJsonToCandide({ cmd: 'controller-available' });
        } else {
            this._log('Cannot trigger exchange: Candide not connected', 'error');
            this._exchangeInProgress = false;
            this._relayEnabled = false;
        }
    }

    /**
     * Get cached controller capabilities (from last exchange)
     * @returns {Object|null}
     */
    getControllerCapabilities() {
        return this._controllerCapabilities;
    }

    //==================================================================
    // INTERNAL: SysEx Relay Helpers
    //==================================================================

    /**
     * Send JSON to Candide as SysEx (via MIDI or mock)
     * @private
     */
    _sendJsonToCandide(json) {
        if (this._useMockCandide && this._mockCandide) {
            this._mockCandide.handleCommand(json);
            return;
        }

        const cand = this.devices.candide;
        if (!cand.output) {
            this._log('Cannot send to Candide: not connected', 'error');
            return;
        }

        const sysex = this._buildSysEx(json);
        try {
            cand.output.send(sysex);
            this._log(`Relay -> Candide: ${json.cmd}`);
        } catch (e) {
            this._log(`Relay -> Candide failed: ${e.message}`, 'error');
        }
    }

    /**
     * Send JSON to Bartleby as SysEx (via MIDI or mock)
     * @private
     */
    _sendJsonToBartleby(json) {
        if (this._useMockBartleby && this._mockBartleby) {
            this._mockBartleby.handleCommand(json);
            return;
        }

        const bart = this.devices.bartleby;
        if (!bart.output) {
            this._log('Cannot send to Bartleby: not connected', 'error');
            return;
        }

        const sysex = this._buildSysEx(json);
        try {
            bart.output.send(sysex);
            this._log(`Relay -> Bartleby: ${json.cmd}`);
        } catch (e) {
            this._log(`Relay -> Bartleby failed: ${e.message}`, 'error');
        }
    }

    /**
     * Build SysEx message from JSON
     * @private
     */
    _buildSysEx(json) {
        const jsonStr = JSON.stringify(json);
        const jsonBytes = new TextEncoder().encode(jsonStr);
        const encoded = mcoded7Encode(jsonBytes);

        const sysex = new Uint8Array(3 + encoded.length + 1);
        sysex[0] = 0xF0;     // SysEx start
        sysex[1] = 0x7D;     // Manufacturer ID
        sysex[2] = 0x00;     // Device ID
        sysex.set(encoded, 3);
        sysex[sysex.length - 1] = 0xF7;  // SysEx end

        return sysex;
    }

    /**
     * Parse SysEx to JSON (if valid 0x7D message)
     * @private
     */
    _parseSysExJson(sysex) {
        // Validate: F0 7D 00 [payload] F7
        if (sysex[0] !== 0xF0 || sysex[1] !== 0x7D || sysex[2] !== 0x00) {
            return null;
        }
        if (sysex[sysex.length - 1] !== 0xF7) {
            return null;
        }

        try {
            const payload = sysex.slice(3, -1);
            const decoded = mcoded7Decode(payload);
            const jsonStr = new TextDecoder().decode(decoded);
            return JSON.parse(jsonStr);
        } catch (e) {
            return null;
        }
    }

    /**
     * Process relay message from Candide
     * @private
     */
    _processRelayFromCandide(sysex) {
        const json = this._parseSysExJson(sysex);
        if (!json) return;

        const cmd = json.cmd;
        if (cmd === 'get-control-surface' || cmd === 'assign') {
            this._log(`Relay: Candide -> Bartleby: ${cmd}`);
            this._sendJsonToBartleby(json);
        }
    }

    /**
     * Process relay message from Bartleby
     * @private
     */
    _processRelayFromBartleby(sysex) {
        const json = this._parseSysExJson(sysex);
        if (!json) return;

        const cmd = json.cmd;
        if (cmd === 'control-surface' || cmd === 'thanks') {
            this._log(`Relay: Bartleby -> Candide: ${cmd}`);

            // Cache control-surface for UI
            if (cmd === 'control-surface') {
                this._controllerCapabilities = json;
            }

            // Forward to Candide
            this._sendJsonToCandide(json);

            // Exchange complete on 'thanks'
            if (cmd === 'thanks') {
                this._log('Relay: Exchange complete');
                this._exchangeInProgress = false;
                // Keep relay enabled for future patch switches
            }
        }
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

        // Log available ports for debugging
        this._log(`Scanning ${inputs.length} inputs, ${outputs.length} outputs...`);
        if (inputs.length > 0) {
            this._log(`  Inputs: ${inputs.map(i => i.name).join(', ')}`);
        }
        if (outputs.length > 0) {
            this._log(`  Outputs: ${outputs.map(o => o.name).join(', ')}`);
        }

        for (const deviceId in DEVICE_CONFIGS) {
            // Skip if already connected
            if (this.devices[deviceId].input) continue;

            const config = DEVICE_CONFIGS[deviceId];
            const result = this._detectDevice(inputs, outputs, config.searchTerms, config.preferredPortName);

            if (result) {
                this._connectDevice(deviceId, result.input, result.output);
                // Log which strategy matched
                if (result.matchedBy === 'preferred') {
                    this._log(`✓ ${config.displayName}: Selected preferred port "${result.input.name}"`);
                } else {
                    this._log(`✓ ${config.displayName}: Matched by search term "${result.matchedTerm}" → "${result.input.name}"`);
                }
            }
        }
    }

    /**
     * Detect a device by preferred port name, then search terms
     * @private
     * @returns {Object|null} { input, output, matchedBy, matchedTerm }
     *   - matchedBy: 'preferred' or 'search'
     *   - matchedTerm: the port name or search term that matched
     */
    _detectDevice(inputs, outputs, searchTerms, preferredPortName = null) {
        // Strategy 1: Look for preferred port name (exact match)
        if (preferredPortName) {
            const input = inputs.find(i => i.name === preferredPortName);
            if (input) {
                const output = outputs.find(o => o.name === preferredPortName);
                if (output) {
                    return { input, output, matchedBy: 'preferred', matchedTerm: preferredPortName };
                }
            }
        }

        // Strategy 2: Fall back to search terms
        for (const term of searchTerms) {
            for (const input of inputs) {
                if (input.name?.toLowerCase().includes(term)) {
                    const output = outputs.find(o => o.name === input.name);
                    if (output) {
                        return { input, output, matchedBy: 'search', matchedTerm: term };
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

                    // Reset relay state
                    this._relayEnabled = false;
                    this._exchangeInProgress = false;
                    this._log('Relay disabled - device disconnected');
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

            // BARTLEBY INPUT HANDLER
            // Handles MIDI routing and relay SysEx
            bart.input.onmidimessage = (event) => {
                const data = event.data;

                // Fast path: Forward non-SysEx directly to Candide
                if (data[0] < 0xF0) {
                    cand.output.send(data);

                    // Notify UI for display update (after forwarding - throughput first)
                    this._onMidiThrough?.(data);

                    // Optional logging (only when log panel expanded)
                    if (this._midiLoggingEnabled && this._logFn) {
                        this._logFn(`ROUTE: [${this._formatMidi(data)}] Bartleby -> Candide`, 'midi');
                    }
                } else {
                    // SysEx: check for relay, then route to BartlebyAPI
                    if (this._relayEnabled && data[0] === 0xF0) {
                        this._processRelayFromBartleby(data);
                    }
                    // Also route to BartlebyAPI for config responses
                    if (this._bartlebyApi) {
                        this._bartlebyApi.handleMidiMessage(event);
                    }
                }
            };

            // CANDIDE INPUT HANDLER (for relay SysEx)
            cand.input.onmidimessage = (event) => {
                const data = event.data;

                // Only process SysEx for relay
                if (data[0] === 0xF0 && this._relayEnabled) {
                    this._processRelayFromCandide(data);
                }
            };

            this._routingEnabled = true;
            this._onDeviceChange?.();

            // Auto-trigger exchange when both devices connected
            if (!this._exchangeInProgress) {
                this._log('Both devices connected - triggering controller exchange');
                // Small delay to let devices stabilize
                setTimeout(() => this.triggerControllerExchange(), 500);
            }
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

// Expose to window for console testing:
//   deviceRegistry.enableMockBartleby()  - Test Candide without Bartleby
//   deviceRegistry.enableMockCandide()   - Test Bartleby without Candide
//   deviceRegistry.disableMocks()        - Use real devices
//   deviceRegistry.triggerControllerExchange() - Manually trigger exchange
window.deviceRegistry = deviceRegistry;
