/**
 * Mock Device Simulators for AP Console Testing
 *
 * Provides fake Bartleby and fake Candide to test relay without hardware:
 * - MockBartleby: Test Candide + AP Console without real Bartleby
 * - MockCandide: Test Bartleby + AP Console without real Candide
 *
 * Usage (from browser console):
 *   deviceRegistry.enableMockBartleby()
 *   deviceRegistry.enableMockCandide()
 *   deviceRegistry.disableMocks()
 */

//======================================================================
// MOCK BARTLEBY
//======================================================================

/**
 * Mock Bartleby simulator for testing Candide without hardware
 *
 * Responds to exchange protocol:
 * - get-control-surface -> control-surface (capabilities)
 * - assign -> thanks (confirmation)
 */
class MockBartleby {
    constructor(onSend) {
        this._onSend = onSend;  // Callback to "send" response back
        this._capabilities = {
            cmd: 'control-surface',
            mfg: 'AttachPart',
            device: 'MockBartleby',
            version: '1.0',
            controls: { '1d.abs.rotary': 16 },
            labeled: true,
            keyboard: { keys: 24, startNote: 36, perNote: ['pnp', 'pPress'] }
        };
    }

    /**
     * Handle incoming JSON command (from Candide via relay)
     * @param {Object} json - Parsed JSON command
     */
    handleCommand(json) {
        console.log('[MockBartleby] Received:', json.cmd);

        if (json.cmd === 'get-control-surface') {
            // Respond with capabilities
            setTimeout(() => {
                console.log('[MockBartleby] Sending: control-surface');
                this._onSend(this._capabilities);
            }, 50);  // Simulate network delay
        } else if (json.cmd === 'assign') {
            // Log assignments and send thanks
            const count = json.controls?.length || 0;
            console.log(`[MockBartleby] Got ${count} assignments`);
            setTimeout(() => {
                console.log('[MockBartleby] Sending: thanks');
                this._onSend({ cmd: 'thanks' });
            }, 50);
        } else {
            console.log('[MockBartleby] Unknown command:', json.cmd);
        }
    }
}

//======================================================================
// MOCK CANDIDE
//======================================================================

/**
 * Mock Candide simulator for testing Bartleby without hardware
 *
 * Responds to exchange protocol:
 * - controller-available -> starts exchange (get-control-surface)
 * - control-surface -> assign
 * - thanks -> complete
 */
class MockCandide {
    constructor(onSend) {
        this._onSend = onSend;  // Callback to "send" response back
        this._state = 'PLAY';
    }

    /**
     * Handle incoming JSON command (from AP Console or Bartleby via relay)
     * @param {Object} json - Parsed JSON command
     */
    handleCommand(json) {
        console.log(`[MockCandide] Received: ${json.cmd} (state: ${this._state})`);

        if (json.cmd === 'controller-available') {
            // Start exchange
            this._state = 'EXCHANGE';
            console.log('[MockCandide] Starting exchange');

            setTimeout(() => {
                console.log('[MockCandide] Sending: get-control-surface');
                this._onSend({
                    cmd: 'get-control-surface',
                    mfg: 'AttachPart',
                    device: 'MockCandide',
                    version: '1.0'
                });
            }, 50);
        } else if (json.cmd === 'control-surface') {
            // Got capabilities, send assignments
            console.log(`[MockCandide] Got capabilities: ${json.device}`);

            setTimeout(() => {
                console.log('[MockCandide] Sending: assign');
                this._onSend({
                    cmd: 'assign',
                    controls: [
                        { input: 'OSC1_LEVEL', label: 'OSC1 Level', address: 0 },
                        { input: 'OSC2_LEVEL', label: 'OSC2 Level', address: 1 },
                        { input: 'FILTER_FREQUENCY', label: 'Filter', address: 2 }
                    ]
                });
            }, 50);
        } else if (json.cmd === 'thanks') {
            // Exchange complete
            this._state = 'PLAY';
            console.log('[MockCandide] Exchange complete, back to PLAY');
        } else {
            console.log('[MockCandide] Unknown command:', json.cmd);
        }
    }

    /**
     * Reset state (e.g., on disconnect)
     */
    reset() {
        this._state = 'PLAY';
    }
}

//======================================================================
// EXPORTS (for browser global scope)
//======================================================================

// Make classes globally accessible
window.MockBartleby = MockBartleby;
window.MockCandide = MockCandide;
