/**
 * AbbottWindow - Step sequencer UI for Abbott controller
 *
 * 16-step grid with chromatic pitch rows (C3-B4, 2 octaves).
 * Transport bar with play/stop and tempo control.
 * Playhead indicator shows current step during playback.
 *
 * Communicates directly with the Abbott device instance —
 * UI reads state, user input calls device methods.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Pitch range: C3 (48) to B4 (71) — 2 octaves, 24 rows
const PITCH_LOW = 48;   // C3
const PITCH_HIGH = 71;  // B4
const NUM_STEPS = 16;

function AbbottWindow({ device }) {
    const [seqState, setSeqState] = React.useState(() => device.getSequencerState());
    const [tempoInput, setTempoInput] = React.useState(String(seqState.tempo));
    const tempoCommitRef = React.useRef(null);

    // Subscribe to device state changes
    React.useEffect(() => {
        const unsub = device.subscribeState((state) => {
            setSeqState(state);
        });
        return unsub;
    }, [device]);

    // Keep tempo input in sync when not editing
    React.useEffect(() => {
        if (document.activeElement?.dataset?.tempoInput !== 'true') {
            setTempoInput(String(seqState.tempo));
        }
    }, [seqState.tempo]);

    const handlePlayStop = React.useCallback(() => {
        if (seqState.playing) {
            device.stop();
        } else {
            device.play();
        }
    }, [device, seqState.playing]);

    const handleTempoChange = React.useCallback((e) => {
        setTempoInput(e.target.value);
        // Clear existing commit timer
        if (tempoCommitRef.current) clearTimeout(tempoCommitRef.current);
        // Debounce: commit after 400ms of no typing
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 20 && val <= 300) {
            tempoCommitRef.current = setTimeout(() => {
                device.setTempo(val);
            }, 400);
        }
    }, [device]);

    const handleTempoBlur = React.useCallback(() => {
        if (tempoCommitRef.current) clearTimeout(tempoCommitRef.current);
        const val = parseInt(tempoInput, 10);
        if (!isNaN(val) && val >= 20 && val <= 300) {
            device.setTempo(val);
        } else {
            setTempoInput(String(seqState.tempo));
        }
    }, [device, tempoInput, seqState.tempo]);

    const handleTempoKeyDown = React.useCallback((e) => {
        if (e.key === 'Enter') {
            e.target.blur();
        }
    }, []);

    const handleCellClick = React.useCallback((stepIndex, pitch) => {
        device.toggleNote(stepIndex, pitch);
    }, [device]);

    // Build pitch rows (high to low so highest note is at top)
    const pitchRows = React.useMemo(() => {
        const rows = [];
        for (let p = PITCH_HIGH; p >= PITCH_LOW; p--) {
            const octave = Math.floor(p / 12) - 1;
            const name = NOTE_NAMES[p % 12];
            const isBlackKey = name.includes('#');
            rows.push({ pitch: p, label: `${name}${octave}`, isBlackKey });
        }
        return rows;
    }, []);

    // Keyboard shortcut: space = play/stop
    React.useEffect(() => {
        const handler = (e) => {
            if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
                e.preventDefault();
                if (seqState.playing) {
                    device.stop();
                } else {
                    device.play();
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [device, seqState.playing]);

    return (
        <div className="ap-abbott">
            {/* Transport bar */}
            <div className="ap-abbott-transport">
                <button
                    className={`ap-btn ap-btn-small ap-abbott-play ${seqState.playing ? 'active' : ''}`}
                    onClick={handlePlayStop}
                >
                    {seqState.playing ? 'STOP' : 'PLAY'}
                </button>
                <div className="ap-abbott-tempo">
                    <span className="ap-abbott-tempo-label">BPM</span>
                    <input
                        className="ap-input ap-abbott-tempo-input"
                        type="number"
                        min="20"
                        max="300"
                        value={tempoInput}
                        onChange={handleTempoChange}
                        onBlur={handleTempoBlur}
                        onKeyDown={handleTempoKeyDown}
                        data-tempo-input="true"
                    />
                </div>
                <div className="ap-abbott-step-display">
                    Step {seqState.playing ? seqState.currentStep + 1 : '-'} / {NUM_STEPS}
                </div>
            </div>

            {/* Step grid */}
            <div className="ap-abbott-grid-wrapper">
                <div className="ap-abbott-grid">
                    {/* Column headers (step numbers) */}
                    <div className="ap-abbott-header-row">
                        <div className="ap-abbott-pitch-label ap-abbott-corner"></div>
                        {Array.from({ length: NUM_STEPS }, (_, i) => (
                            <div
                                key={i}
                                className={`ap-abbott-step-header ${seqState.currentStep === i ? 'active' : ''} ${i % 4 === 0 ? 'bar-start' : ''}`}
                            >
                                {i + 1}
                            </div>
                        ))}
                    </div>

                    {/* Pitch rows */}
                    {pitchRows.map(({ pitch, label, isBlackKey }) => (
                        <div
                            key={pitch}
                            className={`ap-abbott-row ${isBlackKey ? 'black-key' : 'white-key'} ${pitch % 12 === 0 ? 'octave-start' : ''}`}
                        >
                            <div className="ap-abbott-pitch-label">{label}</div>
                            {Array.from({ length: NUM_STEPS }, (_, stepIdx) => {
                                const isActive = seqState.steps[stepIdx].notes.includes(pitch);
                                const isPlayhead = seqState.playing && seqState.currentStep === stepIdx;
                                return (
                                    <div
                                        key={stepIdx}
                                        className={
                                            'ap-abbott-cell' +
                                            (isActive ? ' on' : '') +
                                            (isPlayhead ? ' playhead' : '') +
                                            (stepIdx % 4 === 0 ? ' bar-start' : '')
                                        }
                                        onClick={() => handleCellClick(stepIdx, pitch)}
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

window.AbbottWindow = AbbottWindow;
