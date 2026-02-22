/**
 * MidiPortManager - Stable abstraction over Web MIDI
 *
 * Web MIDI port objects are unstable during USB enumeration. Multiple
 * statechange events fire, and port object references can change.
 *
 * This class absorbs that instability:
 * - Never stores port objects (always fetches fresh from midiAccess)
 * - Re-attaches handlers on EVERY statechange (not just after debounce)
 * - Tracks ports by NAME only
 * - Provides stable send/receive interface
 * - Fires debounced onPortsChanged when enumeration settles
 */

class MidiPortManager {
    constructor() {
        this._midiAccess = null;

        // Message callbacks by port name
        this._messageCallbacks = {};  // { portName: callback }

        // Virtual ports (software devices, no hardware)
        this._virtualPorts = new Map();  // name → { onReceive: fn }

        // Debounce for onPortsChanged
        this._debounceTimer = null;
        this._debounceMs = 300;

        // Last known port sets (for change detection)
        this._lastInputNames = new Set();
        this._lastOutputNames = new Set();

        // Callbacks
        this._onPortsChanged = null;

        // Logging
        this._logFn = null;
    }

    //==================================================================
    // PUBLIC: Lifecycle
    //==================================================================

    /**
     * Initialize MIDI access and start monitoring
     * @param {Function} logFn - Optional logging callback (message, type)
     * @returns {Promise<void>}
     */
    async init(logFn = null) {
        this._logFn = logFn;

        if (!navigator.requestMIDIAccess) {
            this._log('Web MIDI API not supported', 'error');
            throw new Error('Web MIDI API not supported');
        }

        try {
            this._midiAccess = await navigator.requestMIDIAccess({ sysex: true });
            this._log('MIDI access granted');
        } catch (error) {
            this._log('MIDI access denied: ' + error.message, 'error');
            throw error;
        }

        // Statechange: immediately re-attach handlers, debounce callback
        this._midiAccess.onstatechange = (event) => {
            const port = event.port;
            this._log(`Port ${port.state}: ${port.name} (${port.type})`);

            // IMMEDIATELY re-attach handlers to all current inputs
            this._reattachAllHandlers();

            // Debounce the portsChanged callback
            this._resetDebounceTimer();
        };

        // Initial handler attachment
        this._reattachAllHandlers();

        // Initial portsChanged after debounce
        this._resetDebounceTimer();
    }

    //==================================================================
    // PUBLIC: Queries
    //==================================================================

    /**
     * Get all current input port names (hardware + virtual)
     * @returns {string[]}
     */
    getInputNames() {
        const hw = this._midiAccess
            ? Array.from(this._midiAccess.inputs.values()).map(p => p.name)
            : [];
        return [...hw, ...this._virtualPorts.keys()];
    }

    /**
     * Get all current output port names (hardware + virtual)
     * @returns {string[]}
     */
    getOutputNames() {
        const hw = this._midiAccess
            ? Array.from(this._midiAccess.outputs.values()).map(p => p.name)
            : [];
        return [...hw, ...this._virtualPorts.keys()];
    }

    /**
     * Check if an input port exists
     * @param {string} name
     * @returns {boolean}
     */
    hasInput(name) {
        return this.getInputNames().includes(name);
    }

    /**
     * Check if an output port exists
     * @param {string} name
     * @returns {boolean}
     */
    hasOutput(name) {
        return this.getOutputNames().includes(name);
    }

    //==================================================================
    // PUBLIC: I/O
    //==================================================================

    /**
     * Send MIDI data to a named output port
     * Always fetches fresh port reference from midiAccess
     * @param {string} portName
     * @param {Uint8Array|Array} data
     * @returns {boolean} - true if sent, false if port not found
     */
    send(portName, data) {
        // Virtual port — deliver directly to device's onReceive handler
        const virtualPort = this._virtualPorts.get(portName);
        if (virtualPort) {
            try {
                virtualPort.onReceive(data);
                return true;
            } catch (e) {
                this._log(`Virtual send to '${portName}' failed: ${e.message}`, 'error');
                return false;
            }
        }

        if (!this._midiAccess) {
            this._log(`Send failed: MIDI not initialized`, 'error');
            return false;
        }

        const output = Array.from(this._midiAccess.outputs.values())
            .find(p => p.name === portName);

        if (!output) {
            this._log(`Send failed: output '${portName}' not found`, 'error');
            return false;
        }

        try {
            output.send(data);
            return true;
        } catch (e) {
            this._log(`Send to '${portName}' failed: ${e.message}`, 'error');
            return false;
        }
    }

