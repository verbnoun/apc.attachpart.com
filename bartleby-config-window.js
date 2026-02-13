/**
 * Bartleby Config Window - Tabbed configuration interface
 *
 * Tabs: Curves, Pots, Pedal, Screen
 * Each tab contains its settings section.
 * Changes auto-save to device via existing debounce behavior.
 */

const { useState, useEffect, useCallback, useRef } = React;

//======================================================================
// BARTLEBY CONFIG WINDOW
//======================================================================

function BartlebyConfigWindow({ config, saveStatus, deviceInfo, onConfigChange, onSave, midiState }) {
    const [activeTab, setActiveTab] = useState('curves');

    if (!config) {
        return (
            <div className="ap-bartleby-loading">
                <p>Loading config...</p>
            </div>
        );
    }

    return (
        <div className="ap-bartleby-config">
            {/* Header with save status */}
            <div className="ap-bartleby-header">
                <SaveStatusIndicator status={saveStatus} onSave={onSave} />
                {deviceInfo && (
                    <span className="ap-bartleby-version">v{deviceInfo.version}</span>
                )}
            </div>

            {/* Tab bar */}
            <div className="ap-tabs">
                <TabButton id="curves" label="CURVES" activeTab={activeTab} onClick={setActiveTab} />
                <TabButton id="pots" label="POTS" activeTab={activeTab} onClick={setActiveTab} />
                <TabButton id="pedal" label="PEDAL" activeTab={activeTab} onClick={setActiveTab} />
                <TabButton id="screen" label="SCREEN" activeTab={activeTab} onClick={setActiveTab} />
            </div>

            {/* Tab content */}
            <div className="ap-bartleby-content">
                {activeTab === 'curves' && (
                    <CurvesTab config={config} onConfigChange={onConfigChange} midiState={midiState} />
                )}
                {activeTab === 'pots' && (
                    <PotsTab config={config} onConfigChange={onConfigChange} />
                )}
                {activeTab === 'pedal' && (
                    <PedalTab config={config} onConfigChange={onConfigChange} />
                )}
                {activeTab === 'screen' && (
                    <ScreenTab config={config} onConfigChange={onConfigChange} />
                )}
            </div>
        </div>
    );
}

//======================================================================
// TAB COMPONENTS
//======================================================================

function TabButton({ id, label, activeTab, onClick }) {
    return (
        <button
            className={`ap-tab ${activeTab === id ? 'active' : ''}`}
            onClick={() => onClick(id)}
        >
            {label}
        </button>
    );
}

function SaveStatusIndicator({ status, onSave }) {
    const statusClass = {
        'saved': 'ap-text-success',
        'saving': 'ap-text-warning',
        'unsaved': 'ap-text-danger'
    }[status] || 'ap-text-success';

    const statusText = {
        'saved': 'SAVED',
        'saving': 'SAVING...',
        'unsaved': 'UNSAVED'
    }[status] || 'SAVED';

    return (
        <div className="ap-save-status">
            <span className={statusClass}>{statusText}</span>
            {status === 'unsaved' && (
                <button className="ap-btn ap-btn-small" onClick={onSave}>Save Now</button>
            )}
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
                color="var(--ap-accent-green)"
                onChange={(axis, value) => handleCurveChange('velocity', axis, value)}
                midiState={midiState}
            />
            <CurveEditor
                label="Pressure"
                curve={keyboard.pressure || { x: 0.5, y: 0.5 }}
                color="var(--ap-accent-blue)"
                onChange={(axis, value) => handleCurveChange('pressure', axis, value)}
            />
            <CurveEditor
                label="Bend"
                curve={keyboard.bend || { x: 0.5, y: 0.5 }}
                color="var(--ap-accent-yellow)"
                onChange={(axis, value) => handleCurveChange('bend', axis, value)}
            />
        </div>
    );
}

//======================================================================
// CURVE EDITOR
//======================================================================

function CurveEditor({ label, curve, color, onChange, midiState }) {
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
                // Keep last 10
                if (velocityDotsRef.current.length > 10) {
                    velocityDotsRef.current.shift();
                }
                setDrawTrigger(prev => prev + 1);
            }
        });

        return unsubscribe;
    }, [midiState]);

    // Draw canvas function
    const drawCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        // Clear with dark background
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = '#2a2a3e';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
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

        // Linear reference
        ctx.strokeStyle = '#3a3a4e';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bezier curve
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, h);
        const cpX = editX * w;
        const cpY = h - editY * h;
        ctx.quadraticCurveTo(cpX, cpY, w, 0);
        ctx.stroke();

        // Control point
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cpX, cpY, 6, 0, Math.PI * 2);
        ctx.fill();

        // Velocity dots (fade trail)
        const now = performance.now();
        const DOT_LIFETIME = 2000;
        velocityDotsRef.current = velocityDotsRef.current.filter(dot => now - dot.timestamp < DOT_LIFETIME);

        for (const dot of velocityDotsRef.current) {
            const age = now - dot.timestamp;
            const alpha = 1 - age / DOT_LIFETIME;
            const outputY = evaluateQuadraticBezierY(dot.input, editX, editY);
            const dotX = dot.input * w;
            const dotY = h - outputY * h;

            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // Border
        ctx.strokeStyle = '#adafbc';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, w, h);
    }, [editX, editY, color]);

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
            <div className="ap-curve-header">
                <span className="ap-curve-label" style={{ color }}>{label}</span>
            </div>
            <canvas ref={canvasRef} width="180" height="80" className="ap-curve-canvas" />
            <div className="ap-curve-sliders">
                <div className="ap-curve-slider">
                    <span>X</span>
                    <input
                        type="range"
                        className="ap-slider"
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
                    <span>Y</span>
                    <input
                        type="range"
                        className="ap-slider"
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
        </div>
    );
}

//======================================================================
// POTS TAB
//======================================================================

function PotsTab({ config, onConfigChange }) {
    const pots = config.pots || [];

    const handlePotChange = (index, field, value) => {
        const newPots = [...pots];
        newPots[index] = { ...newPots[index], [field]: value };
        onConfigChange({ pots: newPots });
    };

    return (
        <div className="ap-pots-tab">
            <div className="ap-pots-grid">
                {pots.map((pot, i) => (
                    <PotCard
                        key={i}
                        index={i}
                        pot={pot}
                        onChange={(field, value) => handlePotChange(i, field, value)}
                    />
                ))}
            </div>
        </div>
    );
}

function PotCard({ index, pot, onChange }) {
    const isActive = pot.active;

    return (
        <div className={`ap-pot-card ${!isActive ? 'inactive' : ''}`}>
            <div className="ap-pot-header">
                <span className="ap-pot-index">#{index}</span>
                <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => onChange('active', e.target.checked)}
                />
            </div>
            <input
                type="text"
                className="ap-input ap-pot-label"
                value={pot.label || ''}
                maxLength={11}
                placeholder="Label"
                onChange={(e) => onChange('label', e.target.value)}
            />
            <div className="ap-pot-cc">
                <span>CC:</span>
                <input
                    type="number"
                    className="ap-input ap-pot-cc-input"
                    min="0"
                    max="127"
                    value={pot.cc}
                    onChange={(e) => onChange('cc', parseInt(e.target.value) || 0)}
                />
            </div>
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
