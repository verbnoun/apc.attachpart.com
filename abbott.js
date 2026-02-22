/**
 * Abbott - Software step sequencer controller
 *
 * Capabilities: IDENTITY, CONTROLLER, CONFIG
 *
 * A 16-step sequencer that sends Note On/Off through the registry routing
 * just like Bartleby's keyboard. Has 8 rotary controls and 2 linear controls
 * (XY pad axes) that participate in the exchange protocol.
 *
 * The synth doesn't know or care whether it's talking to hardware or software.
 */

class Abbott extends VirtualDevice {
    constructor(portManager, portName) {
        super(portManager, portName || 'AP Abbott');

        // Sequencer state
        this._steps = this._buildDefaultSteps();
        this._tempo = 120;
        this._playing = false;
        this._currentStep = -1;
        this._stepTimer = null;
        this._prevStepNotes = []; // notes from previous step (for note-off)

        // MPE channel allocator for note output
        this._mpeAllocator = new MpeChannelAllocator();
        this._noteChannels = new Map(); // note → channel

        // Config
        this._config = {
            tempo: 120,
            steps: 16,
            pots: this._buildDefaultPots(),
            linears: [
                { active: true, cc: 28, label: 'X Axis' },
                { active: true, cc: 29, label: 'Y Axis' }
            ]
        };

        // Exchange state
        this._patchData = null;

        // State subscribers (for UI)
        this._stateSubscribers = new Set();
    }

    _buildDefaultSteps() {
        const steps = [];
        for (let i = 0; i < 16; i++) {
            steps.push({ notes: [], velocity: 100 });
        }
        return steps;
    }

    _buildDefaultPots() {
        const pots = [];
        for (let i = 0; i < 8; i++) {
            pots.push({
                active: i < 4,
                cc: 20 + i,
                label: i < 4 ? `Knob ${i + 1}` : ''
            });
        }
        return pots;
    }

    //--------------------------------------------------------------
    // PROTOCOL HANDLERS
    //--------------------------------------------------------------

    handleCommand(json) {
        switch (json.cmd) {
            case 'get-device-info':
                this._sendResponse({
                    status: 'ok',
                    op: 'device-info',
                    name: 'Abbott',
                    project: 'Abbott',
                    version: '0.1.0',
                    capabilities: PORT_CAPABILITIES[this._portName]
                });
                break;

            case 'get-control-surface':
                this._handleGetControlSurface(json);
                break;

            case 'set-patch':
                this._handleSetPatch(json);
                break;

            case 'config-get':
                this._sendResponse({
                    status: 'ok',
                    op: 'config',
                    tempo: this._config.tempo,
                    steps: this._config.steps,
                    pots: this._config.pots,
                    linears: this._config.linears
                });
                break;

            case 'config-set':
                this._handleConfigSet(json);
                break;

            case 'config-reset':
                this._config = {
                    tempo: 120,
                    steps: 16,
                    pots: this._buildDefaultPots(),
                    linears: [
                        { active: true, cc: 28, label: 'X Axis' },
                        { active: true, cc: 29, label: 'Y Axis' }
                    ]
                };
                this._sendResponse({ status: 'ok', op: 'config-reset' });
                break;

            case 'save':
                this._sendResponse({ status: 'saved' });
                break;

            default:
                console.log(`[${this._portName}] Unhandled: ${json.cmd}`);
                this._sendResponse({ status: 'ok', op: json.cmd });
        }
    }

    //--------------------------------------------------------------
    // Exchange protocol (controller side)
    //--------------------------------------------------------------

    _handleGetControlSurface(json) {
        console.log(`[${this._portName}] Control surface requested by: ${json.device}`);

        this._sendResponse({
            cmd: 'control-surface',
            mfg: 'AttachPart',
            device: 'Abbott',
            version: '0.1.0',
            controls: { '1d.abs.rotary': 8, '1d.abs.linear': 2 },
            labeled: true,
            keyboard: { keys: 0, startNote: 0, perNote: [] }
        });
    }

    _handleSetPatch(json) {
        this._patchData = json;
        console.log(`[${this._portName}] Set patch "${json.name}" (${json.controls?.length || 0} controls)`);

        // Update pot config from assignments
        if (json.controls) {
            for (const ctrl of json.controls) {
                // Rotary controls: priority 0-7 → pots[0-7]
                if (ctrl.priority < 8 && ctrl.priority < this._config.pots.length) {
                    this._config.pots[ctrl.priority] = {
                        active: true,
                        cc: ctrl.cc,
                        label: ctrl.label
                    };
                }
                // Linear controls: priority 8-9 → linears[0-1]
                if (ctrl.priority >= 8 && ctrl.priority < 10) {
                    const linearIdx = ctrl.priority - 8;
                    if (linearIdx < this._config.linears.length) {
                        this._config.linears[linearIdx] = {
                            active: true,
                            cc: ctrl.cc,
                            label: ctrl.label
                        };
                    }
                }
            }
        }

        this._sendResponse({ status: 'ok', op: 'set-patch' });

        // Complete exchange
        setTimeout(() => {
            this._sendResponse({ cmd: 'thanks' });
        }, 50);
    }

