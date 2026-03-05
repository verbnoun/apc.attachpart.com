/**
 * VirtualDevice - Base class for software MIDI devices
 *
 * Bridges between raw MIDI/SysEx on the port and JSON command handling.
 * Subclasses implement handleCommand(json) and work at JSON level,
 * same pattern as MockBartleby/MockCandide.
 *
 * Uses MidiPortManager virtual ports so the entire stack above
 * (DeviceRegistry, UnifiedDeviceAPI, app.js) works unchanged.
 */

class VirtualDevice {
    /**
     * @param {MidiPortManager} portManager - The port manager instance
     * @param {string} portName - Must match a KNOWN_PORTS entry
     */
    constructor(portManager, portName) {
        this._portManager = portManager;
        this._portName = portName;
        this._started = false;
        this._connected = false;
        this._muid = Math.floor(Math.random() * 0x0FFFFFFF) + 1;

        // MIDI log for app windows
        this._midiLog = [];         // { dir: 'in'|'out', desc: string, timestamp: number }
        this._logSubscribers = new Set();
    }

    /**
     * Register virtual port and start receiving
     */
    start() {
        if (this._started) return;
        this._portManager.addVirtualPort(this._portName, (data) => {
            this._handleRawMidi(data);
        });
        this._started = true;
        console.log(`[${this._portName}] Started`);
    }

    /**
     * Unregister virtual port
     */
    stop() {
        if (!this._started) return;
        this._portManager.removeVirtualPort(this._portName);
        this._started = false;
        console.log(`[${this._portName}] Stopped`);
    }

    /**
     * Handle raw MIDI data from APC (via portManager.send → onReceive)
     * Decodes SysEx → JSON and routes to handleCommand().
     * Non-SysEx routed to handleMidi().
     * @private
     */
    _handleRawMidi(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

        // Non-SysEx — pass to subclass for MIDI handling (notes, CC, etc.)
        if (bytes[0] !== 0xF0) {
            this._logMidi('in', this._describeMidi(bytes));
            this.handleMidi(bytes);
            return;
        }

        // Check for DM protocol (0x20) before falling through to mcoded7
        if (bytes.length > 4 && bytes[1] === 0x7D && bytes[2] === 0x00 && bytes[3] === 0x20) {
            const jsonBytes = bytes.slice(4, -1);  // after [F0][7D][00][20], before [F7]
            try {
                const json = JSON.parse(new TextDecoder().decode(jsonBytes));
                if (json.cmd) {
                    this._logMidi('in', `cmd: ${json.cmd}`);
                    console.log(`[${this._portName}] RX: ${json.cmd}`);
                    this.handleCommand(json);
                } else {
                    this.handleExchangeResponse(json);
                }
            } catch (e) { /* ignore parse errors */ }
            return;
        }

        // Legacy mcoded7 SysEx — decode to JSON
        const json = decodeSysExToJson(bytes);
        if (!json) return;

        // Responses (no cmd field) — dispatch to subclass exchange handler
        // During exchange relay, some responses (like control-surface) need
        // to reach the device. Subclass overrides handleExchangeResponse().
        if (!json.cmd) {
            this.handleExchangeResponse(json);
            return;
        }

        this._logMidi('in', `cmd: ${json.cmd}`);
        console.log(`[${this._portName}] RX: ${json.cmd}`);

        this.handleCommand(json);
    }

    /**
     * Send a JSON response back to APC (encodes as SysEx)
     * @param {Object} json - Response object
     */
    _sendResponse(json) {
        const sysex = encodeDmJsonToSysEx(json);
        const desc = json.cmd || json.status || json.op || 'response';
        this._logMidi('out', `resp: ${desc}`);
        console.log(`[${this._portName}] TX: ${desc}`);
        this._portManager.injectMessage(this._portName, sysex);
    }

    /**
     * Send raw MIDI data back to APC (non-SysEx)
     * @param {Uint8Array} data
     */
    _sendMidi(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        this._logMidi('out', this._describeMidi(bytes));
        this._portManager.injectMessage(this._portName, data);
    }

    /**
     * Handle a JSON command from APC — subclass must override
     * @param {Object} json - Decoded command
     */
    handleCommand(json) {
        console.warn(`[${this._portName}] Unhandled command: ${json.cmd}`);
    }

