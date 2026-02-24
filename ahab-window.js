/**
 * AhabWindow - Circular step sequencer UI for Ahab controller
 *
 * Skeuomorphic hardware-mirroring interface:
 * - Central rotating wheel with 16 radial step positions
 * - Status screen showing track/part/step details
 * - Per-step controls: rotary encoder (note), velocity pad, XY joystick
 * - Track management with part assignment
 *
 * Communicates directly with the Ahab device instance —
 * no protocol messages, just in-memory calls.
 */

const { useState, useEffect, useCallback, useRef, useMemo } = React;

//--------------------------------------------------------------
// Helper: MIDI note name
//--------------------------------------------------------------
function noteName(midi) {
    if (midi === null || midi === undefined) return '---';
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
}

//--------------------------------------------------------------
// SUB-COMPONENT: Rotary Encoder Knob
//--------------------------------------------------------------
function RotaryEncoder({ value, min, max, onChange, label, displayValue, size = 64 }) {
    const knobRef = useRef(null);
    const dragRef = useRef(null);
    const r = size / 2;
    const range = max - min;
    const normalized = range > 0 ? (value - min) / range : 0;
    const angle = -135 + normalized * 270; // -135 to +135 degrees

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startValue: value };

        const handleMouseMove = (e) => {
            const dy = dragRef.current.startY - e.clientY;
            const step = range / 100;
            const newVal = Math.round(Math.max(min, Math.min(max, dragRef.current.startValue + dy * step)));
            if (newVal !== value) onChange(newVal);
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [value, min, max, range, onChange]);

    return (
        <div className="ap-ahab-encoder" ref={knobRef} onMouseDown={handleMouseDown}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* Track arc */}
                <circle cx={r} cy={r} r={r - 6} fill="none" stroke="#555" strokeWidth="2"
                    strokeDasharray={`${Math.PI * (r-6) * 0.75} ${Math.PI * (r-6) * 0.25}`}
                    strokeDashoffset={Math.PI * (r-6) * 0.375}
                    transform={`rotate(135 ${r} ${r})`} />
                {/* Knob body */}
                <circle cx={r} cy={r} r={r - 10} fill="#2a2a2a" stroke="#444" strokeWidth="1.5" />
                {/* Indicator line */}
                <line x1={r} y1={r} x2={r} y2={14}
                    stroke="#e8a030" strokeWidth="2" strokeLinecap="round"
                    transform={`rotate(${angle} ${r} ${r})`} />
            </svg>
            <div className="ap-ahab-encoder-label">{displayValue ?? value}</div>
            {label && <div className="ap-ahab-encoder-sublabel">{label}</div>}
        </div>
    );
}

//--------------------------------------------------------------
// SUB-COMPONENT: Velocity Pad
//--------------------------------------------------------------
function VelocityPad({ velocity, onChange, size = 56 }) {
    const dragRef = useRef(null);
    const fillHeight = (velocity / 127) * size;

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();

        const update = (clientY) => {
            const y = Math.max(0, Math.min(size, rect.bottom - clientY));
            onChange(Math.max(1, Math.min(127, Math.round((y / size) * 127))));
        };

        update(e.clientY);

        const handleMouseMove = (e) => update(e.clientY);
        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [size, onChange]);

    return (
        <div className="ap-ahab-pad" style={{ width: size, height: size }} onMouseDown={handleMouseDown}>
            <div className="ap-ahab-pad-fill" style={{ height: fillHeight }} />
            <div className="ap-ahab-pad-label">{velocity}</div>
        </div>
    );
}

