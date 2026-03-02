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
 *
 * RelaySniffer loaded from relay-sniffer.js
 */

class DeviceRegistry {
    constructor() {
        this._portManager = null;

        // Connected devices (subset of available ports that are in KNOWN_PORTS)
        this._connectedDevices = new Set();

        // Registered APIs for message routing
        this._apis = {};  // { portName: api }

        // Route map (replaces singular device roles)
        this._routes = [];        // Array of { from: controllerPort, to: synthPort }
        this._configPairs = {};   // { controllerPort: synthPort } — 1:1 config pairing

        // Callbacks
        this._onDeviceConnected = null;
        this._onDeviceDisconnected = null;
        this._onMidiThrough = null;
        this._onAllMidiInput = null;
        this._onValueFeedback = null;
        this._onRoutesChanged = null;

        // Logging
        this._logFn = null;
        this._midiLoggingEnabled = false;

        // Exchange relay state
        this._exchangeRelayActive = false;
        this._exchangeSynthPort = null;
        this._exchangeControllerPort = null;

        // Relay sniffer — passive transport decoder for exchange traffic
        this._relaySniffer = new RelaySniffer((json) => this._handleSniffedJson(json));
        this._onControlSurface = null;
        this._onControlSurfaceInfo = null;
        this._controlSurfaceInfo = null;
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

    /**
     * Get the underlying MidiPortManager (for virtual port registration)
     * @returns {MidiPortManager}
     */
    getPortManager() {
        return this._portManager;
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

    /**
     * Set callback for value feedback (synth → controller display updates)
     * Fired when 0x7D value/ADSR feedback SysEx passes through the relay.
     * @param {Function} callback - Called with ({ cc, displayText, adsr? })
     *   adsr present for envelope params: { env, segment, values: [A,D,S,R] }
     */
    onValueFeedback(callback) {
        this._onValueFeedback = callback;
    }

    /**
     * Set callback for control surface data (intercepted from exchange)
     * Fired when sniffer decodes a set-patch message from synth → controller.
     * @param {Function} callback - Called with (controls[])
     */
    onControlSurface(callback) {
        this._onControlSurface = callback;
    }

    /**
     * Set callback for control-surface info (intercepted from controller → synth)
     * Fired when sniffer decodes a control-surface response (dial counts, etc).
     * @param {Function} callback - Called with ({ op, controls })
     */
    onControlSurfaceInfo(callback) {
        this._onControlSurfaceInfo = callback;
    }

    /**
     * Get the last captured control-surface info
     * @returns {Object|null} e.g. { op: 'control-surface', controls: { '1d.abs.rotary': 16 } }
     */
    getControlSurfaceInfo() {
        return this._controlSurfaceInfo || null;
    }

    //==================================================================
    // PUBLIC: Route Map (many-to-many MIDI routing)
    //==================================================================

    addRoute(from, to) {
        if (this.hasRoute(from, to)) return false;
        this._routes.push({ from, to });
        this._log(`Route added: ${from} → ${to}`);
        this._onRoutesChanged?.();
        return true;
    }

    removeRoute(from, to) {
        const idx = this._routes.findIndex(r => r.from === from && r.to === to);
        if (idx === -1) return false;
        this._routes.splice(idx, 1);
        // Clear config pair if it used this route
        if (this._configPairs[from] === to) {
            delete this._configPairs[from];
        }
        this._log(`Route removed: ${from} → ${to}`);
        this._onRoutesChanged?.();
        return true;
    }

    getRoutes() {
        return [...this._routes];
    }

    getRoutesFrom(port) {
        return this._routes.filter(r => r.from === port).map(r => r.to);
    }

    getRoutesTo(port) {
        return this._routes.filter(r => r.to === port).map(r => r.from);
    }

    hasRoute(from, to) {
        return this._routes.some(r => r.from === from && r.to === to);
    }

    removeRoutesForPort(port) {
        const before = this._routes.length;
        this._routes = this._routes.filter(r => r.from !== port && r.to !== port);
        // Clear config pairs involving this port
        for (const ctrl of Object.keys(this._configPairs)) {
            if (ctrl === port || this._configPairs[ctrl] === port) {
                delete this._configPairs[ctrl];
            }
        }
        if (this._routes.length !== before) {
            this._log(`Routes cleared for ${port}`);
            this._onRoutesChanged?.();
        }
    }

    clearRoutes() {
        this._routes = [];
        this._configPairs = {};
        this._onRoutesChanged?.();
    }

    onRoutesChanged(callback) {
        this._onRoutesChanged = callback;
    }

    //==================================================================
    // PUBLIC: Config Pairs (1:1 controller→synth pairing)
    //==================================================================

    setConfigPair(controllerPort, synthPort) {
        if (!this.hasRoute(controllerPort, synthPort)) return false;
        // Config is 1:1 both ways — clear any existing pair involving this synth
        for (const [ctrl, synth] of Object.entries(this._configPairs)) {
            if (synth === synthPort && ctrl !== controllerPort) {
                delete this._configPairs[ctrl];
            }
        }
        this._configPairs[controllerPort] = synthPort;
        this._log(`Config pair: ${controllerPort} ⇄ ${synthPort}`);
        this._onRoutesChanged?.();
        return true;
    }

    clearConfigPair(controllerPort) {
        if (!(controllerPort in this._configPairs)) return;
        delete this._configPairs[controllerPort];
        this._onRoutesChanged?.();
    }

    getConfigPair(controllerPort) {
        return this._configPairs[controllerPort] || null;
    }

    getConfigPairs() {
        return { ...this._configPairs };
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
        this._relaySniffer._reset();
        this._controlSurfaceInfo = null;
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

                // Clear routes involving this port
                this.removeRoutesForPort(portName);

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

            // Decode value feedback from any synth (not gated on exchange relay)
            if (this._onValueFeedback) {
                this._decodeValueFeedback(data, portName);
            }

            // Exchange relay: forward SysEx between synth and controller
            if (this._exchangeRelayActive) {
                if (portName === this._exchangeSynthPort && this._exchangeControllerPort) {
                    // Synth → Controller
                    this._log(`RELAY: Synth → Controller (${data.length} bytes)`, 'midi');
                    this.send(this._exchangeControllerPort, data);
                    this._relaySniffer.receive(data);
                } else if (portName === this._exchangeControllerPort && this._exchangeSynthPort) {
                    // Controller → Synth
                    this._log(`RELAY: Controller → Synth (${data.length} bytes)`, 'midi');
                    this.send(this._exchangeSynthPort, data);
                    this._relaySniffer.receive(data);
                }
            }
            return;
        }

        // Fire all-input callback for MIDI monitor (all non-SysEx from any device)
        this._onAllMidiInput?.(portName, data);

        // Non-SysEx: forward to all route destinations
        const destinations = this.getRoutesFrom(portName);
        if (destinations.length > 0) {
            for (const dest of destinations) {
                this.send(dest, data);
            }
            this._onMidiThrough?.(data, portName);

            if (this._midiLoggingEnabled) {
                this._log(`ROUTE: [${this._formatMidi(data)}] → ${destinations.join(', ')}`, 'midi');
            }
        }
    }

    //==================================================================
    // INTERNAL: Relay Sniffer Handler
    //==================================================================

    _handleSniffedJson(json) {
        if (json.cmd === 'set-patch' && Array.isArray(json.controls)) {
            this._log(`Sniffer: intercepted set-patch "${json.name}" (${json.controls.length} controls)`);
            this._onControlSurface?.(json.controls);
        }
        // Capture controller's control-surface response (dial count, keyboard info)
        if (json.op === 'control-surface' && json.controls) {
            this._controlSurfaceInfo = json;
            this._log(`Sniffer: intercepted control-surface (${JSON.stringify(json.controls)})`);
            this._onControlSurfaceInfo?.(json);
        }
    }

    //==================================================================
    // INTERNAL: Value Feedback Decoder
    //==================================================================

    /**
     * Decode 0x7D value feedback SysEx and fire callback
     * Format: F0 7D 00 10 UID text... 00 F7 (value)
     *         F0 7D 00 11 UID env seg A D S R text... 00 F7 (ADSR)
     * UID = param_idx (0-based index in patch parameters[])
     * @private
     */
    _decodeValueFeedback(data, portName) {
        // Minimum: F0 7D 00 10 UID 00 F7 = 7 bytes
        if (data.length < 7) return;
        if (data[1] !== 0x7D || data[2] !== 0x00) return;

        const msgType = data[3];

        if (msgType === 0x10) {
            // Value feedback: [F0][7D][00][10][UID][text...][00][F7]
            const uid = data[4];
            // Extract null-terminated text (bytes 5 to second-to-last before F7)
            const textBytes = data.slice(5, data.length - 1); // strip F7
            const nullIdx = textBytes.indexOf(0x00);
            const text = new TextDecoder().decode(textBytes.slice(0, nullIdx >= 0 ? nullIdx : textBytes.length));
            this._onValueFeedback({ uid, displayText: text, portName });

        } else if (msgType === 0x11) {
            // ADSR feedback: [F0][7D][00][11][UID][env][seg][A][D][S][R][text...][00][F7]
            if (data.length < 13) return;
            const uid = data[4];
            const env = data[5];   // 0=MOD_ENV, 1=VAMP_ENV
            const segment = data[6]; // 0=A, 1=D, 2=S, 3=R
            const adsr = [data[7], data[8], data[9], data[10]]; // 0-127 each
            const textBytes = data.slice(11, data.length - 1);
            const nullIdx = textBytes.indexOf(0x00);
            const text = new TextDecoder().decode(textBytes.slice(0, nullIdx >= 0 ? nullIdx : textBytes.length));
            this._onValueFeedback({
                uid,
                displayText: text,
                adsr: { env, segment, values: adsr },
                portName
            });
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
