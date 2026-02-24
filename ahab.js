/**
 * Ahab - Software step sequencer controller
 *
 * Capabilities: IDENTITY, CONTROLLER, CONFIG
 *
 * A 16-step circular sequencer with multi-track support.
 * Each track targets a synth part. Each step has root note,
 * chord type, inversion, velocity, and XY joystick values.
 * Sends Note On/Off and CC through the registry routing.
 *
 * The synth doesn't know or care whether it's talking to hardware or software.
 */

//--------------------------------------------------------------
// CHORD ENGINE (interval tables from Candide's chord_engine.cpp)
//--------------------------------------------------------------

const CHORD_INTERVALS = {
    'off':  null,
    'maj':  [0, 4, 7],
    'min':  [0, 3, 7],
    'sus4': [0, 5, 7],
    'dim':  [0, 3, 6],
    'aug':  [0, 4, 8],
    'dom7': [0, 4, 7, 10],
    'maj7': [0, 4, 7, 11],
    'min7': [0, 3, 7, 10]
};

const CHORD_DISPLAY_NAMES = {
    'off': 'Single', 'maj': 'Major', 'min': 'Minor', 'sus4': 'Sus4',
    'dim': 'Dim', 'aug': 'Aug', 'dom7': 'Dom 7', 'maj7': 'Maj 7', 'min7': 'Min 7'
};

const CHORD_SHORT_NAMES = {
    'off': '', 'maj': 'maj', 'min': 'min', 'sus4': 'sus4',
    'dim': 'dim', 'aug': 'aug', 'dom7': '7', 'maj7': 'M7', 'min7': 'm7'
};

const INVERSION_NAMES = ['Root', '1st', '2nd'];

/**
 * Compute MIDI note numbers for a chord.
 * Inversion logic matches Candide: shift N lowest intervals up +12, sort ascending.
 */
function computeChordNotes(rootNote, chordType, inversion) {
    if (rootNote === null) return [];
    if (chordType === 'off' || !CHORD_INTERVALS[chordType]) return [rootNote];

    const intervals = CHORD_INTERVALS[chordType];
    let notes = intervals.map(i => rootNote + i);

    // Apply inversion: move lowest notes up an octave
    for (let inv = 0; inv < inversion && inv < notes.length - 1; inv++) {
        notes[inv] += 12;
    }

    notes.sort((a, b) => a - b);
    return notes.filter(n => n >= 0 && n <= 127);
}

class Ahab extends VirtualDevice {
    constructor(portManager, portName) {
        super(portManager, portName || 'AP Ahab');

        // Tracks (each track targets a synth part)
        this._tracks = [
            { name: 'Track 1', part: 0, steps: this._buildDefaultSteps() }
        ];
        this._currentTrack = 0;
        this._selectedStep = 0;

        // Sequencer state
        this._tempo = 120;
        this._playing = false;
        this._currentStep = -1;
        this._stepTimer = null;

        // Per-track note-off tracking: trackIndex → [{ pitch, channel }]
        this._activeNotes = new Map();

        // MPE channel allocator for note output
        this._mpeAllocator = new MpeChannelAllocator();

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
        this._availablePatches = []; // patch names from synth (received during exchange)

        // State subscribers (for UI)
        this._stateSubscribers = new Set();
    }

