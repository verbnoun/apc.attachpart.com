/**
 * Node Widgets - Reusable components for patch editor nodes
 *
 * EnvelopeCurve — ADSR envelope SVG visualization
 * WaveIcon — Waveform type SVG icon
 * WaveSelector — Clickable waveform selector
 * EditableValue — Click-to-edit numeric value
 * PriorityBadge — Editable parameter priority indicator
 * VelocityCurvePreview — Velocity curve canvas with live dots
 * NodeParamSlider — Inline parameter slider with value feedback
 *
 * Depends on: React (useState, useEffect, useCallback, useRef),
 *             evaluateQuadraticBezierY (midi-state.js)
 */

const { useState: nwUseState, useEffect: nwUseEffect, useCallback: nwUseCallback, useRef: nwUseRef } = React;

//======================================================================
// ENVELOPE CURVE VISUALIZATION
//======================================================================

function EnvelopeCurve({ attack, decay, sustain, release, color, dashed = false }) {
    // Normalize times to fit in SVG viewBox (100 width)
    // Total time = attack + decay + hold (fixed 0.3s for visualization) + release
    const holdTime = 0.3;
    const totalTime = Math.max(0.01, attack + decay + holdTime + release);
    const scale = 100 / totalTime;

    // Calculate x positions
    const x1 = 0;                                    // Start
    const x2 = attack * scale;                       // Attack peak
    const x3 = (attack + decay) * scale;             // Decay end
    const x4 = (attack + decay + holdTime) * scale;  // Hold end
    const x5 = 100;                                  // Release end

    // Y positions (inverted: 0 = top = max, 100 = bottom = min)
    const y1 = 100;                   // Start at 0
    const y2 = 0;                     // Attack peak at max
    const y3 = 100 - sustain * 100;   // Sustain level
    const y4 = y3;                    // Hold at sustain
    const y5 = 100;                   // Release to 0

    const pathD = `M ${x1},${y1} L ${x2},${y2} L ${x3},${y3} L ${x4},${y4} L ${x5},${y5}`;

    return (
        <svg viewBox="0 0 100 100" className="ap-envelope-curve" preserveAspectRatio="none">
            <path
                d={pathD}
                stroke={color}
                strokeWidth={dashed ? 1.5 : 2.5}
                strokeDasharray={dashed ? "4,2" : "none"}
                fill="none"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

//======================================================================
// WAVE ICON COMPONENT
//======================================================================

function WaveIcon({ type }) {
    // Simple SVG paths for each wave type
    const paths = {
        'Sine': 'M 0,50 Q 25,0 50,50 Q 75,100 100,50',
        'Square': 'M 0,75 L 0,25 L 50,25 L 50,75 L 100,75 L 100,25',
        'Saw': 'M 0,75 L 50,25 L 50,75 L 100,25',
        'Triangle': 'M 0,50 L 25,25 L 75,75 L 100,50',
        'Noise': 'M 0,50 L 10,30 L 20,70 L 30,40 L 40,60 L 50,35 L 60,65 L 70,45 L 80,55 L 90,38 L 100,50',
        // Common variants
        'sine': 'M 0,50 Q 25,0 50,50 Q 75,100 100,50',
        'square': 'M 0,75 L 0,25 L 50,25 L 50,75 L 100,75 L 100,25',
        'saw': 'M 0,75 L 50,25 L 50,75 L 100,25',
        'triangle': 'M 0,50 L 25,25 L 75,75 L 100,50',
        'noise': 'M 0,50 L 10,30 L 20,70 L 30,40 L 40,60 L 50,35 L 60,65 L 70,45 L 80,55 L 90,38 L 100,50',
    };

    const path = paths[type] || paths['Sine'];

    return (
        <svg viewBox="0 0 100 100" className="ap-wave-icon">
            <path d={path} stroke="currentColor" fill="none" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
    );
}

//======================================================================
// WAVE SELECTOR COMPONENT
//======================================================================

function WaveSelector({ param, waves, onUpdateParam }) {
    // Local state for immediate visual feedback (same pattern as NodeParamSlider)
    const [localValue, setLocalValue] = nwUseState(Math.round(param.value));

    // Sync with external value changes (device round-trip)
    nwUseEffect(() => {
        setLocalValue(Math.round(param.value));
    }, [param.value]);

    // No waves from topology = don't render
    if (!waves || waves.length === 0) return null;

    return (
        <div className="ap-wave-selector">
            <div className="ap-wave-options">
                {waves.map(wave => (
                    <button
                        key={wave.id}
                        className={`ap-wave-btn ${wave.id === localValue ? 'active' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setLocalValue(wave.id);
                            onUpdateParam(param.key, wave.id);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        title={wave.name}
                    >
                        <WaveIcon type={wave.name} />
                    </button>
                ))}
            </div>
        </div>
    );
}

//======================================================================
// EDITABLE VALUE COMPONENT
//======================================================================

function EditableValue({ value, min, max, step, onCommit, formatValue }) {
    const [editing, setEditing] = nwUseState(false);
    const [editValue, setEditValue] = nwUseState(value.toString());
    const inputRef = nwUseRef(null);

    const handleClick = (e) => {
        e.stopPropagation();
        setEditing(true);
        setEditValue(value.toString());
    };

    const handleBlur = () => {
        const num = parseFloat(editValue);
        if (!isNaN(num)) {
            const clamped = Math.max(min, Math.min(max, num));
            onCommit(clamped);
        }
        setEditing(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleBlur();
        }
        if (e.key === 'Escape') {
            setEditing(false);
        }
    };

    nwUseEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.select();
        }
    }, [editing]);

    // Sync with external value when not editing
    nwUseEffect(() => {
        if (!editing) {
            setEditValue(value.toString());
        }
    }, [value, editing]);

    if (editing) {
        return (
            <input
                ref={inputRef}
                type="text"
                className="ap-node-param-edit"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                autoFocus
            />
        );
    }

    return (
        <span className="ap-node-param-value clickable" onClick={handleClick}>
            {formatValue(value)}
        </span>
    );
}

//======================================================================
// PRIORITY BADGE COMPONENT
//======================================================================

function PriorityBadge({ priority, paramKey, existingPriorities, onUpdatePriority }) {
    const [editing, setEditing] = nwUseState(false);
    const [editValue, setEditValue] = nwUseState(priority?.toString() || '');
    const [error, setError] = nwUseState(false);
    const inputRef = nwUseRef(null);

    const handleClick = (e) => {
        e.stopPropagation();
        setEditing(true);
        setError(false);
        setEditValue(priority?.toString() || '');
    };

    const handleBlur = () => {
        const num = parseInt(editValue, 10);
        // Validate: must be positive integer
        if (isNaN(num) || num <= 0) {
            setEditing(false);
            return;
        }
        // Skip if unchanged
        if (num === priority) {
            setEditing(false);
            return;
        }
        // Check for duplicate (exclude current param's own priority)
        if (existingPriorities?.has(num)) {
            setError(true);
            // Brief red flash, then close
            setTimeout(() => setEditing(false), 300);
            return;
        }
        onUpdatePriority(paramKey, num);
        setEditing(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleBlur();
        }
        if (e.key === 'Escape') {
            setEditing(false);
        }
    };

    nwUseEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.select();
        }
    }, [editing]);

    if (editing) {
        return (
            <input
                ref={inputRef}
                type="text"
                className={`ap-priority-edit ${error ? 'error' : ''}`}
                value={editValue}
                onChange={(e) => { setEditValue(e.target.value); setError(false); }}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                autoFocus
            />
        );
    }

    return (
        <span className="ap-priority-badge" onClick={handleClick} title="Priority (click to edit)">
            {priority || '?'}
        </span>
    );
}

//======================================================================
// VELOCITY CURVE PREVIEW (for VELOCITY node)
//======================================================================

function VelocityCurvePreview({ curve, midiState }) {
    const canvasRef = nwUseRef(null);
    const velocityDotsRef = nwUseRef([]);
    const animFrameRef = nwUseRef(null);
    const [drawTrigger, setDrawTrigger] = nwUseState(0);
    const resolvedColorRef = nwUseRef('#92cc41');

    // Resolve CSS variable for canvas drawing
    nwUseEffect(() => {
        const el = document.documentElement;
        const computed = getComputedStyle(el).getPropertyValue('--ap-accent-green').trim();
        if (computed) resolvedColorRef.current = computed;
    }, []);

    const cx = curve?.x ?? 0.5;
    const cy = curve?.y ?? 0.5;

    // Subscribe to MidiState for velocity dots
    nwUseEffect(() => {
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

    const drawCanvas = nwUseCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const color = resolvedColorRef.current;

        // Light background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        if (!curve) {
            // No config fallback
            ctx.fillStyle = '#808080';
            ctx.font = '8px "ChicagoFLF"';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('No config', w / 2, h / 2);
            return;
        }

        // 2x2 grid
        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
        ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
        ctx.stroke();

        // Linear reference (dashed)
        ctx.strokeStyle = '#c0c0c0';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(w, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bezier curve
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.quadraticCurveTo(cx * w, h - cy * h, w, 0);
        ctx.stroke();

        // Velocity dots (fade trail)
        const now = performance.now();
        const DOT_LIFETIME = 2000;
        velocityDotsRef.current = velocityDotsRef.current.filter(dot => now - dot.timestamp < DOT_LIFETIME);

        for (const dot of velocityDotsRef.current) {
            const age = now - dot.timestamp;
            const alpha = 1 - age / DOT_LIFETIME;
            const outputY = evaluateQuadraticBezierY(dot.input, cx, cy);
            const dotX = dot.input * w;
            const dotY = h - outputY * h;

            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }, [cx, cy, curve]);

    // Draw on state changes
    nwUseEffect(() => {
        drawCanvas();
    }, [drawCanvas, drawTrigger]);

    // Animation loop for fading dots
    nwUseEffect(() => {
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

    return (
        <canvas
            ref={canvasRef}
            width="120"
            height="60"
            className="ap-velocity-preview-canvas"
        />
    );
}

//======================================================================
// NODE PARAM SLIDER - Inline slider with local state
//======================================================================

function NodeParamSlider({ param, onUpdateParam, onLiveChange, midiState, deviceKey }) {
    const [localValue, setLocalValue] = nwUseState(param.value);
    const [displayText, setDisplayText] = nwUseState(null);
    const lastLiveSendRef = nwUseRef(0);

    // Sync with external value changes
    nwUseEffect(() => {
        setLocalValue(param.value);
    }, [param.value]);

    // Subscribe to value feedback for this param's UID (scoped by device)
    nwUseEffect(() => {
        if (!midiState || param.uid === undefined || !deviceKey) return;

        // Seed from current state
        const existing = midiState.getValueFeedback(deviceKey, param.uid);
        if (existing) setDisplayText(existing.displayText);

        const unsubscribe = midiState.subscribe((eventType, data) => {
            if (eventType === 'valueFeedback' && data.uid === param.uid && data.portName === deviceKey) {
                setDisplayText(data.displayText);
            }
        });
        return unsubscribe;
    }, [midiState, param.uid, deviceKey]);

    // Determine step size based on parameter type
    const getStep = () => {
        const range = param.max - param.min;

        // Small ranges (like 0-1, -1 to 1) need fine control
        if (range <= 2) {
            return 0.01;
        }

        // Medium ranges (like 0-10) get medium step
        if (range <= 20) {
            return 0.1;
        }

        // Large ranges (semitones, cents, frequency) get integer step
        return 1;
    };

    // Format display value — prefer synth-formatted display text
    const formatValue = (val) => {
        if (displayText) return displayText;
        const step = getStep();
        if (step >= 1) {
            return Math.round(val);
        } else if (step >= 0.1) {
            return val.toFixed(1);
        } else {
            return val.toFixed(2);
        }
    };

    const handleChange = (e) => {
        const newValue = parseFloat(e.target.value);
        setLocalValue(newValue);

        // Live CC send for params with CC assignment, throttled ~60Hz
        if (onLiveChange && param.cc >= 0) {
            const now = performance.now();
            if (now - lastLiveSendRef.current >= 16) {
                const normalized = (newValue - param.min) / (param.max - param.min);
                onLiveChange(param.cc, normalized);
                lastLiveSendRef.current = now;
            }
        }
    };

    const handleCommit = () => {
        if (onUpdateParam && localValue !== param.value) {
            onUpdateParam(param.key, localValue);
        }
    };

    // Handle direct value edit
    const handleValueCommit = (newValue) => {
        setLocalValue(newValue);
        if (onUpdateParam) {
            onUpdateParam(param.key, newValue);
        }
    };

    return (
        <>
            <input
                type="range"
                className="ap-node-param-slider"
                min={param.min}
                max={param.max}
                step={getStep()}
                value={localValue}
                onChange={handleChange}
                onMouseUp={handleCommit}
                onTouchEnd={handleCommit}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
            />
            <EditableValue
                value={localValue}
                min={param.min}
                max={param.max}
                step={getStep()}
                onCommit={handleValueCommit}
                formatValue={formatValue}
            />
        </>
    );
}