    /**
     * Handle non-SysEx MIDI from APC — subclass may override
     * @param {Uint8Array} data - Raw MIDI bytes
     */
    handleMidi(data) {
        // Default: ignore
    }

    /**
     * Handle a JSON response during exchange relay — subclass may override.
     * Called for SysEx messages without a cmd field (responses/ACKs).
     * @param {Object} json - Decoded response
     */
    handleExchangeResponse(json) {
        // Default: ignore (responses are for the API layer, not the device)
    }

    //------------------------------------------------------------------
    // DM PROTOCOL HELPERS
    //------------------------------------------------------------------

    /**
     * Send a DM notification (0x20 JSON with notification key)
     * @param {string} notification - Notification type
     * @param {Object} extra - Additional fields
     */
    _sendDmNotification(notification, extra = {}) {
        this._sendResponse({ notification, ...extra });
    }

    /**
     * Send 0x21 binary feedback message
     * @param {number} uid - Parameter UID (7-bit)
     * @param {number} value - 14-bit value
     * @param {string} display - Display text
     * @param {Object} options - { priority, cc, rangeMin, rangeMax }
     */
    _sendDmFeedback(uid, value, display, options = {}) {
        const { priority = 0, cc = 0x7F, rangeMin = 0, rangeMax = 16383 } = options;
        const bytes = new Uint8Array(AP_DM_FEEDBACK_HEADER_SIZE + display.length + 3);
        let i = 0;
        bytes[i++] = 0xF0;
        bytes[i++] = 0x7D;
        bytes[i++] = 0x00;
        bytes[i++] = 0x21;
        bytes[i++] = uid & 0x7F;
        const [vMsb, vLsb] = from14bit(value);
        bytes[i++] = vMsb;
        bytes[i++] = vLsb;
        bytes[i++] = priority & 0x7F;
        bytes[i++] = cc & 0x7F;
        const [rMinMsb, rMinLsb] = from14bit(rangeMin);
        bytes[i++] = rMinMsb;
        bytes[i++] = rMinLsb;
        const [rMaxMsb, rMaxLsb] = from14bit(rangeMax);
        bytes[i++] = rMaxMsb;
        bytes[i++] = rMaxLsb;
        for (let c = 0; c < display.length; c++) bytes[i++] = display.charCodeAt(c) & 0x7F;
        bytes[i++] = 0x00;
        bytes[i++] = 0xF7;
        this._logMidi('out', `0x21 feedback uid=${uid} val=${value} "${display}"`);
        this._portManager.injectMessage(this._portName, bytes.slice(0, i));
    }

    //------------------------------------------------------------------
    // MIDI LOG
    //------------------------------------------------------------------

    _logMidi(dir, desc) {
        const entry = { dir, desc, timestamp: Date.now() };
        this._midiLog.push(entry);
        if (this._midiLog.length > 200) this._midiLog.shift();
        for (const cb of this._logSubscribers) cb(entry);
    }

    subscribeMidiLog(callback) {
        this._logSubscribers.add(callback);
        return () => this._logSubscribers.delete(callback);
    }

    getMidiLog() {
        return this._midiLog;
    }

    _describeMidi(bytes) {
        if (bytes.length === 0) return 'empty';
        const status = bytes[0] & 0xF0;
        const ch = bytes[0] & 0x0F;
        switch (status) {
            case 0x90: return bytes[2] > 0
                ? `NoteOn ${bytes[1]} vel=${bytes[2]} ch${ch}`
                : `NoteOff ${bytes[1]} ch${ch}`;
            case 0x80: return `NoteOff ${bytes[1]} ch${ch}`;
            case 0xB0: return `CC${bytes[1]}=${bytes[2]} ch${ch}`;
            case 0xE0: {
                const bend = ((bytes[2] << 7) | bytes[1]) - 8192;
                return `Bend ${bend} ch${ch}`;
            }
            case 0xD0: return `Pressure ${bytes[1]} ch${ch}`;
            case 0xC0: return `PgmChange ${bytes[1]} ch${ch}`;
            case 0xF0: return `SysEx (${bytes.length} bytes)`;
            default: return `0x${bytes[0].toString(16)} (${bytes.length} bytes)`;
        }
    }
}

window.VirtualDevice = VirtualDevice;
