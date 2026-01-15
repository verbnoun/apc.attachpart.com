/**
 * Virtual Controller - Protocol Exerciser
 *
 * Acts as a controller in the patch exchange protocol:
 * 1. Responds to get-control-surface with virtual HID
 * 2. Handles set-patch to configure virtual controls
 *
 * Exposes a single slider that can be controlled and sends MIDI CC.
 */

class VirtualController {
    constructor(onPatchReceived) {
        // Callback when patch is received
        this.onPatchReceived = onPatchReceived;

        // Current patch data (from synth)
        this.currentPatch = null;

        // Slider state (first control from patch)
        this.sliderCC = null;
        this.sliderLabel = "Slider";
        this.sliderInput = null;
        this.sliderValue = 0;

        // Virtual HID description
        this.controlSurface = {
            status: "ok",
            op: "control-surface",
            device: "APC Pad",
            controls: { "1d.abs.linear": 1 },
            labeled: false
        };

        // Connected synth API (for sending CC)
        this._synthAPI = null;
        this._logFn = null;
    }

    //======================================================================
    // Configuration
    //======================================================================

    /**
     * Set logging function
     * @param {Function} fn - (message, type) => void
     */
    setLogFn(fn) {
        this._logFn = fn;
    }

    /**
     * Set synth API for sending MIDI
     * @param {UnifiedDeviceAPI} api
     */
    setSynthAPI(api) {
        this._synthAPI = api;
    }

    //======================================================================
    // Protocol Handlers (Controller Role)
    //======================================================================

    /**
     * Handle get-control-surface request
     * Returns virtual HID description
     * @returns {Object} control-surface response
     */
    getControlSurface() {
        this._log('Responding to get-control-surface');
        return this.controlSurface;
    }

    /**
     * Handle set-patch command from synth
     * @param {Object} patchData - { name, controls: [{input, label, cc}...] }
     */
    handleSetPatch(patchData) {
        this._log(`Received set-patch: "${patchData.name}" with ${patchData.controls?.length || 0} controls`);

        this.currentPatch = patchData;

        // Extract first control for slider
        if (patchData.controls && patchData.controls.length > 0) {
            const firstControl = patchData.controls[0];
            this.sliderCC = firstControl.cc;
            this.sliderLabel = firstControl.label || "Control";
            this.sliderInput = firstControl.input;

            this._log(`Slider configured: "${this.sliderLabel}" → CC${this.sliderCC}`);
        } else {
            this.sliderCC = null;
            this.sliderLabel = "Slider";
            this.sliderInput = null;
            this._log('No controls in patch - slider disabled');
        }

        // Notify UI
        if (this.onPatchReceived) {
            this.onPatchReceived(patchData);
        }

        // Return acknowledgment
        return { status: "ok", op: "set-patch" };
    }

    //======================================================================
    // Slider Control
    //======================================================================

    /**
     * Update slider value and send MIDI CC
     * @param {number} value - 0-127
     */
    setSliderValue(value) {
        this.sliderValue = Math.max(0, Math.min(127, value));

        if (this.sliderCC !== null && this._synthAPI) {
            // Send CC to synth (normalized 0-1)
            this._synthAPI.sendCC(0, this.sliderCC, this.sliderValue / 127);
            this._log(`Slider: ${this.sliderValue} → CC${this.sliderCC}`);
        }
    }

    /**
     * Get current slider state for UI
     * @returns {Object} { value, label, cc, input, enabled }
     */
    getSliderState() {
        return {
            value: this.sliderValue,
            label: this.sliderLabel,
            cc: this.sliderCC,
            input: this.sliderInput,
            enabled: this.sliderCC !== null
        };
    }

    //======================================================================
    // State
    //======================================================================

    /**
     * Check if controller has received a patch
     * @returns {boolean}
     */
    hasPatch() {
        return this.currentPatch !== null;
    }

    /**
     * Get current patch name
     * @returns {string|null}
     */
    getPatchName() {
        return this.currentPatch?.name || null;
    }

    /**
     * Reset controller state
     */
    reset() {
        this.currentPatch = null;
        this.sliderCC = null;
        this.sliderLabel = "Slider";
        this.sliderInput = null;
        this.sliderValue = 0;
        this._synthAPI = null;
        this._log('Controller reset');
    }

    //======================================================================
    // Internal
    //======================================================================

    _log(msg, type = 'info') {
        if (this._logFn) {
            this._logFn(`[VirtualController] ${msg}`, type);
        } else {
            console.log(`[VirtualController] ${msg}`);
        }
    }
}

// Export for use in app
window.VirtualController = VirtualController;
