/**
 * Bartleby Editor - UI Components (Display Layer)
 *
 * DISPLAY ONLY - No state management, no device communication
 *
 * Components receive config and callbacks from hooks layer.
 * This layer can be easily replaced with a different UI framework.
 *
 * Props pattern:
 *   config: Current config object
 *   onConfigChange: (partialConfig) => void
 *   disabled: boolean
 *   saveStatus: 'saved' | 'saving' | 'unsaved'
 */

const { useState, useEffect, useCallback, useRef } = React;

//======================================================================
// BARTLEBY EDITOR - Main Container
//======================================================================

/**
 * Main Bartleby editor component
 *
 * @param {Object} props
 *   config: Bartleby config object
 *   onConfigChange: (partial) => void
 *   onSave: () => void
 *   onUpdateFirmware: () => void (optional)
 *   onFactoryReset: () => void (optional)
 *   disabled: boolean
 *   saveStatus: 'saved' | 'saving' | 'unsaved'
 *   deviceInfo: { project, version } | null
 */
function BartlebyEditor({ config, onConfigChange, onSave, onUpdateFirmware, onFactoryReset, disabled, saveStatus, deviceInfo }) {
    if (!config) {
        return (
            <div className="bartleby-editor bartleby-loading">
                <h2>Bartleby</h2>
                <p>Initializing...</p>
            </div>
        );
    }

    return (
        <div className="bartleby-editor">
            <BartlebyHeader
                deviceInfo={deviceInfo}
                saveStatus={saveStatus}
                onSave={onSave}
                onUpdateFirmware={onUpdateFirmware}
                onFactoryReset={onFactoryReset}
                disabled={disabled}
            />

            <div className="bartleby-content">
                <BartlebyKeyboardSection
                    config={config}
                    onConfigChange={onConfigChange}
                    disabled={disabled}
                />

                <BartlebyPotsSection
                    config={config}
                    onConfigChange={onConfigChange}
                    disabled={disabled}
                />

                <BartlebyPedalSection
                    config={config}
                    onConfigChange={onConfigChange}
                    disabled={disabled}
                />

                <BartlebyScreensaverSection
                    config={config}
                    onConfigChange={onConfigChange}
                    disabled={disabled}
                />
            </div>
        </div>
    );
}

//======================================================================
// HEADER
//======================================================================

function BartlebyHeader({ deviceInfo, saveStatus, onSave, onUpdateFirmware, onFactoryReset, disabled }) {
    const saveButtonClass = {
        'saved': 'save-button-saved',
        'saving': 'save-button-saving',
        'unsaved': 'save-button-unsaved'
    }[saveStatus] || 'save-button-saved';

    const saveButtonText = {
        'saved': 'Saved',
        'saving': 'Saving...',
        'unsaved': 'Unsaved'
    }[saveStatus] || 'Saved';

    return (
        <div className="section-header bartleby-section-header">
            <h2>Bartleby</h2>
            <div className="section-controls">
                <button
                    className={saveButtonClass}
                    onClick={onSave}
                    disabled={disabled || saveStatus === 'saving'}
                >
                    {saveButtonText}
                </button>
                {deviceInfo && (
                    <span className="device-version">v{deviceInfo.version}</span>
                )}
                <button
                    onClick={onUpdateFirmware}
                    disabled={disabled || !onUpdateFirmware}
                >
                    Update Firmware
                </button>
                <button
                    onClick={onFactoryReset}
                    disabled={disabled || !onFactoryReset}
                    className="factory-reset-button"
                    title="Reset config to factory defaults (device will reboot)"
                >
                    Reset
                </button>
            </div>
        </div>
    );
}

//======================================================================
// KEYBOARD CURVES SECTION
//======================================================================

function BartlebyKeyboardSection({ config, onConfigChange, disabled }) {
    const keyboard = config.keyboard || {};

    const handleCurveChange = (curveType, axis, value) => {
        if (disabled) return;
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
        <div className="bartleby-section">
            <h3>Keyboard Curves</h3>

            <BartlebyCurveEditor
                label="Velocity"
                curve={keyboard.velocity || { x: 0.5, y: 0.5 }}
                onChange={(axis, value) => handleCurveChange('velocity', axis, value)}
                disabled={disabled}
            />

            <BartlebyCurveEditor
                label="Pressure"
                curve={keyboard.pressure || { x: 0.5, y: 0.5 }}
                onChange={(axis, value) => handleCurveChange('pressure', axis, value)}
                disabled={disabled}
            />

            <BartlebyCurveEditor
                label="Bend"
                curve={keyboard.bend || { x: 0.5, y: 0.5 }}
                onChange={(axis, value) => handleCurveChange('bend', axis, value)}
                disabled={disabled}
            />
        </div>
    );
}

//======================================================================
// CURVE EDITOR (Two-phase update: local → commit on release)
//======================================================================

