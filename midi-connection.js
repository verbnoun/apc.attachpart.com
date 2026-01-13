/**
 * MIDI Connection Layer for Candide Web Editor v2.0
 * Web MIDI API initialization and Candide device detection
 */

//======================================================================
// CONFIGURATION
//======================================================================

// Device detection search terms - update when device name changes
// Order matters: first match wins (most specific first)
const DEVICE_SEARCH_TERMS = ['candide', 'daisy', 'seed'];

//======================================================================
// WEB MIDI API INITIALIZATION
//======================================================================

/**
 * Request Web MIDI access with SysEx permission
 *
 * @returns {Promise<MIDIAccess>} - MIDI access object
 * @throws {Error} - If Web MIDI not supported or permission denied
 */
async function requestMidiAccess() {
    if (!navigator.requestMIDIAccess) {
        throw new Error('Web MIDI API not supported in this browser');
    }

    try {
        return await navigator.requestMIDIAccess({ sysex: true });
    } catch (error) {
        throw new Error('MIDI access denied. SysEx permission required.');
    }
}

//======================================================================
// CANDIDE DEVICE DETECTION
//======================================================================

/**
 * Detect Candide device from MIDI ports
 *
 * Strategy:
 * 1. Look for device with manufacturer ID 0x7D in SysEx messages
 * 2. Fall back to name matching if manufacturer ID not available
 *
 * @param {MIDIAccess} midiAccess - MIDI access object
 * @returns {Object|null} - { input, output, diagnostics } ports or null if not found
 */
function detectCandideDevice(midiAccess) {
    const inputs = Array.from(midiAccess.inputs.values());
    const outputs = Array.from(midiAccess.outputs.values());

    const diagnostics = {
        availableInputs: inputs.map(i => ({
            name: i.name,
            id: i.id,
            manufacturer: i.manufacturer,
            state: i.state
        })),
        availableOutputs: outputs.map(o => ({
            name: o.name,
            id: o.id,
            manufacturer: o.manufacturer,
            state: o.state
        })),
        searchTerms: DEVICE_SEARCH_TERMS,
        matchedTerm: null
    };

    // Strategy 1: Look for "Candide" in port name (most reliable)
    for (const input of inputs) {
        if (input.name && input.name.toLowerCase().includes('candide')) {
            // Find matching output port
            const output = outputs.find(o => o.name === input.name);
            if (output) {
                diagnostics.matchedTerm = 'candide';
                diagnostics.matchedInput = input.name;
                diagnostics.matchedOutput = output.name;
                return { input, output, diagnostics };
            }
        }
    }

    // Strategy 2: Look for "Daisy" as fallback (less specific)
    for (const input of inputs) {
        if (input.name && input.name.toLowerCase().includes('daisy')) {
            const output = outputs.find(o => o.name === input.name);
            if (output) {
                diagnostics.matchedTerm = 'daisy';
                diagnostics.matchedInput = input.name;
                diagnostics.matchedOutput = output.name;
                return { input, output, diagnostics };
            }
        }
    }

    // Strategy 3: Look for "Seed" as fallback
    for (const input of inputs) {
        if (input.name && input.name.toLowerCase().includes('seed')) {
            const output = outputs.find(o => o.name === input.name);
            if (output) {
                diagnostics.matchedTerm = 'seed';
                diagnostics.matchedInput = input.name;
                diagnostics.matchedOutput = output.name;
                return { input, output, diagnostics };
            }
        }
    }

    // No Candide device found
    return { diagnostics };
}

/**
 * Connect to Candide device (if available)
 *
 * @returns {Promise<Object>} - { input, output, midiAccess } or { midiAccess, diagnostics } if not found
 */
async function connectToCandide() {
    const midiAccess = await requestMidiAccess();
    const result = detectCandideDevice(midiAccess);

    if (!result.input || !result.output) {
        console.log('MIDI Detection Diagnostics:', result.diagnostics);
        return { midiAccess, diagnostics: result.diagnostics };
    }

    console.log(`Connected to Candide: "${result.diagnostics.matchedInput}" (matched term: "${result.diagnostics.matchedTerm}")`);

    return {
        input: result.input,
        output: result.output,
        midiAccess
    };
}

