/**
 * Bartleby Config Windows
 *
 * Each config section (Curves, Dials, Pedal, Screen) opens as a separate window.
 * ConfigSectionWindow renders a single section. Save status shown in window info bar.
 * Changes auto-save to device via existing debounce behavior.
 */

const { useState, useEffect, useCallback, useRef } = React;

//======================================================================
// CONFIG SECTION WINDOW (one per section)
//======================================================================

function ConfigSectionWindow({ config, onConfigChange, midiState, portName, section }) {
    if (!config) {
        return (
            <div className="ap-bartleby-loading">
                <p>Loading config...</p>
            </div>
        );
    }

    return (
        <div className="ap-bartleby-config">
            <div className="ap-bartleby-content">
                {section === 'curves' && (
                    <CurvesTab config={config} onConfigChange={onConfigChange} midiState={midiState} />
                )}
                {section === 'dials' && (
                    <DialsPanel config={config} onConfigChange={onConfigChange} midiState={midiState} portName={portName} />
                )}
                {section === 'pedal' && (
                    <PedalTab config={config} onConfigChange={onConfigChange} />
                )}
                {section === 'screen' && (
                    <ScreenTab config={config} onConfigChange={onConfigChange} />
                )}
            </div>
        </div>
    );
}

//======================================================================
// CURVES TAB
//======================================================================

function CurvesTab({ config, onConfigChange, midiState }) {
    const keyboard = config.keyboard || {};

    const handleCurveChange = (curveType, axis, value) => {
        const newKeyboard = {
            ...keyboard,
            [curveType]: {
                ...keyboard[curveType],
                [axis]: parseFloat(value)
            }
        };
        onConfigChange({ keyboard: newKeyboard });
    };

    return (
        <div className="ap-curves-tab">
            <CurveEditor
                label="Velocity"
                curve={keyboard.velocity || { x: 0.5, y: 0.5 }}
                onChange={(axis, value) => handleCurveChange('velocity', axis, value)}
                midiState={midiState}
            />
            <CurveEditor
                label="Pressure"
                curve={keyboard.pressure || { x: 0.5, y: 0.5 }}
                onChange={(axis, value) => handleCurveChange('pressure', axis, value)}
            />
            <CurveEditor
                label="Bend"
                curve={keyboard.bend || { x: 0.5, y: 0.5 }}
                onChange={(axis, value) => handleCurveChange('bend', axis, value)}
            />
        </div>
    );
}

//======================================================================
// CURVE EDITOR
//======================================================================

function CurveEditor({ label, curve, onChange, midiState }) {
    const canvasRef = useRef(null);
    const [editX, setEditX] = useState(curve.x);
    const [editY, setEditY] = useState(curve.y);
    const velocityDotsRef = useRef([]);
    const animFrameRef = useRef(null);
    const [drawTrigger, setDrawTrigger] = useState(0);

    // Sync with external curve
    useEffect(() => {
        setEditX(curve.x);
        setEditY(curve.y);
    }, [curve.x, curve.y]);

    // Subscribe to MidiState for velocity dots
    useEffect(() => {
        if (!midiState) return;

        const unsubscribe = midiState.subscribe((eventType, data) => {
            if (eventType === 'noteOn') {
                velocityDotsRef.current.push({
                    input: data.velocity,
                    timestamp: performance.now()
                });
                if (velocityDotsRef.current.length > 10) {
                    velocityDotsRef.current.shift();
                }
                setDrawTrigger(prev => prev + 1);
            }
        });

        return unsubscribe;
    }, [midiState]);

    // Draw canvas — B&W pixel art style
    const drawCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        // White background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        // Grid — black dotted lines
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 3]);
        for (let i = 1; i < 4; i++) {
            const x = (w / 4) * i;
            const y = (h / 4) * i;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // Linear reference — black dashed
        ctx.strokeStyle = '#808080';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bezier curve — black
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, h);
        const cpX = editX * w;
        const cpY = h - editY * h;
        ctx.quadraticCurveTo(cpX, cpY, w, 0);
        ctx.stroke();

        // Control point — black filled
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.arc(cpX, cpY, 5, 0, Math.PI * 2);
        ctx.fill();

        // Velocity dots — fade via size (not alpha)
        const now = performance.now();
        const DOT_LIFETIME = 2000;
        velocityDotsRef.current = velocityDotsRef.current.filter(dot => now - dot.timestamp < DOT_LIFETIME);

        for (const dot of velocityDotsRef.current) {
            const age = now - dot.timestamp;
            const sizeFactor = 1 - age / DOT_LIFETIME;
            const radius = Math.max(1, 4 * sizeFactor);
            const outputY = evaluateQuadraticBezierY(dot.input, editX, editY);
            const dotX = dot.input * w;
            const dotY = h - outputY * h;

            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.arc(dotX, dotY, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        // Border — black
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, w, h);
    }, [editX, editY]);

    // Draw on state changes
    useEffect(() => {
        drawCanvas();
    }, [drawCanvas, drawTrigger]);

    // Animation loop for fading dots
    useEffect(() => {
        if (!midiState || velocityDotsRef.current.length === 0) return;

        const animate = () => {
            drawCanvas();
            if (velocityDotsRef.current.length > 0) {
                animFrameRef.current = requestAnimationFrame(animate);
            }
        };
        animFrameRef.current = requestAnimationFrame(animate);

        return () => {
            if (animFrameRef.current) {
                cancelAnimationFrame(animFrameRef.current);
            }
        };
    }, [drawTrigger, midiState, drawCanvas]);

    const handleCommit = (axis, value) => {
        onChange(axis, value);
    };

    return (
        <div className="ap-curve-editor">
            <div className="ap-curve-label">{label}</div>
            <div className="ap-curve-body">
                <div className="ap-curve-sliders">
                    <div className="ap-curve-slider">
                        <span className="ap-curve-slider-label">Shape</span>
                        <input
                            type="range"
                            min="0.01"
                            max="0.99"
                            step="0.01"
                            value={editX}
                            onChange={(e) => setEditX(parseFloat(e.target.value))}
                            onMouseUp={(e) => handleCommit('x', parseFloat(e.target.value))}
                            onTouchEnd={() => handleCommit('x', editX)}
                        />
                        <span className="ap-curve-value">{editX.toFixed(2)}</span>
                    </div>
                    <div className="ap-curve-slider">
                        <span className="ap-curve-slider-label">Response</span>
                        <input
                            type="range"
                            min="0.01"
                            max="0.99"
                            step="0.01"
                            value={editY}
                            onChange={(e) => setEditY(parseFloat(e.target.value))}
                            onMouseUp={(e) => handleCommit('y', parseFloat(e.target.value))}
                            onTouchEnd={() => handleCommit('y', editY)}
                        />
                        <span className="ap-curve-value">{editY.toFixed(2)}</span>
                    </div>
                </div>
                <canvas ref={canvasRef} width="180" height="150" className="ap-curve-canvas" />
            </div>
        </div>
    );
}