function BartlebyCurveEditor({ label, curve, onChange, disabled }) {
    const canvasRef = useRef(null);

    // Local state for immediate feedback
    const [editX, setEditX] = useState(curve.x);
    const [editY, setEditY] = useState(curve.y);

    // Sync with external curve
    useEffect(() => {
        setEditX(curve.x);
        setEditY(curve.y);
    }, [curve.x, curve.y]);

    // Draw curve on canvas
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        // Clear
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = '#d0d0d0';
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

        // Linear reference line
        ctx.strokeStyle = '#c0c0c0';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bezier curve
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, h);

        const cpX = editX * w;
        const cpY = h - editY * h;
        ctx.quadraticCurveTo(cpX, cpY, w, 0);
        ctx.stroke();

        // Control point
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(cpX, cpY, 6, 0, Math.PI * 2);
        ctx.fill();

    }, [editX, editY]);

    // Commit on release
    const handleCommit = (axis, value) => {
        if (!disabled) {
            onChange(axis, value);
        }
    };

    return (
        <div className="bartleby-curve-group">
            <h4>{label}</h4>
            <div className="bartleby-curve-controls">
                <div className="bartleby-curve-control">
                    <label>X</label>
                    <input
                        type="range"
                        min="0.01"
                        max="0.99"
                        step="0.01"
                        value={editX}
                        disabled={disabled}
                        onChange={(e) => setEditX(parseFloat(e.target.value))}
                        onMouseUp={(e) => handleCommit('x', parseFloat(e.target.value))}
                        onTouchEnd={(e) => handleCommit('x', editX)}
                    />
                    <span className="bartleby-curve-value">{editX.toFixed(2)}</span>
                </div>
                <div className="bartleby-curve-control">
                    <label>Y</label>
                    <input
                        type="range"
                        min="0.01"
                        max="0.99"
                        step="0.01"
                        value={editY}
                        disabled={disabled}
                        onChange={(e) => setEditY(parseFloat(e.target.value))}
                        onMouseUp={(e) => handleCommit('y', parseFloat(e.target.value))}
                        onTouchEnd={(e) => handleCommit('y', editY)}
                    />
                    <span className="bartleby-curve-value">{editY.toFixed(2)}</span>
                </div>
            </div>
            <canvas ref={canvasRef} className="bartleby-curve-canvas" width="240" height="100"></canvas>
        </div>
    );
}

//======================================================================
// POTS SECTION
//======================================================================

function BartlebyPotsSection({ config, onConfigChange, disabled }) {
    const pots = config.pots || [];

    const handlePotChange = (index, field, value) => {
        if (disabled) return;
        const newPots = [...pots];
        newPots[index] = { ...newPots[index], [field]: value };
        onConfigChange({ pots: newPots });
    };

    return (
        <div className="bartleby-section">
            <h3>Pots (16)</h3>
            <div className="bartleby-pots-grid">
                {pots.map((pot, i) => (
                    <BartlebyPotCard
                        key={i}
                        index={i}
                        pot={pot}
                        onChange={(field, value) => handlePotChange(i, field, value)}
                        disabled={disabled}
                    />
                ))}
            </div>
        </div>
    );
}

function BartlebyPotCard({ index, pot, onChange, disabled }) {
    return (
        <div className={`bartleby-pot-card ${!pot.active ? 'inactive' : ''}`}>
            <div className="bartleby-pot-header">
                <span className="bartleby-pot-index">#{index}</span>
                <input
                    type="checkbox"
                    checked={pot.active}
                    disabled={disabled}
                    onChange={(e) => onChange('active', e.target.checked)}
                />
            </div>
            <input
                type="text"
                className="bartleby-pot-label"
                value={pot.label}
                maxLength={11}
                disabled={disabled}
                onChange={(e) => onChange('label', e.target.value)}
                placeholder="Label"
            />
            <div className="bartleby-pot-cc">
                <label>CC:</label>
                <input
                    type="number"
                    min="0"
                    max="127"
                    value={pot.cc}
                    disabled={disabled}
                    onChange={(e) => onChange('cc', parseInt(e.target.value) || 0)}
                />
            </div>
        </div>
    );
}

//======================================================================
// PEDAL SECTION
//======================================================================

function BartlebyPedalSection({ config, onConfigChange, disabled }) {
    const pedal = config.pedal || { enables: 0 };

    const handleEnableChange = (bit, enabled) => {
        if (disabled) return;
        let enables = pedal.enables;
        if (enabled) {
            enables |= bit;
        } else {
            enables &= ~bit;
        }
        onConfigChange({ pedal: { enables } });
    };

    const pressureEnabled = (pedal.enables & 0x01) !== 0;
    const bendEnabled = (pedal.enables & 0x02) !== 0;

    return (
        <div className="bartleby-section">
            <h3>Expression Pedal</h3>
            <div className="bartleby-pedal-options">
                <label className="bartleby-checkbox">
                    <input
                        type="checkbox"
                        checked={pressureEnabled}
                        disabled={disabled}
                        onChange={(e) => handleEnableChange(0x01, e.target.checked)}
                    />
                    <span>Enable Pressure</span>
                </label>
                <label className="bartleby-checkbox">
                    <input
                        type="checkbox"
                        checked={bendEnabled}
                        disabled={disabled}
                        onChange={(e) => handleEnableChange(0x02, e.target.checked)}
                    />
                    <span>Enable Pitch Bend</span>
                </label>
            </div>
            <p className="bartleby-description">
                When enabled, pressing pedal activates these messages. Pedal up = blocked.
            </p>
        </div>
    );
}

//======================================================================
// SCREENSAVER SECTION
//======================================================================

function BartlebyScreensaverSection({ config, onConfigChange, disabled }) {
    const enabled = config.screensaver || false;

    return (
        <div className="bartleby-section">
            <div className="bartleby-toggle-row">
                <span>Screensaver (auto-dim after idle)</span>
                <label className="bartleby-toggle">
                    <input
                        type="checkbox"
                        checked={enabled}
                        disabled={disabled}
                        onChange={(e) => onConfigChange({ screensaver: e.target.checked })}
                    />
                    <span className="bartleby-toggle-slider"></span>
                </label>
            </div>
        </div>
    );
}
