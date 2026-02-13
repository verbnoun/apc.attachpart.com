/**
 * Device Registry - Device Connection Manager
 *
 * Uses MidiPortManager for stable MIDI I/O.
 * This layer handles device-level concerns:
 * - KNOWN_PORTS whitelist filtering
 * - Device connection/disconnection callbacks
 * - API registration and message routing
 * - Device roles (controller/synth)
 * - MIDI through routing
 */

class DeviceRegistry {
    constructor() {
        this._portManager = null;

        // Connected devices (subset of available ports that are in KNOWN_PORTS)
        this._connectedDevices = new Set();

        // Registered APIs for message routing
        this._apis = {};  // { portName: api }

        // Device roles
        this._controllerPortName = null;
        this._synthPortName = null;

        // Callbacks
        this._onDeviceConnected = null;
        this._onDeviceDisconnected = null;
        this._onMidiThrough = null;
        this._onAllMidiInput = null;

        // Logging
        this._logFn = null;
        this._midiLoggingEnabled = false;

        // Exchange relay state
        this._exchangeRelayActive = false;
        this._exchangeSynthPort = null;
        this._exchangeControllerPort = null;
    }

    //==================================================================
    // PUBLIC: Initialization
    //==================================================================

    /**
     * Initialize the registry with a MidiPortManager
     * @param {Function} logFn - Logging callback (message, type)
     * @returns {Promise<void>}
     */
    async init(logFn = null) {
        this._logFn = logFn;

        // Create and initialize port manager
        this._portManager = new MidiPortManager();
        await this._portManager.init(logFn);

        // Listen for port changes
        this._portManager.onPortsChanged((inputs, outputs) => {
            this._handlePortsChanged(inputs, outputs);
        });

        this._log('Device registry initialized');
    }

    //==================================================================
    // PUBLIC: API Registration
    //==================================================================

    /**
     * Register an API instance to receive messages for a port
     * @param {string} portName
     * @param {Object} api - API instance with handleMidiMessage method
     */
    registerApi(portName, api) {
        this._apis[portName] = api;

        // Register with port manager for messages
        this._portManager.onMessage(portName, (event) => {
            this._handleMessage(portName, event);
        });

        this._log(`API registered for ${portName}`);
    }

    /**
     * Unregister an API instance
     * @param {string} portName
     */
    unregisterApi(portName) {
        delete this._apis[portName];
        this._portManager.offMessage(portName);
        this._log(`API unregistered for ${portName}`);
    }

    //==================================================================
    // PUBLIC: Send Messages
    //==================================================================

    /**
     * Send MIDI data to a device
     * @param {string} portName
     * @param {Uint8Array|Array} data
     */
    send(portName, data) {
        if (!this._portManager.send(portName, data)) {
            this._log(`Cannot send to ${portName}: not connected`, 'error');
        }
    }

    //==================================================================
    // PUBLIC: Callbacks
    //==================================================================

    /**
     * Set callback for device connection
     * @param {Function} callback - Called with (portName) when device connects
     */
    onDeviceConnected(callback) {
        this._onDeviceConnected = callback;
    }

    /**
     * Set callback for device disconnection
     * @param {Function} callback - Called with (portName) when device disconnects
     */
    onDeviceDisconnected(callback) {
        this._onDeviceDisconnected = callback;
    }

    /**
     * Set callback for MIDI through (non-SysEx routed from controller to synth)
     * @param {Function} callback - Called with MIDI data bytes
     */
    onMidiThrough(callback) {
        this._onMidiThrough = callback;
    }

    /**
     * Set callback for ALL incoming MIDI (non-SysEx) from any device
     * Used by Expression Pad MIDI monitor
     * @param {Function} callback - Called with (portName, data)
     */
    onAllMidiInput(callback) {
        this._onAllMidiInput = callback;
    }

    //==================================================================
    // PUBLIC: Device Roles
    //==================================================================

    /**
     * Set device as controller (for MIDI routing: controller -> synth)
     * @param {string} portName
     */
    setControllerDevice(portName) {
        this._controllerPortName = portName;
        this._log(`Controller role: ${portName}`);
    }

    /**
     * Set device as synth (for MIDI routing: controller -> synth)
     * @param {string} portName
     */
    setSynthDevice(portName) {
        this._synthPortName = portName;
        this._log(`Synth role: ${portName}`);
    }

    /**
     * Get controller port name
     * @returns {string|null}
     */
    getControllerPortName() {
        return this._controllerPortName;
    }

    /**
     * Get synth port name
     * @returns {string|null}
     */
    getSynthPortName() {
        return this._synthPortName;
    }

    //==================================================================
    // PUBLIC: Exchange Relay
    //==================================================================

    /**
     * Enable exchange relay between synth and controller
     * When active, exchange SysEx is routed between devices
     * @param {string} synthPort
     * @param {string} controllerPort
     */
    enableExchangeRelay(synthPort, controllerPort) {
        this._exchangeRelayActive = true;
        this._exchangeSynthPort = synthPort;
        this._exchangeControllerPort = controllerPort;
        this._log(`Exchange relay enabled: ${synthPort} ⇄ ${controllerPort}`);
    }

