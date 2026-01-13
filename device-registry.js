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
        this._logFn = null;
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

            // LIGHTNING-FAST ROUTING HANDLER
            // This is the hot path - must be O(1) with no allocations
            bart.input.onmidimessage = (event) => {
                const data = event.data;

                // Fast path: Forward non-SysEx directly
                // Check < 0xF0 to exclude all system messages (SysEx, timing, etc.)
                if (data[0] < 0xF0) {
                    cand.output.send(data);
                }
                // SysEx (0xF0+) not forwarded - will be used for Bartleby config later
            };

            this._routingEnabled = true;
            this._onDeviceChange?.();
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
}

//======================================================================
// GLOBAL INSTANCE
//======================================================================

const deviceRegistry = new DeviceRegistry();
