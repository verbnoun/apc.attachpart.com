/**
 * Node Component - Individual module node in the patch editor workspace
 *
 * Renders a draggable node with header (ports, delete button),
 * envelope/velocity visualizations, parameter sliders, and modulation amounts.
 * Depends on: React (useRef, useMemo, useLayoutEffect),
 *             node-widgets.js (EnvelopeCurve, WaveIcon, WaveSelector, EditableValue, PriorityBadge, VelocityCurvePreview, NodeParamSlider),
 *             topology-utils.js (canSourceModulateParam, findAmountParamsForTarget)
 */

function Node({
    module,
    moduleState,
    topology,
    patch,
    position,
    isSelected,
    isDeleting,
    isPending,
    isFixed,              // Fixed module (no delete, no output wiring)
    onMouseDown,
    onSelectModule,
    onRemoveModule,
    onStartWiring,
    isWiringSource,
    wiringFrom,
    onParamDrop,
    onPortPositionChange,
    selectedWireTarget,
    onUpdateParam,
    onUpdateRange,
    onLiveChange,
    onUpdateModAmount,
    otherEnvelopeParams,  // For envelope overlay
    otherEnvelopeColor,   // Color for the other envelope curve
    midiState,
    controllerConfig,
    deviceKey,
    hasController = false,
    potAssignedParams
}) {
    const moduleData = patch?.[module.id];

    // Port refs for position tracking
    const headerInputRef = React.useRef(null);
    const headerOutputRef = React.useRef(null);
    const paramPortRefs = React.useRef({});

    const isChainMember = module.isChainMember === true;
    const isModSource = module.isModSource === true;

    // Get key parameters to display with full range info
    const digestParams = React.useMemo(() => {
        if (!moduleData) return [];

        const params = [];
        Object.entries(moduleData).forEach(([key, value]) => {
            // Skip amount params and meta
            if (key.endsWith('_AMOUNT') || key === 'name' || key === 'version' || key === 'targets') return;
            if (typeof value === 'object' && value !== null) {
                // It's a parameter with range/initial/etc
                if (value.initial !== undefined) {
                    const absRange = getAbsoluteRange(topology, key);
                    params.push({
                        key,
                        name: value.name || key,  // Human-readable name
                        value: value.initial,
                        min: value.range?.[0] ?? 0,        // patch range min
                        max: value.range?.[1] ?? 1,        // patch range max
                        absMin: absRange?.absMin ?? (value.range?.[0] ?? 0),  // absolute min
                        absMax: absRange?.absMax ?? (value.range?.[1] ?? 1),  // absolute max
                        priority: value.priority ?? 999,  // For sorting
                        cc: value.cc,
                        uid: value.uid  // Parameter UID for value feedback
                    });
                }
            }
        });

        // Keep JSON key order (priority badge shows dial assignment, not display order)
        return params;
    }, [moduleData, topology]);

    // Collect all existing priorities from the entire patch as Map<priority, {key, name}>
    const priorityMap = React.useMemo(() => {
        const map = new Map();
        if (!patch) return map;

        Object.entries(patch).forEach(([moduleId, modData]) => {
            if (typeof modData !== 'object' || modData === null) return;
            Object.entries(modData).forEach(([key, value]) => {
                if (typeof value === 'object' && value !== null && value.priority != null) {
                    map.set(value.priority, { key, name: value.name || key });
                }
            });
        });
        return map;
    }, [patch]);

    // Dial count from controller config pots array (0 if no controller paired)
    const dialCount = (hasController && controllerConfig?.pots?.length) || 0;

    // Priority update — firmware auto-swaps on conflict
    const handleUpdatePriority = (paramKey, newPri) => {
        onUpdateParam(paramKey, { priority: newPri });
    };

    // Check if this is an envelope module
    const isEnvelopeModule = module.category === 'envelope' ||
        module.id === 'MOD_ENV' || module.id === 'VAMP_ENV' || module.id === 'AMP_ENV';

    // Check if this is an oscillator module
    const isOscillatorModule = module.category === 'oscillator' ||
        module.id.startsWith('OSC');

    // Check if this is an LFO module
    const isLfoModule = module.category === 'lfo' ||
        module.id === 'GLFO' || module.id === 'VLFO';

    // Get envelope params (ADSR) if this is an envelope module
    // Handles both Candide naming (_ATTACK_TIME, _SUSTAIN_LEVEL) and Estragon naming (_ATTACK, _SUSTAIN)
    const envelopeParams = React.useMemo(() => {
        if (!isEnvelopeModule || !moduleData) return null;

        const findParam = (...suffixes) => {
            for (const [key, value] of Object.entries(moduleData)) {
                if (suffixes.some(s => key.endsWith(s)) && typeof value === 'object' && value.initial !== undefined) {
                    return value.initial;
                }
            }
            return null;
        };

        const attack = findParam('_ATTACK_TIME', '_ATTACK');
        const decay = findParam('_DECAY_TIME', '_DECAY');
        const sustain = findParam('_SUSTAIN_LEVEL', '_SUSTAIN');
        const release = findParam('_RELEASE_TIME', '_RELEASE');

        if (attack !== null && decay !== null && sustain !== null && release !== null) {
            return { attack, decay, sustain, release };
        }
        return null;
    }, [isEnvelopeModule, moduleData]);

    // Report port positions when mounted or position changes
    // Use useLayoutEffect for synchronous updates during drag
    React.useLayoutEffect(() => {
        if (!onPortPositionChange) return;

        // Header input port (audio modules only)
        if (headerInputRef.current) {
            const rect = headerInputRef.current.getBoundingClientRect();
            onPortPositionChange(`${module.id}:in`, {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            });
        }

        // Header output port (all modules)
        if (headerOutputRef.current) {
            const rect = headerOutputRef.current.getBoundingClientRect();
            onPortPositionChange(`${module.id}:out`, {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            });
        }

        // Param input ports (modulation targets)
        Object.entries(paramPortRefs.current).forEach(([paramKey, ref]) => {
            if (ref) {
                const rect = ref.getBoundingClientRect();
                onPortPositionChange(`${module.id}:${paramKey}:in`, {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2
                });
            }
        });
    }, [position, module.id, onPortPositionChange, digestParams.length]);

    // Handle header click - selects the module
    const handleHeaderClick = (e) => {
        e.stopPropagation();
        if (onSelectModule) {
            onSelectModule();
        }
    };

    // Handle delete button click
    const handleDeleteClick = (e) => {
        e.stopPropagation();
        if (onRemoveModule) {
            onRemoveModule();
        }
    };

    // Handle port click to start wiring
    const handlePortClick = (e) => {
        e.stopPropagation();
        if (onStartWiring) {
            onStartWiring();
        }
    };

    // Handle param drop zone click
    const handleParamDrop = (paramKey, e) => {
        e.stopPropagation();
        if (onParamDrop) {
            onParamDrop(module.id, paramKey);
        }
    };

    // Build class list — use groupId for CSS instead of hardcoded type
    const classNames = ['ap-node'];
    if (isChainMember) classNames.push('ap-node-chain');
    if (isModSource) classNames.push('ap-node-modsource');
    if (isWiringSource) classNames.push('wiring-source');
    if (isSelected) classNames.push('selected');
    if (isDeleting) classNames.push('deleting');
    if (isPending) classNames.push('pending');
    if (isFixed) classNames.push('fixed');
    if (isEnvelopeModule) classNames.push('ap-node-envelope');
    if (isOscillatorModule) classNames.push('ap-node-oscillator');
    if (isLfoModule) classNames.push('ap-node-lfo');

    // Get envelope color — use module's group color
    const envelopeColor = module.groupColor || 'var(--ap-wire-env)';

    // Get wave list for this param from topology (data-driven, no string checks)
    const getWavesForParam = (param) => {
        if (!topology?.waves) return null;
        let waveList = null;
        if (isOscillatorModule) waveList = topology.waves.osc;
        else if (isLfoModule) waveList = topology.waves.lfo;
        else if (isChainMember) waveList = topology.waves.osc; // fallback for chain members
        if (!waveList || waveList.length === 0) return null;
        // Param range must match wave list indices
        if (param.min === 0 && param.max === waveList.length - 1) return waveList;
        return null;
    };

    return (
        <div
            className={classNames.join(' ')}
            style={{ left: position.x, top: position.y }}
            onMouseDown={onMouseDown}
        >
            <div className="ap-node-header" onClick={handleHeaderClick}
                 style={{ background: module.groupColor || '#888' }}>
                {/* Input port - chain members only */}
                {isChainMember && (
                    <div
                        ref={headerInputRef}
                        className="ap-port ap-node-port ap-node-port-header-in"
                    />
                )}
                {/* Delete button - hidden for fixed modules */}
                {!isFixed && (
                    <button
                        className="ap-node-delete-btn"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={handleDeleteClick}
                        title="Remove module"
                    >
                        X
                    </button>
                )}
                <span className="ap-node-title">{module.name}</span>
                {/* Output port - clickable for non-fixed mod sources */}
                <div
                    ref={headerOutputRef}
                    className={`ap-port ap-node-port ap-node-port-header-out ${isWiringSource ? 'active' : ''}`}
                    onMouseDown={(!isFixed && isModSource) ? handlePortClick : undefined}
                    title={(!isFixed && isModSource) ? "Drag to connect" : undefined}
                />
            </div>
            <div className="ap-node-body">
                {/* Velocity curve preview (VELOCITY node only) */}
                {module.id === 'VELOCITY' && (
                    <div className="ap-node-velocity-viz">
                        <VelocityCurvePreview
                            curve={controllerConfig?.keyboard?.velocity}
                            midiState={midiState}
                        />
                    </div>
                )}
                {/* Envelope curve visualization */}
                {isEnvelopeModule && envelopeParams && (
                    <div className="ap-node-envelope-viz">
                        {/* Other envelope (dashed, behind) */}
                        {otherEnvelopeParams && (
                            <EnvelopeCurve
                                attack={otherEnvelopeParams.attack}
                                decay={otherEnvelopeParams.decay}
                                sustain={otherEnvelopeParams.sustain}
                                release={otherEnvelopeParams.release}
                                color={otherEnvelopeColor || 'var(--ap-text-muted)'}
                                dashed={true}
                            />
                        )}
                        {/* This envelope (solid, front) */}
                        <EnvelopeCurve
                            attack={envelopeParams.attack}
                            decay={envelopeParams.decay}
                            sustain={envelopeParams.sustain}
                            release={envelopeParams.release}
                            color={envelopeColor}
                        />
                    </div>
                )}
                {digestParams.map(param => {
                    // Check if this param is a valid target for the current wiring source
                    const canReceiveWire = wiringFrom &&
                        canSourceModulateParam(topology, wiringFrom.moduleId, param.key);

                    // Check if this param is the target of a selected wire
                    const isWireTarget = selectedWireTarget &&
                        selectedWireTarget.module === module.id &&
                        selectedWireTarget.param === param.key;

                    // Find AMOUNT params for this param
                    const amountParams = findAmountParamsForTarget(moduleData, param.key, moduleState?.modSourceIds);

                    // Check if topology provides waves for this param
                    const waves = getWavesForParam(param);
                    const isWaveControl = waves && waves.length > 0;

                    return (
                        <div key={param.key} className="ap-node-param-container">
                            <div
                                className={`ap-node-param ${canReceiveWire ? 'drop-target' : ''} ${isWireTarget ? 'wire-target' : ''}`}
                                onMouseDown={canReceiveWire ? (e) => e.stopPropagation() : undefined}
                                onMouseUp={canReceiveWire ? (e) => handleParamDrop(param.key, e) : undefined}
                            >
                                {/* Param input port for modulation targets */}
                                <div
                                    ref={el => paramPortRefs.current[param.key] = el}
                                    className="ap-port-sm ap-node-port-param-in"
                                />
                                <PriorityBadge
                                    priority={param.priority}
                                    paramKey={param.key}
                                    priorityMap={priorityMap}
                                    onUpdatePriority={handleUpdatePriority}
                                    hasController={hasController}
                                    dialCount={dialCount}
                                />
                                <span className="ap-node-param-key">{param.name}</span>
                                {isWaveControl ? (
                                    <WaveSelector
                                        param={param}
                                        waves={waves}
                                        onUpdateParam={onUpdateParam}
                                        hasController={hasController}
                                        midiState={midiState}
                                    />
                                ) : (
                                    <NodeParamSlider
                                        param={param}
                                        onUpdateParam={onUpdateParam}
                                        onUpdateRange={onUpdateRange}
                                        onLiveChange={onLiveChange}
                                        midiState={midiState}
                                        deviceKey={deviceKey}
                                        hasController={hasController}
                                        potAssignedParams={potAssignedParams}
                                    />
                                )}
                            </div>
                            {/* Amount sliders under param */}
                            {amountParams.map(amt => (
                                <div key={amt.source} className="ap-node-mod-amount">
                                    <PriorityBadge
                                        priority={amt.priority}
                                        paramKey={amt.key}
                                        priorityMap={priorityMap}
                                        onUpdatePriority={handleUpdatePriority}
                                        hasController={hasController}
                                        dialCount={dialCount}
                                    />
                                    <span
                                        className="ap-node-param-key"
                                        style={{ color: moduleState?.allModules?.get(amt.source)?.groupColor || 'var(--ap-wire-mod)' }}
                                    >
                                        {amt.name}
                                    </span>
                                    <NodeParamSlider
                                        param={{
                                            key: amt.key,
                                            value: amt.value,
                                            min: amt.min,
                                            max: amt.max,
                                            absMin: amt.min,
                                            absMax: amt.max,
                                            cc: amt.cc,
                                            uid: amt.uid,
                                        }}
                                        onUpdateParam={(key, opts) => {
                                            const val = typeof opts === 'object' ? opts.value : opts;
                                            onUpdateModAmount?.(param.key, amt.source, val);
                                        }}
                                        onLiveChange={onLiveChange}
                                        midiState={midiState}
                                        deviceKey={deviceKey}
                                        hasController={hasController}
                                        potAssignedParams={potAssignedParams}
                                        noRange
                                    />
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