    /**
     * Register a callback to receive messages from a named input port
     * @param {string} portName
     * @param {Function} callback - Called with (event) when message arrives
     */
    onMessage(portName, callback) {
        this._messageCallbacks[portName] = callback;
        this._log(`Message callback registered for '${portName}'`);
    }

    /**
     * Unregister the callback for a named input port
     * @param {string} portName
     */
    offMessage(portName) {
        delete this._messageCallbacks[portName];
        this._log(`Message callback unregistered for '${portName}'`);
    }

    //==================================================================
    // PUBLIC: Virtual Ports
    //==================================================================

    /**
     * Register a virtual port (software device, no hardware)
     * Virtual ports appear in getInputNames/getOutputNames and receive
     * data via their onReceive callback when send() targets them.
     * @param {string} name - Port name (must match KNOWN_PORTS entry)
     * @param {Function} onReceive - Called with (data) when APC sends to this port
     */
    addVirtualPort(name, onReceive) {
        this._virtualPorts.set(name, { onReceive });
        this._log(`Virtual port added: ${name}`);
        this._resetDebounceTimer();
    }

    /**
     * Unregister a virtual port
     * @param {string} name - Port name
     */
    removeVirtualPort(name) {
        this._virtualPorts.delete(name);
        this._log(`Virtual port removed: ${name}`);
        this._resetDebounceTimer();
    }

    /**
     * Inject a message FROM a virtual port into the system
     * Simulates receiving MIDI input — routes through the same
     * _handleMessage path as hardware input.
     * @param {string} name - Virtual port name (the sender)
     * @param {Uint8Array|Array} data - MIDI data
     */
    injectMessage(name, data) {
        // Wrap in a fake event object matching Web MIDI MIDIMessageEvent
        const event = { data: data instanceof Uint8Array ? data : new Uint8Array(data) };
        this._handleMessage(name, event);
    }

    //==================================================================
    // PUBLIC: Events
    //==================================================================

    /**
     * Set callback for when available ports change (debounced)
     * @param {Function} callback - Called with (inputNames[], outputNames[])
     */
    onPortsChanged(callback) {
        this._onPortsChanged = callback;
    }

    //==================================================================
    // INTERNAL: Handler Management
    //==================================================================

    /**
     * Re-attach onmidimessage handlers to ALL current input ports
     * Called on every statechange to ensure handlers are on current objects
     * @private
     */
    _reattachAllHandlers() {
        if (!this._midiAccess) return;

        const inputs = Array.from(this._midiAccess.inputs.values());

        for (const input of inputs) {
            // Capture port name for closure
            const portName = input.name;

            input.onmidimessage = (event) => {
                this._handleMessage(portName, event);
            };
        }

        this._log(`Handlers attached to ${inputs.length} inputs`);
    }

    /**
     * Route incoming message to registered callback
     * @private
     */
    _handleMessage(portName, event) {
        const callback = this._messageCallbacks[portName];
        if (callback) {
            callback(event);
        }
    }

    //==================================================================
    // INTERNAL: Debounce
    //==================================================================

    /**
     * Reset the debounce timer for portsChanged callback
     * @private
     */
    _resetDebounceTimer() {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._firePortsChangedIfNeeded(), this._debounceMs);
    }

    /**
     * Fire onPortsChanged if port availability has changed
     * @private
     */
    _firePortsChangedIfNeeded() {
        const currentInputs = new Set(this.getInputNames());
        const currentOutputs = new Set(this.getOutputNames());

        // Check if changed
        const inputsChanged = !this._setsEqual(currentInputs, this._lastInputNames);
        const outputsChanged = !this._setsEqual(currentOutputs, this._lastOutputNames);

        if (inputsChanged || outputsChanged) {
            this._lastInputNames = currentInputs;
            this._lastOutputNames = currentOutputs;

            this._log(`Ports changed: ${currentInputs.size} inputs, ${currentOutputs.size} outputs`);

            if (this._onPortsChanged) {
                this._onPortsChanged(
                    Array.from(currentInputs),
                    Array.from(currentOutputs)
                );
            }
        }
    }

    /**
     * Compare two sets for equality
     * @private
     */
    _setsEqual(a, b) {
        if (a.size !== b.size) return false;
        for (const item of a) {
            if (!b.has(item)) return false;
        }
        return true;
    }

    //==================================================================
    // INTERNAL: Logging
    //==================================================================

    _log(message, type = 'info') {
        this._logFn?.(message, type);
        console.log(`[MidiPortManager] ${message}`);
    }
}

//======================================================================
// GLOBAL
//======================================================================

window.MidiPortManager = MidiPortManager;