    _buildDefaultSteps() {
        const steps = [];
        for (let i = 0; i < 16; i++) {
            steps.push({ note: null, chord: 'off', inversion: 0, velocity: 100, x: 0, y: 0 });
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
                    name: 'Ahab',
                    project: 'Ahab',
                    version: '0.2.0',
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
            status: 'ok',
            op: 'control-surface',
            mfg: 'AttachPart',
            device: 'Ahab',
            version: '0.2.0',
            controls: { '1d.abs.rotary': 8, '1d.abs.linear': 2 },
            labeled: true,
            keyboard: { keys: 0, startNote: 0, perNote: [] },
            parts: this._tracks.length
        });
    }

    _handleSetPatch(json) {
        this._patchData = json;
        if (json.patches) {
            this._availablePatches = json.patches;
        }
        console.log(`[${this._portName}] Set patch "${json.name}" (${json.controls?.length || 0} controls)`);

        // Update pot config from assignments
        if (json.controls) {
            for (const ctrl of json.controls) {
                if (ctrl.priority < 8 && ctrl.priority < this._config.pots.length) {
                    this._config.pots[ctrl.priority] = {
                        active: true,
                        cc: ctrl.cc,
                        label: ctrl.label
                    };
                }
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

        this._notifyStateChange();
    }

    //--------------------------------------------------------------
    // Config
    //--------------------------------------------------------------

    _handleConfigSet(json) {
        const { cmd, ...partial } = json;
        if (partial.tempo !== undefined) {
            this._config.tempo = partial.tempo;
            this._tempo = partial.tempo;
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
        this._activeNotes.clear();
        this._startTimer();
        this._notifyStateChange();
    }

    stop() {
        if (!this._playing) return;
        this._playing = false;
        this._stopTimer();

        // Send note-off for all active notes across all tracks
        for (const [trackIdx, notes] of this._activeNotes) {
            for (const { pitch, channel } of notes) {
                this._sendMidi(new Uint8Array([0x80 | channel, pitch, 0]));
            }
        }
        this._activeNotes.clear();
        this._currentStep = -1;
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
        this._currentStep = (this._currentStep + 1) % 16;

        // Partition 16 channels across parts (used tracks count as demand)
        const numParts = Math.max(1, this._tracks.length);
        const channelsPerPart = Math.floor(16 / numParts);

        // Process all tracks
        for (let t = 0; t < this._tracks.length; t++) {
            const track = this._tracks[t];
            const step = track.steps[this._currentStep];

            // Channel range for this track's part
            const baseChannel = track.part * channelsPerPart;

            // Note-off previous notes for this track
            const prevNotes = this._activeNotes.get(t) || [];
            for (const { pitch, channel } of prevNotes) {
                this._sendMidi(new Uint8Array([0x80 | channel, pitch, 0]));
            }
            this._activeNotes.set(t, []);

            // Note-on if step has a note (compute chord notes from root + type + inversion)
            if (step.note !== null) {
                const chordNotes = computeChordNotes(step.note, step.chord || 'off', step.inversion || 0);

                for (let n = 0; n < chordNotes.length; n++) {
                    const pitch = chordNotes[n];
                    const channel = baseChannel + (n % channelsPerPart);
                    this._sendMidi(new Uint8Array([0x90 | channel, pitch, step.velocity]));
                    this._activeNotes.get(t).push({ pitch, channel });

                    // Send XY CC values on each channel
                    if (step.x !== 0 && this._config.linears[0]) {
                        this._sendMidi(new Uint8Array([0xB0 | channel, this._config.linears[0].cc, step.x]));
                    }
                    if (step.y !== 0 && this._config.linears[1]) {
                        this._sendMidi(new Uint8Array([0xB0 | channel, this._config.linears[1].cc, step.y]));
                    }
                }
            }
        }

        this._notifyStateChange();
    }

    //--------------------------------------------------------------
    // STEP EDITING (called by UI)
    //--------------------------------------------------------------

    setStepNote(stepIndex, note) {
        const track = this._tracks[this._currentTrack];
        if (!track || stepIndex < 0 || stepIndex >= 16) return;
        track.steps[stepIndex].note = note; // null for rest
        this._notifyStateChange();
    }

    setStepVelocity(stepIndex, velocity) {
        const track = this._tracks[this._currentTrack];
        if (!track || stepIndex < 0 || stepIndex >= 16) return;
        track.steps[stepIndex].velocity = Math.max(1, Math.min(127, velocity));
        this._notifyStateChange();
    }

    setStepXY(stepIndex, x, y) {
        const track = this._tracks[this._currentTrack];
        if (!track || stepIndex < 0 || stepIndex >= 16) return;
        track.steps[stepIndex].x = Math.max(0, Math.min(127, Math.round(x)));
        track.steps[stepIndex].y = Math.max(0, Math.min(127, Math.round(y)));
        this._notifyStateChange();
    }

    setStepChord(stepIndex, chordType) {
        const track = this._tracks[this._currentTrack];
        if (!track || stepIndex < 0 || stepIndex >= 16) return;
        if (!CHORD_INTERVALS.hasOwnProperty(chordType)) return;
        track.steps[stepIndex].chord = chordType;
        if (chordType === 'off') {
            track.steps[stepIndex].inversion = 0;
        }
        this._notifyStateChange();
    }

    setStepInversion(stepIndex, inversion) {
        const track = this._tracks[this._currentTrack];
        if (!track || stepIndex < 0 || stepIndex >= 16) return;
        track.steps[stepIndex].inversion = Math.max(0, Math.min(2, inversion));
        this._notifyStateChange();
    }

    selectStep(index) {
        if (index < 0 || index >= 16) return;
        this._selectedStep = index;
        this._notifyStateChange();
    }

    //--------------------------------------------------------------
    // TRACK MANAGEMENT (called by UI)
    //--------------------------------------------------------------

    addTrack() {
        if (this._tracks.length >= 4) return; // max 4 tracks
        this._tracks.push({
            name: `Track ${this._tracks.length + 1}`,
            part: this._tracks.length,
            steps: this._buildDefaultSteps()
        });
        this._currentTrack = this._tracks.length - 1;
        this._notifyStateChange();
    }

    removeTrack(index) {
        if (this._tracks.length <= 1) return; // keep at least 1
        if (index < 0 || index >= this._tracks.length) return;
        this._tracks.splice(index, 1);
        if (this._currentTrack >= this._tracks.length) {
            this._currentTrack = this._tracks.length - 1;
        }
        this._notifyStateChange();
    }

    selectTrack(index) {
        if (index < 0 || index >= this._tracks.length) return;
        this._currentTrack = index;
        this._notifyStateChange();
    }

    setTrackPart(trackIndex, partIndex) {
        const track = this._tracks[trackIndex];
        if (!track) return;
        track.part = partIndex;
        this._notifyStateChange();
    }

    setTrackName(trackIndex, name) {
        const track = this._tracks[trackIndex];
        if (!track) return;
        track.name = name;
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

    // Scrub playback position (wheel drag)
    scrubTo(stepIndex) {
        if (stepIndex < 0 || stepIndex >= 16) return;
        this._currentStep = stepIndex;
        this._notifyStateChange();
    }

    //--------------------------------------------------------------
    // STATE ACCESS (for UI)
    //--------------------------------------------------------------

    getSequencerState() {
        return {
            tracks: this._tracks,
            currentTrack: this._currentTrack,
            selectedStep: this._selectedStep,
            tempo: this._tempo,
            playing: this._playing,
            currentStep: this._currentStep,
            availablePatches: this._availablePatches,
            linearLabels: this._config.linears.map(l => l.label)
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

window.Ahab = Ahab;
window.CHORD_INTERVALS = CHORD_INTERVALS;
window.CHORD_DISPLAY_NAMES = CHORD_DISPLAY_NAMES;
window.CHORD_SHORT_NAMES = CHORD_SHORT_NAMES;
window.INVERSION_NAMES = INVERSION_NAMES;
window.computeChordNotes = computeChordNotes;
