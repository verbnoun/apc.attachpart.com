/**
 * Virtual Synth - Protocol Exerciser
 *
 * Acts as a synth in the patch exchange protocol:
 * 1. Sends get-control-surface to discover controller HID
 * 2. Sends set-patch with mock patch data
 *
 * Doesn't make sound - purely for testing the exchange.
 */

class VirtualSynth {
    constructor() {
        // Cached controller HID (from control-surface response)
        this.controllerHID = null;

        // Mock patch data for testing
        this.currentPatch = {
            name: "Test Patch",
            controls: [
                { input: "TEST_PARAM_1", label: "Test 1", cc: 1 },
                { input: "TEST_PARAM_2", label: "Test 2", cc: 2 },
                { input: "TEST_PARAM_3", label: "Test 3", cc: 3 },
                { input: "TEST_PARAM_4", label: "Test 4", cc: 4 }
            ]
        };

        // Exchange state
        this.exchangeInProgress = false;
        this.connectedController = null;

        // Callbacks
        this._onExchangeComplete = null;
        this._onError = null;
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
     * Set callback for exchange completion
     * @param {Function} fn - (success, controllerHID) => void
     */
    onExchangeComplete(fn) {
        this._onExchangeComplete = fn;
    }

    /**
     * Set callback for errors
     * @param {Function} fn - (error) => void
     */
    onError(fn) {
        this._onError = fn;
    }

    /**
     * Update mock patch data
     * @param {Object} patch - { name, controls: [{input, label, cc}...] }
     */
    setMockPatch(patch) {
        this.currentPatch = patch;
        this._log(`Mock patch updated: "${patch.name}" with ${patch.controls.length} controls`);
    }

    //======================================================================
    // Exchange Protocol (Synth Role)
    //======================================================================

    /**
     * Start patch exchange with a controller
     * @param {UnifiedDeviceAPI} controllerAPI - API instance for the controller
     * @returns {Promise<boolean>} - true if exchange succeeded
     */
    async startExchange(controllerAPI) {
        if (this.exchangeInProgress) {
            this._log('Exchange already in progress', 'warn');
            return false;
        }

        if (!controllerAPI) {
            this._log('No controller API provided', 'error');
            return false;
        }

        this.exchangeInProgress = true;
        this.connectedController = controllerAPI;

        try {
            // Step 1: Request control surface (HID)
            this._log('Requesting control-surface from controller...');
            const hidResponse = await controllerAPI.getControlSurface();

            if (!hidResponse || hidResponse.error) {
                throw new Error(hidResponse?.error || 'No response from controller');
            }

            this.controllerHID = hidResponse;
            this._log(`Controller HID: ${hidResponse.device}, controls: ${JSON.stringify(hidResponse.controls)}`);

            // Step 2: Send set-patch
            this._log(`Sending set-patch: "${this.currentPatch.name}"...`);
            const patchResponse = await controllerAPI.setPatch(
                this.currentPatch.name,
                this.currentPatch.controls
            );

            if (!patchResponse || patchResponse.error) {
                throw new Error(patchResponse?.error || 'No acknowledgment from controller');
            }

            this._log('Exchange complete!', 'success');
            this.exchangeInProgress = false;

            if (this._onExchangeComplete) {
                this._onExchangeComplete(true, this.controllerHID);
            }

            return true;

        } catch (error) {
            this._log(`Exchange failed: ${error.message}`, 'error');
            this.exchangeInProgress = false;

            if (this._onError) {
                this._onError(error);
            }

            return false;
        }
    }

    /**
     * Send updated patch to connected controller
     * (Used when patch changes after initial exchange)
     * @returns {Promise<boolean>}
     */
    async sendPatchUpdate() {
        if (!this.connectedController) {
            this._log('No controller connected', 'warn');
            return false;
        }

        if (!this.controllerHID) {
            this._log('No cached HID - run full exchange first', 'warn');
            return false;
        }

        try {
            this._log(`Sending patch update: "${this.currentPatch.name}"...`);
            const response = await this.connectedController.setPatch(
                this.currentPatch.name,
                this.currentPatch.controls
            );

            if (!response || response.error) {
                throw new Error(response?.error || 'No acknowledgment');
            }

            this._log('Patch update sent', 'success');
            return true;

        } catch (error) {
            this._log(`Patch update failed: ${error.message}`, 'error');
            return false;
        }
    }

    /**
     * Disconnect from controller
     */
    disconnect() {
        this.connectedController = null;
        this.controllerHID = null;
        this.exchangeInProgress = false;
        this._log('Disconnected from controller');
    }

    //======================================================================
    // Internal
    //======================================================================

    _log(msg, type = 'info') {
        if (this._logFn) {
            this._logFn(`[VirtualSynth] ${msg}`, type);
        } else {
            console.log(`[VirtualSynth] ${msg}`);
        }
    }
}

// Export for use in app
window.VirtualSynth = VirtualSynth;