    /**
     * Disable exchange relay
     */
    disableExchangeRelay() {
        this._exchangeRelayActive = false;
        this._exchangeSynthPort = null;
        this._exchangeControllerPort = null;
        this._log('Exchange relay disabled');
    }

    /**
     * Check if exchange relay is active
     * @returns {boolean}
     */
    isExchangeRelayActive() {
        return this._exchangeRelayActive;
    }

    //==================================================================
    // PUBLIC: Queries
    //==================================================================

    /**
     * Check if a device is connected
     * @param {string} portName
     * @returns {boolean}
     */
    isConnected(portName) {
        return this._connectedDevices.has(portName);
    }

    /**
     * Get all connected device port names
     * @returns {string[]}
     */
    getConnectedDevices() {
        return Array.from(this._connectedDevices);
    }

    /**
     * Check if both controller and synth are connected
     * @returns {boolean}
     */
    isLinked() {
        return this._controllerPortName &&
               this._synthPortName &&
               this._connectedDevices.has(this._controllerPortName) &&
               this._connectedDevices.has(this._synthPortName);
    }

    //==================================================================
    // PUBLIC: MIDI Logging
    //==================================================================

    /**
     * Enable/disable verbose MIDI message logging
     * @param {boolean} enabled
     */
    setMidiLogging(enabled) {
        this._midiLoggingEnabled = enabled;
    }

    //==================================================================
    // INTERNAL: Port Change Handling
    //==================================================================

    /**
     * Handle ports changed event from MidiPortManager
     * Filter by KNOWN_PORTS and fire connection/disconnection callbacks
     * @private
     */
    _handlePortsChanged(inputs, outputs) {
        // A device is "connected" if it's in KNOWN_PORTS and has both input AND output
        const inputSet = new Set(inputs);
        const outputSet = new Set(outputs);

        const nowConnected = new Set();

        for (const portName of KNOWN_PORTS) {
            if (inputSet.has(portName) && outputSet.has(portName)) {
                nowConnected.add(portName);
            }
        }

        // Detect new connections
        for (const portName of nowConnected) {
            if (!this._connectedDevices.has(portName)) {
                this._log(`Connected: ${portName}`, 'success');
                this._onDeviceConnected?.(portName);
            }
        }

        // Detect disconnections
        for (const portName of this._connectedDevices) {
            if (!nowConnected.has(portName)) {
                this._log(`Disconnected: ${portName}`, 'warning');

                // Clear role if this device had one
                if (this._controllerPortName === portName) {
                    this._controllerPortName = null;
                }
                if (this._synthPortName === portName) {
                    this._synthPortName = null;
                }

                // Disable exchange relay if this port was involved
                if (this._exchangeRelayActive &&
                    (portName === this._exchangeSynthPort || portName === this._exchangeControllerPort)) {
                    this.disableExchangeRelay();
                }

                // Unregister API
                this.unregisterApi(portName);

                this._onDeviceDisconnected?.(portName);
            }
        }

        this._connectedDevices = nowConnected;

        // Log current state
        if (nowConnected.size > 0) {
            this._log(`Connected devices: ${Array.from(nowConnected).join(', ')}`);
        }
    }

    //==================================================================
    // INTERNAL: Message Handling
    //==================================================================

    /**
     * Handle incoming MIDI message
     * Routes SysEx to registered API (and relays during exchange)
     * Forwards non-SysEx for controller->synth
     * @private
     */
    _handleMessage(portName, event) {
        const data = event.data;

        // SysEx handling
        if (data[0] === 0xF0) {
            // Always route to device's own API for local handling/logging
            const api = this._apis[portName];
            if (api?.handleMidiMessage) {
                api.handleMidiMessage(event);
            }

            // Exchange relay: forward SysEx between synth and controller
            if (this._exchangeRelayActive) {
                if (portName === this._exchangeSynthPort && this._exchangeControllerPort) {
                    // Synth → Controller
                    this._log(`RELAY: Synth → Controller (${data.length} bytes)`, 'midi');
                    this.send(this._exchangeControllerPort, data);
                } else if (portName === this._exchangeControllerPort && this._exchangeSynthPort) {
                    // Controller → Synth
                    this._log(`RELAY: Controller → Synth (${data.length} bytes)`, 'midi');
                    this.send(this._exchangeSynthPort, data);
                }
            }
            return;
        }

        // Fire all-input callback for MIDI monitor (all non-SysEx from any device)
        this._onAllMidiInput?.(portName, data);

        // Non-SysEx: forward controller -> synth if routing enabled
        if (this._controllerPortName === portName && this._synthPortName) {
            this.send(this._synthPortName, data);

            // Notify UI for display update
            this._onMidiThrough?.(data);

            // Optional verbose logging
            if (this._midiLoggingEnabled) {
                this._log(`ROUTE: [${this._formatMidi(data)}]`, 'midi');
            }
        }
    }

    //==================================================================
    // INTERNAL: Logging
    //==================================================================

    _log(message, type = 'info') {
        this._logFn?.(message, type);
        console.log(`[DeviceRegistry] ${message}`);
    }

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

window.DeviceRegistry = DeviceRegistry;