    //--------------------------------------------------------------
    // Config
    //--------------------------------------------------------------

    _handleConfigSet(json) {
        const { cmd, ...partial } = json;
        if (partial.tempo !== undefined) {
            this._config.tempo = partial.tempo;
            this._tempo = partial.tempo;
            // Update timer interval if playing
            if (this._playing) {
                this._restartTimer();
            }
        }
        if (partial.steps !== undefined) {
            this._config.steps = partial.steps;
        }
        if (partial.pots) {
            this._config.pots = partial.pots;
        }
        if (partial.linears) {
            this._config.linears = partial.linears;
        }

        this._sendResponse({
            status: 'ok',
            op: 'config',
            config: this._config
        });
    }

    //--------------------------------------------------------------
    // SEQUENCER ENGINE
    //--------------------------------------------------------------

    play() {
        if (this._playing) return;
        this._playing = true;
        this._currentStep = -1;
        this._mpeAllocator.reset();
        this._noteChannels.clear();
        this._prevStepNotes = [];
        this._startTimer();
        this._notifyStateChange();
    }

    stop() {
        if (!this._playing) return;
        this._playing = false;
        this._stopTimer();

        // Send note-off for any active notes
        this._sendNoteOffs(this._prevStepNotes);
        this._prevStepNotes = [];
        this._currentStep = -1;
        this._mpeAllocator.reset();
        this._noteChannels.clear();
        this._notifyStateChange();
    }

    _startTimer() {
        const intervalMs = (60000 / this._tempo) / 4; // 16th notes
        this._stepTimer = setInterval(() => this._tick(), intervalMs);
    }

    _stopTimer() {
        if (this._stepTimer) {
            clearInterval(this._stepTimer);
            this._stepTimer = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _tick() {
        // Advance step
        this._currentStep = (this._currentStep + 1) % 16;

        // Note-off previous step's notes
        this._sendNoteOffs(this._prevStepNotes);

        // Note-on current step's notes
        const step = this._steps[this._currentStep];
        const velocity = step.velocity;
        const notesPlayed = [];

        for (const pitch of step.notes) {
            const channel = this._mpeAllocator.allocate(pitch);
            this._noteChannels.set(pitch, channel);
            notesPlayed.push(pitch);

            // Note On: 0x9n note velocity
            this._sendMidi(new Uint8Array([0x90 | channel, pitch, velocity]));
        }

        this._prevStepNotes = notesPlayed;
        this._notifyStateChange();
    }

    _sendNoteOffs(notes) {
        for (const pitch of notes) {
            const channel = this._noteChannels.get(pitch);
            if (channel !== undefined) {
                // Note Off: 0x8n note 0
                this._sendMidi(new Uint8Array([0x80 | channel, pitch, 0]));
                this._mpeAllocator.release(pitch);
                this._noteChannels.delete(pitch);
            }
        }
    }

    //--------------------------------------------------------------
    // STEP EDITING (called by UI)
    //--------------------------------------------------------------

    setStep(index, notes) {
        if (index < 0 || index >= 16) return;
        this._steps[index] = { ...this._steps[index], notes: [...notes] };
        this._notifyStateChange();
    }

    toggleNote(stepIndex, pitch) {
        if (stepIndex < 0 || stepIndex >= 16) return;
        const step = this._steps[stepIndex];
        const idx = step.notes.indexOf(pitch);
        if (idx >= 0) {
            step.notes.splice(idx, 1);
        } else {
            step.notes.push(pitch);
        }
        this._notifyStateChange();
    }

    setTempo(bpm) {
        this._tempo = Math.max(20, Math.min(300, bpm));
        this._config.tempo = this._tempo;
        if (this._playing) {
            this._restartTimer();
        }
        this._notifyStateChange();
    }

    setStepVelocity(index, velocity) {
        if (index < 0 || index >= 16) return;
        this._steps[index].velocity = Math.max(1, Math.min(127, velocity));
        this._notifyStateChange();
    }

    //--------------------------------------------------------------
    // STATE ACCESS (for UI)
    //--------------------------------------------------------------

    getSequencerState() {
        return {
            steps: this._steps,
            tempo: this._tempo,
            playing: this._playing,
            currentStep: this._currentStep
        };
    }

    subscribeState(callback) {
        this._stateSubscribers.add(callback);
        return () => this._stateSubscribers.delete(callback);
    }

    _notifyStateChange() {
        const state = this.getSequencerState();
        for (const cb of this._stateSubscribers) {
            cb(state);
        }
    }
}

window.Abbott = Abbott;
