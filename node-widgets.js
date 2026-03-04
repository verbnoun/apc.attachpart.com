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

function WaveSelector({ param, waves, onUpdateParam, hasController, midiState }) {
    // Local state for immediate visual feedback (same pattern as NodeParamSlider)
    const [localValue, setLocalValue] = nwUseState(Math.round(param.value));
    const [playValue, setPlayValue] = nwUseState(null);

    // Sync with external value changes (device round-trip)
    nwUseEffect(() => {
        setLocalValue(Math.round(param.value));
    }, [param.value]);

    // Subscribe to CC traffic for play wave (only when controller connected)
    nwUseEffect(() => {
        if (!midiState || param.cc < 0 || !hasController) {
            setPlayValue(null);
            return;
        }
        const unsubscribe = midiState.subscribe((eventType, data) => {
            if (eventType === 'allCC' && data.cc === param.cc) {
                const normalized = data.value / 127;
                const absMin = param.absMin ?? 0;
                const absMax = param.absMax ?? (waves.length - 1);
                const val = Math.round(absMin + normalized * (absMax - absMin));
                setPlayValue(val);
            }
        });
        return unsubscribe;
    }, [midiState, param.cc, hasController, param.absMin, param.absMax]);

    // No waves from topology = don't render
    if (!waves || waves.length === 0) return null;

    return (
        <div className="ap-wave-selector">
            <div className="ap-wave-options">
                {waves.map(wave => {
                    const isDefault = wave.id === localValue;
                    const isPlaying = hasController && playValue !== null && wave.id === playValue;
                    const cls = `ap-wave-btn${isDefault ? ' active' : ''}${isPlaying ? ' playing' : ''}`;
                    return (
                        <button
                            key={wave.id}
                            className={cls}
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
                    );
                })}
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

function PriorityBadge({ priority, paramKey, priorityMap, onUpdatePriority, hasController, dialCount }) {
    const [open, setOpen] = nwUseState(false);
    const [editValue, setEditValue] = nwUseState('');
    const badgeRef = nwUseRef(null);
    const popoverRef = nwUseRef(null);
    const inputRef = nwUseRef(null);

    const isUnmapped = priority === -1 || priority >= 255;

    const handleBadgeClick = (e) => {
        e.stopPropagation();
        setOpen(!open);
        setEditValue('');
    };

    // Close on Escape or click-outside
    nwUseEffect(() => {
        if (!open) return;
        const handleKey = (e) => {
            if (e.key === 'Escape') setOpen(false);
        };
        const handleClickOutside = (e) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target) &&
                badgeRef.current && !badgeRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        window.addEventListener('keydown', handleKey);
        window.addEventListener('mousedown', handleClickOutside, true);
        return () => {
            window.removeEventListener('keydown', handleKey);
            window.removeEventListener('mousedown', handleClickOutside, true);
        };
    }, [open]);

    // Focus input when popover opens (if no controller, input is primary)
    nwUseEffect(() => {
        if (open && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [open]);

    const handleDialClick = (dialNum) => {
        if (dialNum === priority) {
            setOpen(false);
            return;
        }
        onUpdatePriority(paramKey, dialNum);
        setOpen(false);
    };

    const handleNoDial = () => {
        if (isUnmapped) {
            setOpen(false);
            return;
        }
        onUpdatePriority(paramKey, -1);
        setOpen(false);
    };

    const handleNumberSubmit = () => {
        const num = parseInt(editValue, 10);
        if (isNaN(num) || num <= 0) return;
        if (num === priority) {
            setOpen(false);
            return;
        }
        onUpdatePriority(paramKey, num);
        setOpen(false);
    };

    const handleInputKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleNumberSubmit();
        }
        if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    // Build dial rows
    const showDials = hasController && dialCount > 0;

    return (
        <span className="ap-priority-badge-wrapper" ref={badgeRef}>
            <span className={`ap-priority-badge ${isUnmapped ? 'unmapped' : ''}`} onClick={handleBadgeClick} title="Priority (click to edit)">
                {isUnmapped ? '\u2014' : (priority || '?')}
            </span>
            {open && (
                <div
                    className="ap-priority-popover"
                    ref={popoverRef}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    {showDials && (
                        <div className="ap-priority-dial-list">
                            {Array.from({ length: dialCount }, (_, i) => {
                                const dialNum = i + 1;
                                const occupant = priorityMap?.get(dialNum);
                                const isCurrent = dialNum === priority;
                                return (
                                    <div
                                        key={dialNum}
                                        className={`ap-priority-dial-row ${isCurrent ? 'current' : ''}`}
                                        onClick={() => handleDialClick(dialNum)}
                                    >
                                        <span className="ap-priority-dial-num">{dialNum}</span>
                                        <span className="ap-priority-dial-label">Dial {dialNum}</span>
                                        <span className="ap-priority-dial-occupant">
                                            {occupant ? occupant.name : '\u2014'}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {showDials && (
                        <div
                            className={`ap-priority-dial-row no-dial ${isUnmapped ? 'current' : ''}`}
                            onClick={handleNoDial}
                        >
                            <span className="ap-priority-dial-num">{'\u2014'}</span>
                            <span className="ap-priority-dial-label">No dial</span>
                        </div>
                    )}
                    {showDials && <div className="ap-priority-divider" />}
                    <div className="ap-priority-number-row">
                        <input
                            ref={inputRef}
                            type="text"
                            className="ap-priority-edit"
                            value={editValue}
                            placeholder={isUnmapped ? '' : (priority?.toString() || '')}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={handleInputKeyDown}
                        />
                        <button className="ap-priority-set-btn" onClick={handleNumberSubmit}>Set</button>
                    </div>
                </div>
            )}
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

function NodeParamSlider({ param, onUpdateParam, onUpdateRange, onLiveChange, midiState, deviceKey, hasController, potAssignedParams, noRange }) {
    const hasPotAssignment = hasController && potAssignedParams?.has(param.key);
    const [localValue, setLocalValue] = nwUseState(param.value);
    const [localRangeMin, setLocalRangeMin] = nwUseState(param.min);
    const [localRangeMax, setLocalRangeMax] = nwUseState(param.max);
    const [playValue, setPlayValue] = nwUseState(null);
    const [displayText, setDisplayText] = nwUseState(null);
    const [dragging, setDragging] = nwUseState(null); // 'value' | 'rangeMin' | 'rangeMax'
    const sliderRef = nwUseRef(null);
    const lastLiveSendRef = nwUseRef(0);
    const initialValueRef = nwUseRef(param.value);
    const initialRangeRef = nwUseRef([param.min, param.max]);
    // Mutable drag state to avoid stale closures in mousemove handlers
    const dragRef = nwUseRef({ value: param.value, rangeMin: param.min, rangeMax: param.max });

    // Sync with external value changes
    nwUseEffect(() => {
        setLocalValue(param.value);
        initialValueRef.current = param.value;
        dragRef.current.value = param.value;
    }, [param.value]);

    nwUseEffect(() => {
        setLocalRangeMin(param.min);
        setLocalRangeMax(param.max);
        initialRangeRef.current = [param.min, param.max];
        dragRef.current.rangeMin = param.min;
        dragRef.current.rangeMax = param.max;
    }, [param.min, param.max]);

    // Subscribe to value feedback for this param's UID (scoped by device)
    nwUseEffect(() => {
        if (!midiState || param.uid === undefined || !deviceKey) return;
        const existing = midiState.getValueFeedback(deviceKey, param.uid);
        if (existing) setDisplayText(existing.displayText);
        const unsubscribe = midiState.subscribe((eventType, data) => {
            if (eventType === 'valueFeedback' && data.uid === param.uid && data.portName === deviceKey) {
                setDisplayText(data.displayText);
            }
        });
        return unsubscribe;
    }, [midiState, param.uid, deviceKey]);

    // Subscribe to CC traffic for play value (only when controller connected)
    nwUseEffect(() => {
        if (!midiState || param.cc < 0 || !hasController) {
            setPlayValue(null);
            return;
        }
        const unsubscribe = midiState.subscribe((eventType, data) => {
            if (eventType === 'allCC' && data.cc === param.cc) {
                const normalized = data.value / 127;
                const val = localRangeMin + normalized * (localRangeMax - localRangeMin);
                setPlayValue(val);
            }
        });
        return unsubscribe;
    }, [midiState, param.cc, localRangeMin, localRangeMax, hasController]);

    // Step size for snapping and display
    const getStep = () => {
        const range = param.absMax - param.absMin;
        if (range <= 2) return 0.01;
        if (range <= 20) return 0.1;
        return 1;
    };

    // Format display value — prefer synth-formatted display text
    const formatValue = (val) => {
        if (displayText) return displayText;
        const step = getStep();
        if (step >= 1) return Math.round(val);
        if (step >= 0.1) return val.toFixed(1);
        return val.toFixed(2);
    };

    // Convert value to percentage of absolute range
    const valueToPercent = (val) => {
        if (param.absMax === param.absMin) return 0;
        return ((val - param.absMin) / (param.absMax - param.absMin)) * 100;
    };

    // Convert mouse x position to value
    const mouseToValue = (clientX) => {
        if (!sliderRef.current) return param.absMin;
        const rect = sliderRef.current.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return param.absMin + pct * (param.absMax - param.absMin);
    };

    // Snap value to step
    const snap = (val) => {
        const step = getStep();
        return Math.round(val / step) * step;
    };

    // Drag handlers — attach to window for smooth dragging
    // Uses dragRef to avoid stale closures in mousemove handler
    const justDraggedRef = nwUseRef(false);
    const startDrag = (type, e) => {
        e.stopPropagation();
        e.preventDefault();
        setDragging(type);
        initialValueRef.current = localValue;
        initialRangeRef.current = [localRangeMin, localRangeMax];
        dragRef.current = { value: localValue, rangeMin: localRangeMin, rangeMax: localRangeMax };

        const handleMove = (me) => {
            const raw = mouseToValue(me.clientX);
            const d = dragRef.current;
            if (type === 'value') {
                const clamped = snap(Math.max(d.rangeMin, Math.min(d.rangeMax, raw)));
                d.value = clamped;
                setLocalValue(clamped);
                // Live CC send (when no controller, or param has no pot assignment)
                if ((!hasController || !hasPotAssignment) && onLiveChange && param.cc >= 0) {
                    const now = performance.now();
                    if (now - lastLiveSendRef.current >= 16) {
                        const rangeSpan = d.rangeMax - d.rangeMin;
                        const normalized = rangeSpan > 0 ? (clamped - d.rangeMin) / rangeSpan : 0;
                        onLiveChange(param.cc, normalized);
                        lastLiveSendRef.current = now;
                    }
                }
            } else if (type === 'rangeMin') {
                const val = snap(Math.max(param.absMin, Math.min(d.rangeMax - getStep(), raw)));
                d.rangeMin = val;
                setLocalRangeMin(val);
            } else if (type === 'rangeMax') {
                const val = snap(Math.max(d.rangeMin + getStep(), Math.min(param.absMax, raw)));
                d.rangeMax = val;
                setLocalRangeMax(val);
            }
        };

        const handleUp = () => {
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
            justDraggedRef.current = true;
            setDragging(null);
        };

        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
    };

    // Commit on drag end via effect
    nwUseEffect(() => {
        if (dragging !== null) return; // still dragging
        // Check if value changed
        if (localValue !== initialValueRef.current) {
            // When pot controls this param, store only — pot owns live values
            if (onUpdateParam) {
                const opts = hasPotAssignment ? { value: localValue, storeOnly: true } : localValue;
                onUpdateParam(param.key, opts);
            }
        }
        // Check if range changed
        if (localRangeMin !== initialRangeRef.current[0] || localRangeMax !== initialRangeRef.current[1]) {
            if (onUpdateRange) onUpdateRange(param.key, localRangeMin, localRangeMax);
        }
    }, [dragging]);

    // Handle direct value edit from EditableValue
    const handleValueCommit = (newValue) => {
        const clamped = Math.max(localRangeMin, Math.min(localRangeMax, newValue));
        setLocalValue(clamped);
        if (onUpdateParam) {
            const opts = hasPotAssignment ? { value: clamped, storeOnly: true } : clamped;
            onUpdateParam(param.key, opts);
        }
    };

    // Click on track to set default value (suppressed after drag to prevent double-fire)
    const handleTrackClick = (e) => {
        if (dragging) return;
        if (justDraggedRef.current) {
            justDraggedRef.current = false;
            return;
        }
        const raw = snap(mouseToValue(e.clientX));
        const clamped = Math.max(localRangeMin, Math.min(localRangeMax, raw));
        setLocalValue(clamped);
        if (onUpdateParam) {
            const opts = hasPotAssignment ? { value: clamped, storeOnly: true } : clamped;
            onUpdateParam(param.key, opts);
        }
    };

    const rangeMinPct = valueToPercent(localRangeMin);
    const rangeMaxPct = valueToPercent(localRangeMax);
    const valuePct = valueToPercent(localValue);
    const playPct = playValue !== null ? valueToPercent(playValue) : null;

    // Compact value formatter (no decimal for integers, 1 decimal otherwise)
    const fmt = (val) => {
        const step = getStep();
        if (step >= 1) return Math.round(val);
        if (step >= 0.1) return val.toFixed(1);
        return val.toFixed(2);
    };

    return (
        <div className="ap-param-slider-wrapper" onMouseDown={(e) => e.stopPropagation()}>
            {/* Slider track */}
            <div className="ap-param-slider" ref={sliderRef} onClick={handleTrackClick}>
                <div className="ap-param-slider-track">
                    {/* Patch range shading */}
                    <div className="ap-param-slider-range"
                         style={{ left: rangeMinPct + '%', width: (rangeMaxPct - rangeMinPct) + '%' }} />
                    {/* Range handles (hidden for noRange amounts) */}
                    {!noRange && (
                        <div className="ap-param-slider-rh ap-param-slider-rh-l"
                             style={{ left: rangeMinPct + '%' }}
                             onMouseDown={(e) => startDrag('rangeMin', e)} />
                    )}
                    {!noRange && (
                        <div className="ap-param-slider-rh ap-param-slider-rh-r"
                             style={{ left: rangeMaxPct + '%' }}
                             onMouseDown={(e) => startDrag('rangeMax', e)} />
                    )}
                    {/* Play value indicator (above thumb z-index, wider for visibility) */}
                    {playPct !== null && hasController && (
                        <div className="ap-param-slider-play"
                             style={{ left: playPct + '%' }} />
                    )}
                    {/* Default value thumb */}
                    <div className="ap-param-slider-thumb"
                         style={{ left: valuePct + '%' }}
                         onMouseDown={(e) => startDrag('value', e)} />
                </div>
            </div>
            {/* Value info row */}
            <div className="ap-param-slider-info">
                {!noRange && <span className="ap-param-slider-info-range">{fmt(localRangeMin)}</span>}
                <span className="ap-param-slider-info-default" title="Default">
                    <EditableValue
                        value={localValue}
                        min={localRangeMin}
                        max={localRangeMax}
                        step={getStep()}
                        onCommit={handleValueCommit}
                        formatValue={formatValue}
                    />
                </span>
                {hasController && playValue !== null && (
                    <span className="ap-param-slider-info-play" title="Play">{fmt(playValue)}</span>
                )}
                {!noRange && <span className="ap-param-slider-info-range">{fmt(localRangeMax)}</span>}
            </div>
        </div>
    );
}