/**
 * Start monitoring for device connect/disconnect events
 *
 * @param {MIDIAccess} midiAccess - MIDI access object
 * @param {Object} callbacks - { onDeviceFound, onDeviceDisconnected }
 * @param {Function} callbacks.onDeviceFound - Called with { input, output, diagnostics } when device appears
 * @param {Function} callbacks.onDeviceDisconnected - Called with { portName } when device disappears
 * @param {string|null} connectedPortName - Name of currently connected port (to detect its disconnection)
 */
function startDeviceMonitoring(midiAccess, callbacks, connectedPortName = null) {
    midiAccess.onstatechange = (event) => {
        const port = event.port;
        console.log(`MIDI port state change: ${port.name} (${port.type}) -> ${port.state}`);

        if (port.state === 'connected') {
            // A port was connected - check if it's a Candide device
            const result = detectCandideDevice(midiAccess);
            if (result.input && result.output) {
                callbacks.onDeviceFound?.(result);
            }
        } else if (port.state === 'disconnected') {
            // A port was disconnected - check if it's our connected device
            if (connectedPortName && port.name === connectedPortName) {
                callbacks.onDeviceDisconnected?.({ portName: port.name });
            }
        }
    };
}

/**
 * Stop monitoring for device events
 *
 * @param {MIDIAccess} midiAccess - MIDI access object
 */
function stopDeviceMonitoring(midiAccess) {
    if (midiAccess) {
        midiAccess.onstatechange = null;
    }
}

//======================================================================
// MIDI 2.0 UMP HELPERS
//======================================================================

/**
 * Build MIDI 2.0 UMP Note On message (Type 4)
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} note - Note number (0-127)
 * @param {number} velocity - Velocity (0.0-1.0 normalized)
 * @returns {Uint8Array} - 8-byte UMP message
 */
function buildMidi2NoteOn(channel, note, velocity) {
    const vel16 = Math.round(velocity * 0xFFFF);

    return new Uint8Array([
        0x40 | (channel & 0x0F),  // Message Type 4 (MIDI 2.0 Channel Voice) + channel
        0x90,                      // Note On status
        note & 0x7F,               // Note number
        0x00,                      // Attribute type (none)
        (vel16 >> 8) & 0xFF,       // Velocity MSB
        vel16 & 0xFF,              // Velocity LSB
        0x00,                      // Attribute data MSB
        0x00                       // Attribute data LSB
    ]);
}

/**
 * Build MIDI 2.0 UMP Note Off message (Type 4)
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} note - Note number (0-127)
 * @param {number} velocity - Velocity (0.0-1.0 normalized)
 * @returns {Uint8Array} - 8-byte UMP message
 */
function buildMidi2NoteOff(channel, note, velocity) {
    const vel16 = Math.round(velocity * 0xFFFF);

    return new Uint8Array([
        0x40 | (channel & 0x0F),  // Message Type 4 + channel
        0x80,                      // Note Off status
        note & 0x7F,               // Note number
        0x00,                      // Attribute type (none)
        (vel16 >> 8) & 0xFF,       // Velocity MSB
        vel16 & 0xFF,              // Velocity LSB
        0x00,                      // Attribute data MSB
        0x00                       // Attribute data LSB
    ]);
}

//======================================================================
// MIDI 1.0 HELPERS (for Web MIDI API compatibility)
//======================================================================

/**
 * Build MIDI 1.0 Note On message
 * Web MIDI API only supports MIDI 1.0, not MIDI 2.0 UMP packets
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} note - MIDI note number (0-127)
 * @param {number} velocity - Velocity (0.0-1.0, converted to 0-127)
 * @returns {Uint8Array} - 3-byte MIDI 1.0 message
 */
function buildMidi1NoteOn(channel, note, velocity) {
    const vel7 = Math.round(velocity * 127);

    return new Uint8Array([
        0x90 | (channel & 0x0F),  // Note On status + channel
        note & 0x7F,               // Note number
        vel7 & 0x7F                // Velocity (7-bit)
    ]);
}

