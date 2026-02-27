/**
 * Node Context Menu - Module inspector/editor panel
 *
 * Full parameter editing, modulation routing, and module management.
 * Opens on double-click or right-click on a node.
 * Depends on: React (useState, useEffect, useMemo)
 */

function NodeContextMenu({
    moduleId,
    moduleState,
    topology,
    patch,
    position,
    onClose,
    onUpdateParam,
    onToggleModulation,
    onUpdateModAmount,
    onRemove,
    enabledModules
}) {
    const moduleData = patch?.[moduleId];

    // Close on outside click
    React.useEffect(() => {
        const handleClick = (e) => {
            if (!e.target.closest('.ap-context-menu')) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [onClose]);

    // Find module definition
    const moduleDef = moduleState?.allModules?.get(moduleId);
    const isModSource = moduleDef?.isModSource === true;

    // Extract parameters from moduleData
    const parameters = React.useMemo(() => {
        if (!moduleData) return [];
        const params = [];

        Object.entries(moduleData).forEach(([key, value]) => {
            // Skip amount keys and metadata
            if (key.endsWith('_AMOUNT') || key === 'name' || key === 'version') return;

            if (typeof value === 'object' && value !== null) {
                // Parameter object with range, initial, etc.
                // Range is an array [min, max] in patch JSON
                params.push({
                    key,
                    value: value.initial !== undefined ? value.initial : value.value,
                    min: value.range?.[0] ?? 0,
                    max: value.range?.[1] ?? 1,
                    range: value.range
                });
            } else if (typeof value === 'number') {
                // Simple numeric parameter
                params.push({
                    key,
                    value,
                    min: 0,
                    max: 127
                });
            }
        });

        return params;
    }, [moduleData]);

    // For mod sources: find where they're actively routed
    // Uses topology.mod_targets as single source of truth for valid targets
    const routedTargets = React.useMemo(() => {
        if (!isModSource || !patch) return [];
        const targets = [];

        // Get this source's valid targets from topology (single source of truth)
        const validTargets = topology?.mod_targets?.[moduleId] || [];

        // For each valid target, check if there's an active AMOUNT param
        validTargets.forEach(targetParam => {
            // Find which module owns this param by checking all modules
            Object.entries(patch).forEach(([modKey, modData]) => {
                if (typeof modData !== 'object' || !modData) return;
                if (['name', 'version', 'index'].includes(modKey)) return;

                // Check if this module has the target param
                if (modData[targetParam]) {
                    // Check for AMOUNT param: {TARGET}_{SOURCE}_AMOUNT
                    const amountKey = `${targetParam}_${moduleId}_AMOUNT`;
                    const amountData = modData[amountKey];

                    if (amountData !== undefined) {
                        const amount = typeof amountData === 'object' ? amountData.initial : amountData;
                        targets.push({
                            module: modKey,
                            param: targetParam,
                            amount: amount || 0,
                            min: amountData?.range?.[0] ?? -100,
                            max: amountData?.range?.[1] ?? 100
                        });
                    }
                }
            });
        });

        return targets;
    }, [isModSource, moduleId, patch, topology]);

    // Constrain position to viewport
    const constrainedPos = React.useMemo(() => {
        const menuWidth = 280;
        const menuHeight = 350;
        const padding = 10;

        let x = position.x;
        let y = position.y;

        if (x + menuWidth > window.innerWidth - padding) {
            x = window.innerWidth - menuWidth - padding;
        }
        if (y + menuHeight > window.innerHeight - padding) {
            y = window.innerHeight - menuHeight - padding;
        }

        return { x: Math.max(padding, x), y: Math.max(padding, y) };
    }, [position]);

    return (
        <div
            className="ap-context-menu"
            style={{ left: constrainedPos.x, top: constrainedPos.y }}
        >
            <div className="ap-context-header">
                {moduleDef?.name || moduleId}
                <button className="ap-context-close" onClick={onClose}>X</button>
            </div>
            <div className="ap-context-body ap-context-scroll">
                {/* Parameters Section */}
                {parameters.length > 0 && (
                    <div className="ap-context-section">
                        <div className="ap-context-section-title">PARAMETERS</div>
                        {parameters.map(param => (
                            <ParameterControl
                                key={param.key}
                                moduleId={moduleId}
                                param={param}
                                onUpdate={onUpdateParam}
                            />
                        ))}
                    </div>
                )}

                {/* Modulation Section for Audio Modules */}
                {!isModSource && parameters.length > 0 && (
                    <div className="ap-context-section">
                        <div className="ap-context-section-title">MODULATION</div>
                        {parameters.slice(0, 4).map(param => (
                            <ModulationControl
                                key={param.key}
                                moduleId={moduleId}
                                param={param}
                                moduleData={moduleData}
                                patch={patch}
                                topology={topology}
                                onToggle={onToggleModulation}
                                onAmountChange={onUpdateModAmount}
                            />
                        ))}
                    </div>
                )}

                {/* Routing Section for Mod Sources */}
                {isModSource && routedTargets.length > 0 && (
                    <div className="ap-context-section">
                        <div className="ap-context-section-title">ROUTED TO</div>
                        {routedTargets.map((target, i) => (
                            <div key={i} className="ap-routed-target">
                                <span className="ap-target-name">
                                    {target.module}.{target.param}
                                </span>
                                <input
                                    type="range"
                                    className="ap-slider ap-target-slider"
                                    min={target.min}
                                    max={target.max}
                                    value={target.amount}
                                    onChange={(e) => onUpdateModAmount(
                                        target.param,
                                        moduleId,
                                        parseFloat(e.target.value)
                                    )}
                                />
                                <span className="ap-target-amount">{target.amount}</span>
                            </div>
                        ))}
                    </div>
                )}

                {isModSource && routedTargets.length === 0 && (
                    <p className="ap-text-muted ap-context-hint">
                        Drag from output port to route this modulation source.
                    </p>
                )}

                {/* Remove Button */}
                <button
                    className="ap-btn ap-btn-danger ap-btn-small ap-mt-md"
                    onClick={onRemove}
                >
                    Remove Module
                </button>
            </div>
        </div>
    );
}

//======================================================================
// PARAMETER CONTROL
//======================================================================

function ParameterControl({ moduleId, param, onUpdate }) {
    const [localValue, setLocalValue] = React.useState(param.value);

    React.useEffect(() => {
        setLocalValue(param.value);
    }, [param.value]);

    const handleChange = (e) => {
        setLocalValue(parseFloat(e.target.value));
    };

    const handleCommit = () => {
        if (onUpdate && localValue !== param.value) {
            onUpdate(param.key, localValue);
        }
    };

    // Determine step size based on parameter type
    // WAVE params are discrete (integer steps)
    // Small ranges (<=2) get fine control (0.01 step)
    // Larger ranges get integer steps
    const getStep = () => {
        const key = param.key || '';
        const range = param.max - param.min;

        // WAVE params are always discrete
        if (key.includes('_WAVE')) {
            return 1;
        }

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

    // Format display value based on step size
    const formatValue = (val) => {
        const step = getStep();
        if (step >= 1) {
            return Math.round(val);
        } else if (step >= 0.1) {
            return val.toFixed(1);
        } else {
            return val.toFixed(2);
        }
    };

    return (
        <div className="ap-param-control">
            <div className="ap-param-header">
                <span className="ap-param-name">{param.key}</span>
                <span className="ap-param-value">{formatValue(localValue)}</span>
            </div>
            <input
                type="range"
                className="ap-slider"
                min={param.min}
                max={param.max}
                step={getStep()}
                value={localValue}
                onChange={handleChange}
                onMouseUp={handleCommit}
                onTouchEnd={handleCommit}
            />
        </div>
    );
}

//======================================================================
// MODULATION CONTROL
//======================================================================

function ModulationControl({ moduleId, param, moduleData, patch, topology, moduleState, onToggle, onAmountChange }) {
    // Get sources that CAN modulate this param (from topology.mod_targets)
    const availableSources = React.useMemo(() => {
        if (!topology?.mod_targets) return [];
        return Object.keys(topology.mod_targets).filter(source => {
            const targets = topology.mod_targets[source] || [];
            return targets.includes(param.key);
        });
    }, [topology, param.key]);

    if (availableSources.length === 0) return null;

    return (
        <div className="ap-mod-control">
            <div className="ap-mod-param-name">{param.key}</div>
            <div className="ap-mod-sources">
                {availableSources.map(source => {
                    // Check if route is active: {PARAM}_{SOURCE}_AMOUNT exists
                    const amountKey = `${param.key}_${source}_AMOUNT`;
                    const amountData = moduleData?.[amountKey];
                    const isActive = amountData !== undefined;
                    const amount = isActive ? (typeof amountData === 'object' ? amountData.initial : amountData) : 0;
                    const amtMin = amountData?.range?.[0] ?? -100;
                    const amtMax = amountData?.range?.[1] ?? 100;
                    const sourceColor = moduleState?.allModules?.get(source)?.groupColor || 'var(--ap-wire-mod)';

                    return (
                        <div key={source} className="ap-mod-source-row">
                            <label className="ap-mod-source-toggle">
                                <input
                                    type="checkbox"
                                    checked={isActive}
                                    onChange={(e) => onToggle(param.key, source, e.target.checked)}
                                />
                                <span className="ap-mod-source-name" style={{ color: sourceColor }}>
                                    {source.replace('_', ' ')}
                                </span>
                            </label>
                            {isActive && (
                                <input
                                    type="range"
                                    className="ap-slider ap-mod-amount-slider"
                                    min={amtMin}
                                    max={amtMax}
                                    value={amount}
                                    onChange={(e) => onAmountChange(param.key, source, parseFloat(e.target.value))}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
