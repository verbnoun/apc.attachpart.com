/**
 * Expression Pad Window - MPE expression controller
 *
 * Canvas-based XY pad for sending pitch bend and channel pressure.
 * Supports MPE (per-note channels) and includes MIDI monitor.
 * Depends on: React, MpeChannelAllocator (midi-connection.js)
 */

// Melody sequence for expression pad
const MELODY = [
    60, 64, 67, 72,
    71, 67, 64, 60,
    62, 65, 69, 74,
    72, 69, 65, 62,
];

// Color palette for polyphonic note display
const NOTE_COLORS = [
    '#ffb000',
    '#00ff88',
    '#ff4488',
    '#44aaff',
    '#ff8844',
    '#aa44ff',
];

function ExpressionPadWindow({ devices, deviceApisRef, deviceRegistry, midiState, addLog }) {
    const canvasRef = React.useRef(null);
    const [velocity, setVelocity] = React.useState(0.8);
    const [activeNotes, setActiveNotes] = React.useState(new Map());
    const [hideCursor, setHideCursor] = React.useState(false);
    const colorIndexRef = React.useRef(0);
    const melodyIndexRef = React.useRef(0);
    const playingRef = React.useRef(false);

    const [mpeEnabled, setMpeEnabled] = React.useState(true);
    const [loggingEnabled, setLoggingEnabled] = React.useState(false);
    const mpeAllocatorRef = React.useRef(new MpeChannelAllocator());
    const currentChannelRef = React.useRef(0);
    const mouseNoteRef = React.useRef(null);

    const lastSendTimeRef = React.useRef(0);
    const lastBendRef = React.useRef(0);
    const lastPressureRef = React.useRef(0.5);
    const THROTTLE_INTERVAL_MS = 50;
    const CHANGE_THRESHOLD = 0.02;

    // MIDI monitor — recent incoming events from all devices
    const [midiMonitor, setMidiMonitor] = React.useState([]);
    const monitorScrollRef = React.useRef(null);

    // Broadcast to all connected devices
    const getOutputApis = React.useCallback(() => {
        return Object.entries(devices)
            .filter(([_, d]) => d.status === 'connected')
            .map(([portName]) => deviceApisRef.current[portName])
            .filter(api => api?.isConnected());
    }, [devices]);
    const isConnected = Object.values(devices).some(d => d.status === 'connected');

    const PAD_SIZE = 200;
    const CENTER = PAD_SIZE / 2;
    const NEUTRAL_RADIUS = 30;

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const getNoteName = React.useCallback((note) => {
        const octave = Math.floor(note / 12) - 1;
        return `${noteNames[note % 12]}${octave}`;
    }, []);

    const getNextNote = React.useCallback(() => {
        const note = MELODY[melodyIndexRef.current];
        melodyIndexRef.current = (melodyIndexRef.current + 1) % MELODY.length;
        return note;
    }, []);

    const positionToValues = React.useCallback((x, y) => {
        const dx = x - CENTER;
        const dy = y - CENTER;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy);

        if (distFromCenter <= NEUTRAL_RADIUS) {
            return { bend: 0, pressure: 0.5 };
        }

        const bend = ((x / PAD_SIZE) * 2) - 1;
        const pressure = y / PAD_SIZE;
        return {
            bend: Math.max(-1, Math.min(1, bend)),
            pressure: Math.max(0, Math.min(1, pressure))
        };
    }, [PAD_SIZE, CENTER, NEUTRAL_RADIUS]);

    const valuesToPosition = React.useCallback((bend, pressure) => {
        const x = ((bend + 1) / 2) * PAD_SIZE;
        const y = pressure * PAD_SIZE;
        return { x, y };
    }, [PAD_SIZE]);

    const drawPad = React.useCallback((notes = []) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, PAD_SIZE, PAD_SIZE);

        ctx.strokeStyle = '#c0c0c0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(CENTER, 0);
        ctx.lineTo(CENTER, PAD_SIZE);
        ctx.moveTo(0, CENTER);
        ctx.lineTo(PAD_SIZE, CENTER);
        ctx.stroke();

        ctx.strokeStyle = '#808080';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, NEUTRAL_RADIUS, 0, Math.PI * 2);
        ctx.stroke();

        notes.forEach(({ note, bend, pressure, colorIndex }) => {
            const { x, y } = valuesToPosition(bend, pressure);
            const color = NOTE_COLORS[colorIndex % NOTE_COLORS.length];
            const noteName = getNoteName(note);

            ctx.shadowColor = color;
            ctx.shadowBlur = 15;
            ctx.fillStyle = color;
            ctx.font = 'bold 16px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(noteName, x, y);
            ctx.shadowBlur = 0;
        });
    }, [PAD_SIZE, CENTER, NEUTRAL_RADIUS, valuesToPosition, getNoteName]);

    React.useEffect(() => {
        drawPad();
    }, [drawPad]);

    React.useEffect(() => {
        drawPad(Array.from(activeNotes.values()));
    }, [activeNotes, drawPad]);

    // Send MPE config to all connected devices
    React.useEffect(() => {
        if (!mpeEnabled || !isConnected) return;
        const apis = getOutputApis();
        if (apis.length === 0) return;
        const msg = new Uint8Array([0xB0, 0x7F, 15]);
        apis.forEach(api => api.sendRaw(msg));
        if (loggingEnabled) addLog('TX: MPE Config [B0 7F 0F] - 15 member channels');
    }, [isConnected, getOutputApis, mpeEnabled, loggingEnabled, addLog]);

    // Subscribe to all-input MIDI events for the monitor
    React.useEffect(() => {
        if (!midiState) return;

        const unsubscribe = midiState.subscribe((eventType, data) => {
            // Handle routed notes (from controller->synth through) for pad display
            if (eventType === 'noteOn') {
                setActiveNotes(prev => {
                    const next = new Map(prev);
                    const colorIndex = colorIndexRef.current++;
                    next.set(data.channel, {
                        note: data.note,
                        velocity: data.velocity,
                        bend: 0,
                        pressure: 0.5,
                        colorIndex
                    });
                    return next;
                });
            } else if (eventType === 'noteOff') {
                setActiveNotes(prev => {
                    const next = new Map(prev);
                    next.delete(data.channel);
                    return next;
                });
            } else if (eventType === 'bend') {
                setActiveNotes(prev => {
                    const existing = prev.get(data.channel);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(data.channel, { ...existing, bend: data.bend });
                    return next;
                });
            } else if (eventType === 'pressure') {
                setActiveNotes(prev => {
                    const existing = prev.get(data.channel);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(data.channel, { ...existing, pressure: data.pressure });
                    return next;
                });
            } else if (eventType === 'reset') {
                setActiveNotes(new Map());
            }

            // All-input events for MIDI monitor (only when logging enabled)
            if (loggingEnabled && eventType.startsWith('all')) {
                const time = new Date().toLocaleTimeString([], { hour12: false });
                let desc = '';
                if (eventType === 'allNoteOn') {
                    desc = `NoteOn ${data.note} vel=${Math.round(data.velocity * 127)} ch${data.channel}`;
                } else if (eventType === 'allNoteOff') {
                    desc = `NoteOff ${data.note} ch${data.channel}`;
                } else if (eventType === 'allBend') {
                    desc = `Bend ${data.bend.toFixed(2)} ch${data.channel}`;
                } else if (eventType === 'allPressure') {
                    desc = `Pres ${Math.round(data.pressure * 127)} ch${data.channel}`;
                } else if (eventType === 'allCC') {
                    desc = `CC${data.cc}=${data.value} ch${data.channel}`;
                }
                if (desc) {
                    setMidiMonitor(prev => [...prev.slice(-29), {
                        time,
                        source: data.source,
                        desc
                    }]);
                }
            }
        });

        return unsubscribe;
    }, [midiState, loggingEnabled]);

    // Auto-scroll monitor
    React.useEffect(() => {
        if (monitorScrollRef.current) {
            monitorScrollRef.current.scrollTop = monitorScrollRef.current.scrollHeight;
        }
    }, [midiMonitor]);

    const handleMouseDown = React.useCallback((e) => {
        if (!isConnected) return;
        const apis = getOutputApis();
        if (apis.length === 0) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { bend, pressure } = positionToValues(x, y);
        const note = getNextNote();

        const channel = mpeEnabled ? mpeAllocatorRef.current.allocate(note) : 0;
        currentChannelRef.current = channel;
        mouseNoteRef.current = note;
        playingRef.current = true;

        setActiveNotes(prev => {
            const next = new Map(prev);
            const colorIndex = colorIndexRef.current++;
            next.set(channel, { note, bend, pressure, colorIndex });
            return next;
        });

        setHideCursor(true);
        lastSendTimeRef.current = performance.now();
        lastBendRef.current = bend;
        lastPressureRef.current = pressure;

        apis.forEach(api => {
            api.sendPitchBend(channel, bend);
            api.sendChannelPressure(channel, pressure);
            api.sendNoteOn(channel, note, velocity);
        });

        if (loggingEnabled) {
            const vel7 = Math.round(velocity * 127);
            const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
            addLog(`TX: Note On note=${note} vel=${vel7}${mpeInfo}`);
        }
    }, [isConnected, getOutputApis, velocity, positionToValues, getNextNote, mpeEnabled, loggingEnabled, addLog]);

    const handleMouseMove = React.useCallback((e) => {
        if (!playingRef.current) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { bend, pressure } = positionToValues(x, y);
        const channel = currentChannelRef.current;

        setActiveNotes(prev => {
            const existing = prev.get(channel);
            if (!existing) return prev;
            const next = new Map(prev);
            next.set(channel, { ...existing, bend, pressure });
            return next;
        });

        const now = performance.now();
        const elapsed = now - lastSendTimeRef.current;
        const bendDelta = Math.abs(bend - lastBendRef.current);
        const pressureDelta = Math.abs(pressure - lastPressureRef.current);

        const shouldSend = elapsed >= THROTTLE_INTERVAL_MS &&
                          (bendDelta >= CHANGE_THRESHOLD || pressureDelta >= CHANGE_THRESHOLD);

        if (shouldSend) {
            const apis = getOutputApis();
            apis.forEach(api => {
                api.sendPitchBend(channel, bend);
                api.sendChannelPressure(channel, pressure);
            });
            lastSendTimeRef.current = now;
            lastBendRef.current = bend;
            lastPressureRef.current = pressure;
        }
    }, [getOutputApis, positionToValues]);

    const handleMouseUp = React.useCallback(() => {
        if (!playingRef.current) return;

        const channel = currentChannelRef.current;
        const note = mouseNoteRef.current;

        getOutputApis().forEach(api => api.sendNoteOff(channel, note, 0));

        if (mpeEnabled) {
            mpeAllocatorRef.current.release(note);
        }

        setActiveNotes(prev => {
            const next = new Map(prev);
            next.delete(channel);
            return next;
        });

        setHideCursor(false);

        if (loggingEnabled) {
            const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
            addLog(`TX: Note Off note=${note}${mpeInfo}`);
        }

        playingRef.current = false;
        mouseNoteRef.current = null;
    }, [getOutputApis, mpeEnabled, loggingEnabled, addLog]);

    React.useEffect(() => {
        const handleGlobalMouseUp = () => {
            if (playingRef.current) {
                handleMouseUp();
            }
        };
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, [handleMouseUp]);

    const currentNote = Array.from(activeNotes.values())[0];

    // Source colors for MIDI monitor
    const sourceColors = {};
    let colorIdx = 0;
    const MONITOR_COLORS = ['#d4a574', '#b8a0d2', '#92cc41', '#209cee', '#f7d51d', '#e76e55'];

    return (
        <div className="ap-expression-pad">
            <div className="ap-pad-controls" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="ap-velocity-control">
                    <span>Velocity</span>
                    <input
                        type="range"
                        className="ap-slider"
                        min="0"
                        max="1"
                        step="0.01"
                        value={velocity}
                        onChange={(e) => setVelocity(parseFloat(e.target.value))}
                        disabled={!isConnected}
                    />
                    <span className="ap-velocity-value">{Math.round(velocity * 127)}</span>
                </div>
                <div className="ap-mpe-toggle">
                    <input
                        type="checkbox"
                        id="ap-mpe-checkbox"
                        checked={mpeEnabled}
                        onChange={(e) => {
                            const enabled = e.target.checked;
                            setMpeEnabled(enabled);
                            mpeAllocatorRef.current.reset();
                            const apis = getOutputApis();
                            if (apis.length > 0) {
                                const value = enabled ? 15 : 0;
                                const msg = new Uint8Array([0xB0, 0x7F, value]);
                                apis.forEach(api => api.sendRaw(msg));
                                if (loggingEnabled) addLog(`TX: MPE Config - ${enabled ? 'enabled' : 'disabled'}`);
                            }
                        }}
                        disabled={!isConnected}
                    />
                    <label htmlFor="ap-mpe-checkbox">MPE</label>
                </div>
            </div>

            <div className="ap-pad-canvas-container">
                <canvas
                    ref={canvasRef}
                    width={PAD_SIZE}
                    height={PAD_SIZE}
                    className="ap-pad-canvas"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    style={{ cursor: hideCursor ? 'none' : (isConnected ? 'crosshair' : 'not-allowed') }}
                />
            </div>

            <div className="ap-pad-labels">
                <span>Vel: {Math.round((currentNote?.velocity ?? 0) * 127)}</span>
                <span>Bend: {(currentNote?.bend ?? 0).toFixed(2)}</span>
                <span>Pres: {Math.round((currentNote?.pressure ?? 0.5) * 100)}%</span>
            </div>

            <div className="ap-pad-note">
                {activeNotes.size > 0 ? (
                    <span className="ap-note-playing">
                        {Array.from(activeNotes.values()).map(n => getNoteName(n.note)).join(' ')}
                    </span>
                ) : (
                    <span className="ap-note-waiting">{isConnected ? 'Click pad' : 'Not connected'}</span>
                )}
            </div>

            {/* Log toggle + MIDI Monitor */}
            <div className="ap-mpe-toggle" style={{ padding: '4px 8px' }}>
                <input
                    type="checkbox"
                    id="ap-log-checkbox"
                    checked={loggingEnabled}
                    onChange={(e) => {
                        setLoggingEnabled(e.target.checked);
                        if (!e.target.checked) setMidiMonitor([]);
                    }}
                />
                <label htmlFor="ap-log-checkbox">Log</label>
            </div>
            <div className="ap-pad-monitor" ref={monitorScrollRef}>
                {midiMonitor.length === 0 ? (
                    <span className="ap-text-muted">MIDI monitor</span>
                ) : (
                    midiMonitor.map((entry, i) => {
                        if (!sourceColors[entry.source]) {
                            sourceColors[entry.source] = MONITOR_COLORS[colorIdx++ % MONITOR_COLORS.length];
                        }
                        return (
                            <div key={i} className="ap-monitor-entry">
                                <span className="ap-monitor-source" style={{ color: sourceColors[entry.source] }}>
                                    {entry.source.split(' ')[0]}
                                </span>
                                {' '}
                                <span className="ap-monitor-desc">{entry.desc}</span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