//--------------------------------------------------------------
// SUB-COMPONENT: XY Joystick
//--------------------------------------------------------------
function XYJoystick({ x, y, onChange, size = 80, xLabel = 'X', yLabel = 'Y' }) {
    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();

        const update = (clientX, clientY) => {
            const nx = Math.max(0, Math.min(127, Math.round(((clientX - rect.left) / size) * 127)));
            const ny = Math.max(0, Math.min(127, Math.round((1 - (clientY - rect.top) / size) * 127)));
            onChange(nx, ny);
        };

        update(e.clientX, e.clientY);

        const handleMouseMove = (e) => update(e.clientX, e.clientY);
        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [size, onChange]);

    const dotX = (x / 127) * size;
    const dotY = (1 - y / 127) * size;

    return (
        <div className="ap-ahab-joystick" style={{ width: size, height: size }} onMouseDown={handleMouseDown}>
            <div className="ap-ahab-joystick-crosshair-h" style={{ top: dotY }} />
            <div className="ap-ahab-joystick-crosshair-v" style={{ left: dotX }} />
            <div className="ap-ahab-joystick-dot" style={{ left: dotX - 4, top: dotY - 4 }} />
            <div className="ap-ahab-joystick-label">{xLabel}:{x} {yLabel}:{y}</div>
        </div>
    );
}