//======================================================================
// DIALS PANEL — Hardware layout representation
//======================================================================

// Display-to-pot mapping matching firmware (pot_registry.cpp DISPLAY_POT_MAP)
// Each display has 4 pots in corner positions: [TL, TR, BL, BR]
const DISPLAY_POT_MAP = [
    { display: 1, pots: [15, 14, 0, 1] },
    { display: 2, pots: [13, 12, 2, 3] },
    { display: 3, pots: [11, 10, 4, 5] },
    { display: 4, pots: [9, 8, 6, 7] }
];

function DialsPanel({ config, onConfigChange, midiState, portName }) {
    const pots = config.pots || [];
    const [ccValues, setCcValues] = useState({});
    const [controllerStatus, setControllerStatus] = useState({ octave: 0, sustain: false });
    const [valueFeedbackTrigger, setValueFeedbackTrigger] = useState(0);
    const [potMap, setPotMap] = useState(null);  // from exchange, overrides config.pots

    useEffect(() => {
        if (!midiState || !portName) return;

        // Initialize from current state
        const status = midiState.getControllerStatus(portName);
        setControllerStatus(status);

        const surface = midiState.getControlSurface();
        if (surface) setPotMap(surface);

        const initialCc = {};
        for (const pot of pots) {
            if (pot && pot.active && pot.cc !== undefined) {
                const val = midiState.getCCValue(portName, pot.cc);
                if (val !== null) initialCc[pot.cc] = val;
            }
        }
        setCcValues(initialCc);

        const unsubscribe = midiState.subscribe((eventType, data) => {
            if (eventType === 'allCC' && data.source === portName) {
                setCcValues(prev => ({ ...prev, [data.cc]: data.value }));
            } else if (eventType === 'controllerStatus' && data.portName === portName) {
                setControllerStatus({ octave: data.octave, sustain: data.sustain });
            } else if (eventType === 'valueFeedback') {
                setValueFeedbackTrigger(prev => prev + 1);
            } else if (eventType === 'controlSurface') {
                setPotMap(data);
            }
        });

        return unsubscribe;
    }, [midiState, portName]);

    // Merge: exchange data overrides config pots
    const effectivePots = pots.map((configPot, id) => {
        const surfacePot = potMap?.[id];
        return surfacePot || configPot;
    });

    return (
        <div className="ap-dials-panel">
            <OledStatus status={controllerStatus} />
            {DISPLAY_POT_MAP.map(group => (
                <PotGroup key={group.display} group={group} pots={effectivePots}
                    ccValues={ccValues} midiState={midiState} />
            ))}
        </div>
    );
}

