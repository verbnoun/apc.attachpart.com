/**
 * MidiState - Centralized MIDI state store with pub/sub
 *
 * Parses incoming MIDI bytes into structured events and notifies subscribers.
 * Single subscriber to DeviceRegistry.onMidiThrough, multiple subscribers here.
 *
 * Events: 'noteOn', 'noteOff', 'bend', 'pressure', 'reset'
 * Velocity normalized to 0.0-1.0 (from 7-bit MIDI 1.0)
 */

class MidiState {
    constructor() {
        this._subscribers = new Set();
        this._activeNotes = new Map(); // channel → { note, velocity, bend, pressure }
        this._latestVelocity = null;   // Last seen velocity (0.0-1.0)
    }

    /**
     * Subscribe to MIDI state events
     * @param {Function} callback - Called with (eventType, data)
     * @returns {Function} Unsubscribe function
     */
    subscribe(callback) {
        this._subscribers.add(callback);
        return () => this._subscribers.delete(callback);
    }

    /**
     * Handle raw MIDI bytes from DeviceRegistry.onMidiThrough
     * Parses into structured events and notifies all subscribers
     * @param {Uint8Array} data - Raw MIDI bytes
     */
    handleMidiThrough(data) {
        const status = data[0] & 0xF0;
        const channel = data[0] & 0x0F;

        if (status === 0x90 && data[2] > 0) {
            // Note On
            const velocity = data[2] / 127;
            this._latestVelocity = velocity;
            this._activeNotes.set(channel, {
                note: data[1],
                velocity,
                bend: 0,
                pressure: 0.5
            });
            this._notify('noteOn', { channel, note: data[1], velocity });

        } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
            // Note Off
            this._activeNotes.delete(channel);
            this._notify('noteOff', { channel, note: data[1] });

        } else if (status === 0xE0) {
            // Pitch Bend
            const raw = data[1] | (data[2] << 7);
            const bend = (raw - 8192) / 8192;
            const existing = this._activeNotes.get(channel);
            if (existing) {
                this._activeNotes.set(channel, { ...existing, bend });
            }
            this._notify('bend', { channel, bend });

        } else if (status === 0xD0) {
            // Channel Pressure
            const pressure = data[1] / 127;
            const existing = this._activeNotes.get(channel);
            if (existing) {
                this._activeNotes.set(channel, { ...existing, pressure });
            }
            this._notify('pressure', { channel, pressure });
        }
    }

    /**
     * Handle raw MIDI bytes from any connected device (all-input monitor)
     * Similar to handleMidiThrough but tags events with source portName
     * @param {string} portName - Source device port name
     * @param {Uint8Array} data - Raw MIDI bytes
     */
    handleAllMidiInput(portName, data) {
        const status = data[0] & 0xF0;
        const channel = data[0] & 0x0F;

        if (status === 0x90 && data[2] > 0) {
            this._notify('allNoteOn', { source: portName, channel, note: data[1], velocity: data[2] / 127 });
        } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
            this._notify('allNoteOff', { source: portName, channel, note: data[1] });
        } else if (status === 0xE0) {
            const raw = data[1] | (data[2] << 7);
            const bend = (raw - 8192) / 8192;
            this._notify('allBend', { source: portName, channel, bend });
        } else if (status === 0xD0) {
            this._notify('allPressure', { source: portName, channel, pressure: data[1] / 127 });
        } else if (status === 0xB0) {
            this._notify('allCC', { source: portName, channel, cc: data[1], value: data[2] });
        }
    }

    /**
     * Get the most recent velocity value (0.0-1.0)
     * @returns {number|null}
     */
    getLatestVelocity() {
        return this._latestVelocity;
    }

    /**
     * Get active notes map
     * @returns {Map}
     */
    getActiveNotes() {
        return this._activeNotes;
    }

    /**
     * Reset all state
     */
    reset() {
        this._activeNotes.clear();
        this._latestVelocity = null;
        this._notify('reset', {});
    }

    /** @private */
    _notify(eventType, data) {
        for (const cb of this._subscribers) {
            try {
                cb(eventType, data);
            } catch (e) {
                console.error('[MidiState] Subscriber error:', e);
            }
        }
    }
}

//======================================================================
// BEZIER EVALUATION UTILITY
//======================================================================

/**
 * Evaluate Y position on a quadratic bezier curve given an input X.
 *
 * The curve goes from (0,0) through control point (cx,cy) to (1,1).
 * Quadratic bezier parametric form:
 *   x(t) = 2(1-t)*t*cx + t²
 *   y(t) = 2(1-t)*t*cy + t²
 *
 * We solve x(t) = inputX for t, then compute y(t).
 *
 * @param {number} inputX - Input value (0.0-1.0)
 * @param {number} cx - Control point X (0.0-1.0)
 * @param {number} cy - Control point Y (0.0-1.0)
 * @returns {number} Output Y value (0.0-1.0)
 */
function evaluateQuadraticBezierY(inputX, cx, cy) {
    // x(t) = 2(1-t)*t*cx + t² = 2*t*cx - 2*t²*cx + t²
    // x(t) = t² * (1 - 2*cx) + t * (2*cx)
    // Rearranged: (1 - 2*cx)*t² + (2*cx)*t - inputX = 0
    const a = 1 - 2 * cx;
    const b = 2 * cx;
    const c = -inputX;

    let t;
    if (Math.abs(a) < 1e-6) {
        // Linear case: b*t = inputX
        t = b !== 0 ? inputX / b : inputX;
    } else {
        // Quadratic formula
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) return inputX; // Fallback to linear
        const sqrtD = Math.sqrt(discriminant);
        const t1 = (-b + sqrtD) / (2 * a);
        const t2 = (-b - sqrtD) / (2 * a);
        // Pick the root in [0, 1]
        if (t1 >= 0 && t1 <= 1) {
            t = t1;
        } else if (t2 >= 0 && t2 <= 1) {
            t = t2;
        } else {
            // Fallback: pick closest
            t = (Math.abs(t1 - 0.5) < Math.abs(t2 - 0.5)) ? t1 : t2;
            t = Math.max(0, Math.min(1, t));
        }
    }

    // y(t) = 2(1-t)*t*cy + t²
    const y = 2 * (1 - t) * t * cy + t * t;
    return Math.max(0, Math.min(1, y));
}

window.MidiState = MidiState;
window.evaluateQuadraticBezierY = evaluateQuadraticBezierY;