//--------------------------------------------------------------
// MAIN COMPONENT: AhabWindow
//--------------------------------------------------------------
function AhabWindow({ device }) {
    const [state, setState] = useState(device.getSequencerState());

    useEffect(() => {
        return device.subscribeState(setState);
    }, [device]);

    const { tracks, currentTrack, selectedStep, tempo, playing, currentStep, availablePatches, linearLabels } = state;
    const track = tracks[currentTrack] || tracks[0];
    const step = track.steps[selectedStep];

    // Wheel geometry
    const WHEEL_SIZE = 300;
    const WHEEL_CX = WHEEL_SIZE / 2;
    const WHEEL_CY = WHEEL_SIZE / 2;
    const STEP_RADIUS = 115; // distance from center to step dots
    const DOT_RADIUS = 12;

    // Calculate step positions around the wheel (clock positions, 0 = top)
    const stepPositions = useMemo(() => {
        return Array.from({ length: 16 }, (_, i) => {
            const angle = (i / 16) * 2 * Math.PI - Math.PI / 2; // start at top
            return {
                x: WHEEL_CX + Math.cos(angle) * STEP_RADIUS,
                y: WHEEL_CY + Math.sin(angle) * STEP_RADIUS
            };
        });
    }, []);

    // Wheel rotation angle (playhead position)
    const wheelRotation = playing && currentStep >= 0
        ? (currentStep / 16) * 360
        : 0;

    // Wheel drag for scrubbing
    const wheelDragRef = useRef(null);
    const handleWheelMouseDown = useCallback((e) => {
        if (!e.target.closest('.ap-ahab-step-dot')) {
            e.preventDefault();
            wheelDragRef.current = true;

            const handleMouseMove = (e) => {
                if (!wheelDragRef.current) return;
                const svg = e.target.closest('.ap-ahab-wheel') || document.querySelector('.ap-ahab-wheel');
                if (!svg) return;
                const rect = svg.getBoundingClientRect();
                const dx = e.clientX - rect.left - WHEEL_CX;
                const dy = e.clientY - rect.top - WHEEL_CY;
                let angle = Math.atan2(dy, dx) + Math.PI / 2;
                if (angle < 0) angle += 2 * Math.PI;
                const stepIdx = Math.round((angle / (2 * Math.PI)) * 16) % 16;
                device.scrubTo(stepIdx);
            };

            const handleMouseUp = () => {
                wheelDragRef.current = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }
    }, [device]);

    // Keyboard shortcut: space = play/stop
    useEffect(() => {
        const handler = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.code === 'Space') {
                e.preventDefault();
                if (playing) device.stop();
                else device.play();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [playing, device]);

    return (
        <div className="ap-ahab">
            {/* Status Screen */}
            <div className="ap-ahab-screen">
                <div className="ap-ahab-screen-row">
                    <span className="ap-ahab-screen-label">TRACK</span>
                    <APSelect
                        className="ap-ahab-screen-select"
                        value={currentTrack}
                        options={tracks.map((t, i) => ({ value: i, label: t.name }))}
                        onChange={val => device.selectTrack(parseInt(val))}
                    />
                    <button className="ap-ahab-screen-btn" onClick={() => device.addTrack()} title="Add track">+</button>
                    <button className="ap-ahab-screen-btn" onClick={() => device.removeTrack(currentTrack)} title="Remove track">−</button>
                </div>
                <div className="ap-ahab-screen-row">
                    <span className="ap-ahab-screen-label">PART</span>
                    <APSelect
                        className="ap-ahab-screen-select"
                        value={track.part}
                        options={availablePatches.length > 0
                            ? availablePatches.map((name, i) => ({ value: i, label: name }))
                            : [{ value: 0, label: 'Part 1' }]
                        }
                        onChange={val => device.setTrackPart(currentTrack, parseInt(val))}
                    />
                </div>
                <div className="ap-ahab-screen-divider" />
                <div className="ap-ahab-screen-row ap-ahab-screen-detail">
                    <span>STEP {selectedStep + 1}: {noteName(step.note)}
                        {(step.chord && step.chord !== 'off') ? ` ${CHORD_SHORT_NAMES[step.chord]}` : ''}
                        {(step.chord && step.chord !== 'off' && step.inversion > 0) ? ` inv${step.inversion}` : ''}
                    </span>
                    <span>VEL {step.velocity}</span>
                    <span>{linearLabels?.[0] || 'X'}:{step.x} {linearLabels?.[1] || 'Y'}:{step.y}</span>
                </div>
            </div>

            {/* Transport */}
            <div className="ap-ahab-transport">
                <button
                    className={`ap-btn ap-btn-small ap-ahab-play ${playing ? 'active' : ''}`}
                    onClick={() => playing ? device.stop() : device.play()}
                >
                    {playing ? '■' : '▶'}
                </button>
                <div className="ap-ahab-tempo">
                    <span className="ap-ahab-tempo-label">BPM</span>
                    <input
                        type="number"
                        className="ap-input ap-ahab-tempo-input"
                        value={tempo}
                        min={20}
                        max={300}
                        onChange={e => device.setTempo(parseInt(e.target.value) || 120)}
                    />
                </div>
            </div>

            {/* Wheel */}
            <div className="ap-ahab-wheel-container">
                <svg
                    className="ap-ahab-wheel"
                    width={WHEEL_SIZE}
                    height={WHEEL_SIZE}
                    viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
                    onMouseDown={handleWheelMouseDown}
                >
                    {/* Outer ring */}
                    <circle cx={WHEEL_CX} cy={WHEEL_CY} r={STEP_RADIUS + 20} fill="none" stroke="#444" strokeWidth="1" />
                    <circle cx={WHEEL_CX} cy={WHEEL_CY} r={STEP_RADIUS - 20} fill="none" stroke="#333" strokeWidth="1" />

                    {/* Center hub */}
                    <circle cx={WHEEL_CX} cy={WHEEL_CY} r={40} fill="#1a1a1a" stroke="#444" strokeWidth="1.5" />
                    <circle cx={WHEEL_CX} cy={WHEEL_CY} r={4} fill="#666" />

                    {/* Spoke lines */}
                    {stepPositions.map((pos, i) => (
                        <line key={`spoke-${i}`}
                            x1={WHEEL_CX} y1={WHEEL_CY}
                            x2={WHEEL_CX + Math.cos((i/16)*2*Math.PI - Math.PI/2) * (STEP_RADIUS - 22)}
                            y2={WHEEL_CY + Math.sin((i/16)*2*Math.PI - Math.PI/2) * (STEP_RADIUS - 22)}
                            stroke="#222" strokeWidth="1" />
                    ))}

                    {/* Step number labels (outside ring) */}
                    {stepPositions.map((pos, i) => {
                        const labelR = STEP_RADIUS + 30;
                        const angle = (i / 16) * 2 * Math.PI - Math.PI / 2;
                        return (
                            <text key={`label-${i}`}
                                x={WHEEL_CX + Math.cos(angle) * labelR}
                                y={WHEEL_CY + Math.sin(angle) * labelR + 4}
                                textAnchor="middle" fill="#555" fontSize="10"
                                fontFamily="Chicago_12, Chicago, monospace">
                                {i + 1}
                            </text>
                        );
                    })}

                    {/* Step dots */}
                    {stepPositions.map((pos, i) => {
                        const stepData = track.steps[i];
                        const hasNote = stepData.note !== null;
                        const hasChord = hasNote && stepData.chord && stepData.chord !== 'off';
                        const isSelected = i === selectedStep;
                        const isPlayhead = i === currentStep && playing;

                        let fill = '#2a2a2a';
                        let stroke = '#555';
                        let strokeW = 1.5;
                        if (hasNote) { fill = hasChord ? '#c47a44' : '#d4a574'; stroke = '#e8a030'; }
                        if (isSelected) { stroke = '#ffffff'; strokeW = 2; }
                        if (isPlayhead) { fill = hasNote ? '#f0c878' : '#4a4a4a'; stroke = '#ffffff'; strokeW = 2.5; }

                        return (
                            <g key={`step-${i}`}>
                                <circle
                                    className="ap-ahab-step-dot"
                                    cx={pos.x} cy={pos.y} r={DOT_RADIUS}
                                    fill={fill} stroke={stroke} strokeWidth={strokeW}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => device.selectStep(i)}
                                />
                                {hasChord && (
                                    <circle
                                        cx={pos.x} cy={pos.y} r={4}
                                        fill="none" stroke="#fff" strokeWidth="1"
                                        pointerEvents="none"
                                    />
                                )}
                            </g>
                        );
                    })}

                    {/* Playhead indicator (rotating arm) */}
                    {playing && currentStep >= 0 && (() => {
                        const angle = (currentStep / 16) * 2 * Math.PI - Math.PI / 2;
                        const tipR = STEP_RADIUS + 16;
                        return (
                            <line
                                x1={WHEEL_CX} y1={WHEEL_CY}
                                x2={WHEEL_CX + Math.cos(angle) * tipR}
                                y2={WHEEL_CY + Math.sin(angle) * tipR}
                                stroke="#e8a030" strokeWidth="2" strokeLinecap="round"
                                opacity="0.6" />
                        );
                    })()}
                </svg>
            </div>

            {/* Per-step controls */}
            <div className="ap-ahab-controls">
                <div className="ap-ahab-control-group">
                    <RotaryEncoder
                        value={step.note ?? 60}
                        min={24}
                        max={96}
                        onChange={v => device.setStepNote(selectedStep, v)}
                        label="NOTE"
                        displayValue={noteName(step.note)}
                        size={72}
                    />
                    <button
                        className={`ap-btn ap-btn-small ap-ahab-note-toggle ${step.note !== null ? 'active' : ''}`}
                        onClick={() => device.setStepNote(selectedStep, step.note !== null ? null : 60)}
                    >
                        {step.note !== null ? 'ON' : 'REST'}
                    </button>
                </div>

                <div className="ap-ahab-control-group">
                    <APSelect
                        className="ap-ahab-chord-select"
                        value={step.chord || 'off'}
                        options={Object.entries(CHORD_DISPLAY_NAMES).map(([key, name]) => ({ value: key, label: name }))}
                        onChange={val => device.setStepChord(selectedStep, val)}
                    />
                    <APSelect
                        className="ap-ahab-chord-select"
                        value={step.inversion || 0}
                        options={INVERSION_NAMES.map((name, i) => ({ value: i, label: name }))}
                        onChange={val => device.setStepInversion(selectedStep, parseInt(val))}
                        disabled={(step.chord || 'off') === 'off'}
                    />
                    <div className="ap-ahab-control-label">CHORD</div>
                </div>

                <div className="ap-ahab-control-group">
                    <VelocityPad
                        velocity={step.velocity}
                        onChange={v => device.setStepVelocity(selectedStep, v)}
                        size={60}
                    />
                    <div className="ap-ahab-control-label">VEL</div>
                </div>

                <div className="ap-ahab-control-group">
                    <XYJoystick
                        x={step.x}
                        y={step.y}
                        onChange={(x, y) => device.setStepXY(selectedStep, x, y)}
                        size={80}
                        xLabel={linearLabels?.[0] || 'X'}
                        yLabel={linearLabels?.[1] || 'Y'}
                    />
                    <div className="ap-ahab-control-label">XY</div>
                </div>
            </div>
        </div>
    );
}

window.AhabWindow = AhabWindow;