function OledStatus({ status }) {
    const octave = status.octave;
    const octaveStr = octave > 0 ? `+${octave}` : `${octave}`;
    return (
        <div className="ap-oled-panel ap-oled-status">
            <span className="ap-oled-title">BARTLEBY</span>
            <span className="ap-oled-line">{`OCT: ${octaveStr}`}</span>
            <span className="ap-oled-line">{`SUSTAIN: ${status.sustain ? 'ON' : 'OFF'}`}</span>
        </div>
    );
}

function OledControl({ pots, ccValues, midiState }) {
    return (
        <div className="ap-oled-panel ap-oled-control">
            <div className="ap-oled-grid">
                {pots.map((pot, i) => {
                    const fillPct = pot.active && ccValues[pot.cc] !== undefined
                        ? (ccValues[pot.cc] / 127) * 100
                        : 0;
                    const feedback = pot.active && midiState
                        ? midiState.getValueFeedback(pot.cc)
                        : null;
                    return (
                        <div key={i} className={`ap-oled-corner ${!pot.active ? 'inactive' : ''}`}>
                            <span className="ap-oled-label">{pot.label || `CC ${pot.cc}`}</span>
                            <div className="ap-oled-bar">
                                <div className="ap-oled-bar-fill" style={{ width: `${fillPct}%` }} />
                            </div>
                            {feedback && (
                                <span className="ap-oled-value-text">{feedback.displayText}</span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function PotGroup({ group, pots, ccValues, midiState }) {
    const groupPots = group.pots.map(id => ({
        ...pots[id],
        potId: id
    }));

    return (
        <div className="ap-pot-group">
            <OledControl pots={groupPots} ccValues={ccValues} midiState={midiState} />
            <PotCluster pots={groupPots} ccValues={ccValues} />
        </div>
    );
}

function PotCluster({ pots, ccValues }) {
    // pots in TL, TR, BL, BR order — maps to 2x2 grid naturally
    return (
        <div className="ap-pot-cluster">
            {pots.map(pot => (
                <PotKnob key={pot.potId} pot={pot} ccValue={ccValues[pot.cc]} />
            ))}
        </div>
    );
}

function PotKnob({ pot, ccValue }) {
    const label = pot.label || `CC ${pot.cc}`;
    // 6 o'clock (180°) at 0, 4 o'clock (480°/120°) at 127 — 300° sweep
    const angle = ccValue !== undefined ? 180 + (ccValue / 127) * 300 : 180;
    return (
        <div className={`ap-pot-knob ${!pot.active ? 'inactive' : ''}`}>
            <div className="ap-pot-knob-circle">
                <div className="ap-pot-knob-tick" style={{ transform: `rotate(${angle}deg)` }} />
            </div>
            <span className="ap-pot-knob-label">{label}</span>
        </div>
    );
}

//======================================================================
// PEDAL TAB
//======================================================================

function PedalTab({ config, onConfigChange }) {
    const pedal = config.pedal || { enables: 0 };
    const pressureEnabled = (pedal.enables & 0x01) !== 0;
    const bendEnabled = (pedal.enables & 0x02) !== 0;

    const handleEnableChange = (bit, enabled) => {
        let enables = pedal.enables;
        if (enabled) {
            enables |= bit;
        } else {
            enables &= ~bit;
        }
        onConfigChange({ pedal: { enables } });
    };

    return (
        <div className="ap-pedal-tab">
            <h3>Expression Pedal</h3>
            <p className="ap-text-muted ap-mb-md">
                When enabled, pressing pedal activates these messages. Pedal up = blocked.
            </p>

            <label className="ap-checkbox ap-mb-sm">
                <input
                    type="checkbox"
                    checked={pressureEnabled}
                    onChange={(e) => handleEnableChange(0x01, e.target.checked)}
                />
                <span>Enable Pressure</span>
            </label>

            <label className="ap-checkbox">
                <input
                    type="checkbox"
                    checked={bendEnabled}
                    onChange={(e) => handleEnableChange(0x02, e.target.checked)}
                />
                <span>Enable Pitch Bend</span>
            </label>
        </div>
    );
}

//======================================================================
// SCREEN TAB
//======================================================================

function ScreenTab({ config, onConfigChange }) {
    const screensaverEnabled = config.screensaver || false;

    return (
        <div className="ap-screen-tab">
            <h3>Display Settings</h3>

            <label className="ap-checkbox ap-mt-md">
                <input
                    type="checkbox"
                    checked={screensaverEnabled}
                    onChange={(e) => onConfigChange({ screensaver: e.target.checked })}
                />
                <span>Screensaver (auto-dim after idle)</span>
            </label>
        </div>
    );
}