/**
 * Build MIDI 1.0 Note Off message
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} note - MIDI note number (0-127)
 * @param {number} velocity - Release velocity (0.0-1.0, converted to 0-127)
 * @returns {Uint8Array} - 3-byte MIDI 1.0 message
 */
function buildMidi1NoteOff(channel, note, velocity) {
    const vel7 = Math.round(velocity * 127);

    return new Uint8Array([
        0x80 | (channel & 0x0F),  // Note Off status + channel
        note & 0x7F,               // Note number
        vel7 & 0x7F                // Release velocity (7-bit)
    ]);
}

/**
 * Build MIDI 1.0 Channel Pressure message
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} pressure - Pressure (0.0-1.0, converted to 0-127)
 * @returns {Uint8Array} - 2-byte MIDI 1.0 message
 */
function buildMidi1ChannelPressure(channel, pressure) {
    const pres7 = Math.round(pressure * 127);

    return new Uint8Array([
        0xD0 | (channel & 0x0F),   // Channel Pressure status + channel
        pres7 & 0x7F               // Pressure (7-bit)
    ]);
}

/**
 * Build MIDI 1.0 Pitch Bend message
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} bend - Bend value (-1.0 to +1.0)
 * @returns {Uint8Array} - 3-byte MIDI 1.0 message
 */
function buildMidi1PitchBend(channel, bend) {
    // Convert -1..+1 to 0..16383 (center = 8192)
    const bend14 = Math.round((bend + 1) * 8191.5);
    const clamped = Math.max(0, Math.min(16383, bend14));
    const lsb = clamped & 0x7F;
    const msb = (clamped >> 7) & 0x7F;

    return new Uint8Array([
        0xE0 | (channel & 0x0F),   // Pitch Bend status + channel
        lsb,                        // LSB (7-bit)
        msb                         // MSB (7-bit)
    ]);
}

//======================================================================
// MPE (MIDI Polyphonic Expression) SUPPORT
//======================================================================

/**
 * MPE Channel Allocator
 * Assigns each note its own MIDI channel for independent expression.
 *
 * MPE uses:
 * - Master channel (ch 0) for global messages
 * - Member channels (ch 1-15) for per-note expression
 */
class MpeChannelAllocator {
    constructor(masterChannel = 0, numMembers = 15) {
        this.masterChannel = masterChannel;
        this.firstMember = masterChannel + 1;
        this.numMembers = numMembers;
        this.noteToChannel = new Map();  // note -> channel
        this.channelPool = [];           // available channels
        this.reset();
    }

    /**
     * Reset allocator - release all channels back to pool
     */
    reset() {
        this.noteToChannel.clear();
        this.channelPool = [];
        for (let i = 0; i < this.numMembers; i++) {
            this.channelPool.push(this.firstMember + i);
        }
    }

    /**
     * Allocate a channel for a note
     * @param {number} note - MIDI note number
     * @returns {number} - Allocated channel (1-15)
     */
    allocate(note) {
        // If note already has a channel, return it
        if (this.noteToChannel.has(note)) {
            return this.noteToChannel.get(note);
        }

        // If pool is empty, steal oldest channel
        if (this.channelPool.length === 0) {
            const oldest = this.noteToChannel.keys().next().value;
            this.release(oldest);
        }

        const channel = this.channelPool.shift();
        this.noteToChannel.set(note, channel);
        return channel;
    }

    /**
     * Release a channel back to the pool
     * @param {number} note - MIDI note number
     * @returns {number|undefined} - Released channel, or undefined if not found
     */
    release(note) {
        const channel = this.noteToChannel.get(note);
        if (channel !== undefined) {
            this.noteToChannel.delete(note);
            this.channelPool.push(channel);
        }
        return channel;
    }

    /**
     * Get the channel for an active note
     * @param {number} note - MIDI note number
     * @returns {number|undefined} - Channel, or undefined if not allocated
     */
    getChannel(note) {
        return this.noteToChannel.get(note);
    }

    /**
     * Get the master channel
     * @returns {number} - Master channel (0)
     */
    getMasterChannel() {
        return this.masterChannel;
    }
}
