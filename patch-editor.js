/**
 * Patch Editor Window - Node-based patch editing
 *
 * Layout: Patches List | Module Drawer | Node Workspace
 *
 * Features:
 * - Patch list with drag-to-reorder
 * - Module drawer with grouped sections (Audio, Mod, Control)
 * - Node workspace with free positioning
 * - Audio wires (auto, non-editable)
 * - Modulation wires (user-created, editable)
 */

const { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } = React;

//======================================================================
// MODULE DEFINITIONS
//======================================================================

// Default module definitions - used as fallback when topology not yet loaded
const DEFAULT_MODULE_DEFINITIONS = {
    // Audio modules - auto-wire in signal chain
    audio: [
        { id: 'OSC0', name: 'OSC 0', type: 'audio', category: 'oscillator', alwaysEnabled: true },
        { id: 'OSC1', name: 'OSC 1', type: 'audio', category: 'oscillator' },
        { id: 'OSC2', name: 'OSC 2', type: 'audio', category: 'oscillator' },
        { id: 'FILTER', name: 'FILTER', type: 'audio', category: 'filter' },
        { id: 'VAMP', name: 'Amp', type: 'audio', category: 'amp', alwaysEnabled: true }
    ],
    // Modulation sources - user wires to targets
    mod: [
        { id: 'MOD_ENV', name: 'MOD ENV', type: 'mod', category: 'envelope' },
        { id: 'VAMP_ENV', name: 'AMP ENV', type: 'mod', category: 'envelope', alwaysEnabled: true },
        { id: 'GLFO', name: 'GLOBAL LFO', type: 'mod', category: 'lfo' },
        { id: 'VLFO', name: 'VOICE LFO', type: 'mod', category: 'lfo' }
    ],
    // Control sources - individual key expression modules
    control: [
        { id: 'VELOCITY', name: 'Velocity', type: 'control' },
        { id: 'PRESSURE', name: 'Pressure', type: 'control' },
        { id: 'BEND', name: 'Bend', type: 'control' }
    ]
};

/**
 * Build module definitions from topology
 * Topology from device overrides defaults
 */
function buildModuleDefinitions(topology) {
    if (!topology?.modules) {
        return DEFAULT_MODULE_DEFINITIONS;
    }

    const audio = (topology.modules.audio || []).map(m => ({
        id: m.id,
        name: m.name,
        type: 'audio',
        alwaysEnabled: m.alwaysEnabled || false
    }));

    const mod = (topology.modules.mod || []).map(m => ({
        id: m.id,
        name: m.name,
        type: 'mod',
        alwaysEnabled: m.alwaysEnabled || false
    }));

    // Control modules - use device topology if provided, otherwise defaults
    const control = topology.modules.control?.length > 0
        ? topology.modules.control.map(m => ({
            id: m.id,
            name: m.name,
            type: 'control',
            alwaysEnabled: m.alwaysEnabled || false
        }))
        : DEFAULT_MODULE_DEFINITIONS.control;

    return { audio, mod, control };
}

// Signal chain order for audio modules
const AUDIO_CHAIN_ORDER = ['OSC0', 'OSC1', 'OSC2', 'FILTER', 'VAMP'];

// All modulation sources (for checking connections)
const MOD_SOURCES = ['VELOCITY', 'PRESSURE', 'BEND', 'MOD_ENV', 'VAMP_ENV', 'GLFO', 'VLFO'];

// Wire colors by source type
const WIRE_COLORS = {
    'VELOCITY': 'var(--ap-accent-purple)',
    'PRESSURE': 'var(--ap-accent-purple)',
    'BEND': 'var(--ap-accent-purple)',
    'MOD_ENV': 'var(--ap-accent-red)',
    'VAMP_ENV': 'var(--ap-accent-red)',
    'GLFO': 'var(--ap-accent-blue)',
    'VLFO': 'var(--ap-accent-blue)'
};

//======================================================================
// HELPER FUNCTIONS
//======================================================================

/**
 * Check if a modulation source can target a specific parameter
 * Uses topology.mod_targets (static data from device)
 */
function canSourceModulateParam(topology, sourceId, paramKey) {
    const targets = topology?.mod_targets?.[sourceId] || [];
    return targets.includes(paramKey);
}

/**
 * Find a module definition by ID
 */
function findModuleDef(moduleId, moduleDefinitions) {
    const defs = moduleDefinitions || DEFAULT_MODULE_DEFINITIONS;
    const allModules = [
        ...defs.audio,
        ...defs.mod,
        ...defs.control
    ];
    return allModules.find(m => m.id === moduleId) || null;
}

/**
 * Find all AMOUNT params for a given target parameter
 * Returns array of { source, key, value, min, max }
 */
function findAmountParamsForTarget(moduleData, targetParamKey) {
    if (!moduleData) return [];
    const amounts = [];
    const knownSources = ['VELOCITY', 'PRESSURE', 'BEND', 'GLFO', 'VLFO', 'MOD_ENV', 'VAMP_ENV'];

    knownSources.forEach(source => {
        const amountKey = `${targetParamKey}_${source}_AMOUNT`;
        const amountData = moduleData[amountKey];
        if (amountData !== undefined) {
            amounts.push({
                source,
                key: amountKey,
                value: typeof amountData === 'object' ? amountData.initial : amountData,
                min: amountData.range?.[0] ?? -1,
                max: amountData.range?.[1] ?? 1
            });
        }
    });
    return amounts;
}

/**
 * Calculate the impact of deleting a module
 * Returns routes that will be removed and modules that will be orphaned
 */
function calculateDeletionImpact(patch, moduleId, modConnections, moduleDefinitions) {
    const impact = {
        routesRemoved: [],      // Direct routes from/to this module
        orphanedModules: [],    // Modules that will have no connections after
    };

    if (!patch || !modConnections) return impact;

    // Find all routes involving this module
    modConnections.forEach(conn => {
        // Routes FROM this module (it's the source)
        if (conn.from === moduleId) {
            impact.routesRemoved.push({
                source: conn.from,
                target: conn.toModule,
                param: conn.toParam,
                amount: conn.amount
            });
        }
        // Routes TO this module (it has a param being modulated)
        if (conn.toModule === moduleId) {
            impact.routesRemoved.push({
                source: conn.from,
                target: conn.toModule,
                param: conn.toParam,
                amount: conn.amount
            });
        }
    });

    // Check if any sources will be orphaned (lose all their targets)
    const sourcesAffected = new Set(impact.routesRemoved.map(r => r.source));

    sourcesAffected.forEach(sourceId => {
        if (sourceId === moduleId) return; // Skip the module being deleted

        // Count remaining routes for this source after deletion
        const remainingRoutes = modConnections.filter(conn =>
            conn.from === sourceId &&
            conn.toModule !== moduleId // Exclude routes to the deleted module
        );

        if (remainingRoutes.length === 0) {
            const moduleDef = findModuleDef(sourceId, moduleDefinitions);
            // Only orphan non-alwaysEnabled modules
            if (moduleDef && !moduleDef.alwaysEnabled) {
                impact.orphanedModules.push(sourceId);
            }
        }
    });

    return impact;
}

/**
 * Create a logger function that uses the provided addLog
 * This is called inside the component to capture the addLog prop
 */
function createPatchLogger(addLog) {
    return (action, details) => {
        const detailStr = typeof details === 'object' ? JSON.stringify(details) : details;
        addLog(`${action}: ${detailStr}`, 'info');
    };
}

//======================================================================
// LOADING OVERLAY
//======================================================================

/**
 * Loading overlay with animated dots
 * Shows during patch loading, fades out when complete
 */
function LoadingOverlay({ isLoading, isVisible }) {
    const [dots, setDots] = useState('');

    useEffect(() => {
        if (!isLoading) return;
        const interval = setInterval(() => {
            setDots(d => d.length >= 3 ? '' : d + '.');
        }, 400);
        return () => clearInterval(interval);
    }, [isLoading]);

    // Use isVisible for fade animation (allows fade-out when isLoading becomes false)
    const overlayClass = `ap-loading-overlay ${isVisible ? 'visible' : ''}`;

    return (
        <div className={overlayClass}>
            <div className="ap-loading-content">
                <span className="ap-loading-text">LOADING{dots}</span>
            </div>
        </div>
    );
}

//======================================================================
// PATCH EDITOR WINDOW
//======================================================================

function PatchEditorWindow({
    topology,
    patchList,
    currentIndex,
    currentPatch,
    onSelectPatch,
    onCreatePatch,
    onDeletePatch,
    onRenamePatch,
    onMovePatch,
    onToggleModule,
    onUpdateParam,
    onToggleModulation,
    onUpdateModAmount,
    isConnected = true,
    addLog = (msg, type) => console.log(`[${type}] ${msg}`)  // Default to console if not provided
}) {
    // Create logger that uses the addLog prop
    const log = useMemo(() => createPatchLogger(addLog), [addLog]);

    // Build module definitions from topology (or use defaults)
    const moduleDefinitions = useMemo(() => buildModuleDefinitions(topology), [topology]);

    // Node positions (stored locally, could be persisted later)
    const [nodePositions, setNodePositions] = useState({});

    // Selection state - persistent selection for modules and wires
    const [selection, setSelection] = useState({
        type: null,        // 'module' | 'wire' | null
        moduleId: null,    // Selected module ID
        wireKey: null,     // Selected wire key: "{source}:{target}:{param}"
    });

    // Confirmation dialog state
    const [confirmDialog, setConfirmDialog] = useState(null);
    // { type: 'module'|'wire', id: string, impact: object }

    // Modules currently being deleted (for animation)
    const [deletingModules, setDeletingModules] = useState(new Set());

    // Pending module (dropped but not yet connected)
    const [pendingModule, setPendingModule] = useState(null);
    // { moduleId, position: {x, y} }

    // Wire dragging state
    const [wiringFrom, setWiringFrom] = useState(null); // { moduleId, type }
    const [wiringMousePos, setWiringMousePos] = useState(null);

    // Loading state
    const [isLoading, setIsLoading] = useState(!currentPatch);
    const [loadingIndex, setLoadingIndex] = useState(currentIndex >= 0 ? currentIndex : null);

    // Detect when loading completes (currentPatch changes from null to data)
    const prevPatchRef = useRef(currentPatch);
    useEffect(() => {
        if (prevPatchRef.current !== currentPatch && currentPatch !== null) {
            // Patch loaded - end loading state
            setIsLoading(false);
            setLoadingIndex(null);
        }
        prevPatchRef.current = currentPatch;
    }, [currentPatch]);

    // Handle patch selection with loading state
    const handleSelectPatch = useCallback((index) => {
        if (isLoading) return; // Ignore clicks while loading
        if (index === currentIndex) return; // Already selected

        setIsLoading(true);
        setLoadingIndex(index);
        setSelection({ type: null, moduleId: null, wireKey: null }); // Clear selection

        if (onSelectPatch) {
            onSelectPatch(index);
        }
    }, [isLoading, currentIndex, onSelectPatch]);

    // Get enabled modules from current patch
    // Unified rule: module is enabled if it has params OR has active modulation routes
    const enabledModules = useMemo(() => {
        if (!currentPatch) return new Set();
        const enabled = new Set();
        const metadataKeys = ['name', 'version', 'index'];

        // First pass: collect all AMOUNT param sources (active routes)
        const activeSources = new Set();
        const knownSources = ['VELOCITY', 'PRESSURE', 'BEND', 'GLFO', 'VLFO', 'MOD_ENV', 'VAMP_ENV'];

        Object.values(currentPatch).forEach(moduleData => {
            if (typeof moduleData !== 'object' || !moduleData) return;
            Object.keys(moduleData).forEach(key => {
                if (!key.endsWith('_AMOUNT')) return;
                // Find which source this AMOUNT param is for
                const withoutAmount = key.slice(0, -7);
                knownSources.forEach(src => {
                    if (withoutAmount.endsWith('_' + src)) {
                        activeSources.add(src);
                    }
                });
            });
        });

        // Second pass: determine enabled modules from patch keys
        Object.keys(currentPatch).forEach(key => {
            if (metadataKeys.includes(key)) return;

            const moduleData = currentPatch[key];
            const moduleKeys = Object.keys(moduleData || {});

            // Has parameters (not just name/targets)
            const hasParams = moduleKeys.some(k => k !== 'name' && k !== 'targets');

            if (hasParams) {
                enabled.add(key);
            }
        });

        // Third pass: add control sources that have active routes
        // (VELOCITY, PRESSURE, BEND don't have their own patch keys,
        // they only appear as suffixes in _AMOUNT params)
        activeSources.forEach(src => enabled.add(src));

        return enabled;
    }, [currentPatch]);

    // Extract existing modulation connections from patch
    // Scans for {TARGET}_{SOURCE}_AMOUNT params to find active routes
    const modConnections = useMemo(() => {
        if (!currentPatch) return [];
        const connections = [];

        // Known modulation sources (to parse from AMOUNT param names)
        const knownSources = ['VELOCITY', 'PRESSURE', 'BEND', 'GLFO', 'VLFO', 'MOD_ENV', 'VAMP_ENV'];

        // Scan all modules for AMOUNT params
        Object.entries(currentPatch).forEach(([moduleId, moduleData]) => {
            if (typeof moduleData !== 'object' || !moduleData) return;
            if (['name', 'version', 'index'].includes(moduleId)) return;

            Object.entries(moduleData).forEach(([key, value]) => {
                // Match {TARGET}_{SOURCE}_AMOUNT pattern
                if (!key.endsWith('_AMOUNT')) return;

                // Parse source from key: e.g., "FILTER_FREQUENCY_MOD_ENV_AMOUNT"
                const withoutAmount = key.slice(0, -7); // Remove "_AMOUNT"

                // Find which source this is
                let source = null;
                let target = null;
                for (const src of knownSources) {
                    if (withoutAmount.endsWith('_' + src)) {
                        source = src;
                        target = withoutAmount.slice(0, -(src.length + 1)); // Remove "_SOURCE"
                        break;
                    }
                }

                if (source && target) {
                    connections.push({
                        from: source,
                        toModule: moduleId,
                        toParam: target,
                        amount: typeof value === 'object' ? value.initial : value
                    });
                }
            });
        });

        return connections;
    }, [currentPatch]);

    // Select a module (click on header)
    const handleSelectModule = (moduleId) => {
        if (wiringFrom) return; // Don't select while wiring
        log('Module Selected', { moduleId });
        setSelection({
            type: 'module',
            moduleId,
            wireKey: null
        });
    };

    // Select a wire (click on wire path)
    const handleSelectWire = (wireKey) => {
        log('Wire Selected', { wireKey });
        setSelection({
            type: 'wire',
            moduleId: null,
            wireKey
        });
    };

    // Clear selection (click on workspace background)
    const clearSelection = () => {
        setSelection({ type: null, moduleId: null, wireKey: null });
    };

    // Show delete confirmation dialog
    const showDeleteConfirmation = (type, id) => {
        if (type === 'module') {
            const impact = calculateDeletionImpact(currentPatch, id, modConnections, moduleDefinitions);
            const moduleDef = findModuleDef(id, moduleDefinitions);
            log('Delete Confirmation Shown', { type, id, impact });
            setConfirmDialog({
                type: 'module',
                id,
                name: moduleDef?.name || id,
                impact
            });
        } else if (type === 'wire') {
            // Parse wire key: "source:target:param"
            const [source, target, param] = id.split(':');
            const conn = modConnections.find(c =>
                c.from === source && c.toModule === target && c.toParam === param
            );
            log('Delete Confirmation Shown', { type, id, connection: conn });
            setConfirmDialog({
                type: 'wire',
                id,
                source,
                target,
                param,
                amount: conn?.amount
            });
        }
    };

    // Handle confirmed deletion
    const handleConfirmDelete = async () => {
        if (!confirmDialog) return;

        if (confirmDialog.type === 'module') {
            const moduleId = confirmDialog.id;
            log('Module Delete Confirmed', { moduleId });

            // Add to deleting set for animation
            setDeletingModules(prev => new Set([...prev, moduleId]));

            // Wait for animation
            await new Promise(resolve => setTimeout(resolve, 300));

            // Actually delete - device handles removing related amounts
            if (onToggleModule) {
                onToggleModule(moduleId, false);
            }

            // Clean up
            setDeletingModules(prev => {
                const next = new Set(prev);
                next.delete(moduleId);
                return next;
            });
        } else if (confirmDialog.type === 'wire') {
            const { source, target, param } = confirmDialog;
            log('Wire Delete Confirmed', { source, target, param });

            // Delete the wire (disable modulation)
            // API signature: toggleModulation(targetParam, sourceModule, enabled)
            if (onToggleModulation) {
                onToggleModulation(param, source, false);
            }
        }

        // Clear dialog and selection
        setConfirmDialog(null);
        clearSelection();
    };

    // Cancel deletion
    const handleCancelDelete = () => {
        log('Delete Cancelled', { dialog: confirmDialog });
        setConfirmDialog(null);
    };

    // Handle module add from drawer
    const handleAddModule = (moduleId) => {
        log('Module Added', { moduleId });
        if (onToggleModule) {
            onToggleModule(moduleId, true);
        }
    };

    // Handle module remove (now shows confirmation)
    const handleRemoveModule = (moduleId) => {
        showDeleteConfirmation('module', moduleId);
    };

    // Start wiring from a mod/control source
    const handleStartWiring = (moduleId, moduleType) => {
        log('Wiring Started', { moduleId, moduleType });
        setWiringFrom({ moduleId, type: moduleType });
    };

    // Handle wire drop on a parameter
    const handleWireDrop = (targetModule, targetParam) => {
        if (!wiringFrom || !onToggleModulation) return;

        log('Wire Created', {
            source: wiringFrom.moduleId,
            target: targetModule,
            param: targetParam
        });
        // API signature: toggleModulation(targetParam, sourceModule, enabled)
        onToggleModulation(targetParam, wiringFrom.moduleId, true);

        // If this was a pending module drop, clear pending state
        if (pendingModule && pendingModule.moduleId === wiringFrom.moduleId) {
            setPendingModule(null);
        }

        setWiringFrom(null);
        setWiringMousePos(null);
    };

    // Cancel wiring (and remove pending module if exists)
    const handleCancelWiring = (e) => {
        // Only cancel if clicking on workspace background, not on a node
        if (e && e.target.closest('.ap-node')) return;

        if (pendingModule) {
            log('Pending Module Cancelled', { moduleId: pendingModule.moduleId });
            // Just clear the pending state - no API call needed since we never added it
            // Show delete animation briefly
            setDeletingModules(prev => new Set([...prev, pendingModule.moduleId]));
            setTimeout(() => {
                setDeletingModules(prev => {
                    const next = new Set(prev);
                    next.delete(pendingModule.moduleId);
                    return next;
                });
            }, 300);
            setPendingModule(null);
        }

        setWiringFrom(null);
        setWiringMousePos(null);
    };

    // Keyboard handler for delete and escape
    useEffect(() => {
        const handleKeyDown = (e) => {
            // Don't handle if typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                if (selection.type === 'module') {
                    showDeleteConfirmation('module', selection.moduleId);
                } else if (selection.type === 'wire') {
                    showDeleteConfirmation('wire', selection.wireKey);
                }
            }

            if (e.key === 'Escape') {
                if (confirmDialog) {
                    handleCancelDelete();
                } else if (wiringFrom) {
                    handleCancelWiring();
                } else {
                    clearSelection();
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [selection, confirmDialog, wiringFrom]);

    return (
        <div className="ap-patch-editor" onMouseUp={handleCancelWiring}>
            {/* Patches List */}
            <PatchesList
                patches={patchList}
                currentIndex={currentIndex}
                onSelect={handleSelectPatch}
                onCreate={onCreatePatch}
                onDelete={onDeletePatch}
                onRename={onRenamePatch}
                onMove={onMovePatch}
                isConnected={isConnected}
                isLoading={isLoading}
                loadingIndex={loadingIndex}
            />

            {/* Module Drawer */}
            <ModuleDrawer
                moduleDefinitions={moduleDefinitions}
                enabledModules={enabledModules}
                onAddModule={handleAddModule}
                currentPatch={currentPatch}
                pendingModuleId={pendingModule?.moduleId}
            />

            {/* Node Workspace with Loading Overlay */}
            <div className="ap-workspace-container">
                <NodeWorkspace
                    topology={topology}
                    moduleDefinitions={moduleDefinitions}
                    currentPatch={currentPatch}
                    enabledModules={enabledModules}
                    nodePositions={nodePositions}
                    onNodePositionChange={(id, pos) => setNodePositions(prev => ({ ...prev, [id]: pos }))}
                    onSelectModule={handleSelectModule}
                    onSelectWire={handleSelectWire}
                    onClearSelection={clearSelection}
                    selection={selection}
                    deletingModules={deletingModules}
                    pendingModule={pendingModule}
                    setPendingModule={setPendingModule}
                    onAddModule={handleAddModule}
                    onToggleModule={onToggleModule}
                    onRemoveModule={handleRemoveModule}
                    wiringFrom={wiringFrom}
                    onStartWiring={handleStartWiring}
                    onWireDrop={handleWireDrop}
                    onWiringMouseMove={setWiringMousePos}
                    wiringMousePos={wiringMousePos}
                    modConnections={modConnections}
                    onUpdateParam={onUpdateParam}
                    onUpdateModAmount={onUpdateModAmount}
                    log={log}
                />
                <LoadingOverlay isLoading={isLoading} isVisible={isLoading} />
            </div>

            {/* Confirmation Dialog */}
            {confirmDialog && (
                <ConfirmDialog
                    dialog={confirmDialog}
                    onConfirm={handleConfirmDelete}
                    onCancel={handleCancelDelete}
                />
            )}
        </div>
    );
}

//======================================================================
// PATCHES LIST
//======================================================================

function PatchesList({ patches, currentIndex, onSelect, onCreate, onDelete, onRename, onMove, isConnected, isLoading, loadingIndex }) {
    const [dragIndex, setDragIndex] = useState(null);
    const [editingIndex, setEditingIndex] = useState(null);
    const [editingName, setEditingName] = useState('');

    // Determine which index to highlight (loading takes precedence for immediate feedback)
    const highlightIndex = loadingIndex !== null ? loadingIndex : currentIndex;

    const handleDragStart = (index) => {
        setDragIndex(index);
    };

    const handleDragOver = (index, e) => {
        e.preventDefault();
    };

    const handleDrop = (targetIndex) => {
        if (dragIndex !== null && dragIndex !== targetIndex && onMove) {
            onMove(dragIndex, targetIndex);
        }
        setDragIndex(null);
    };

    const handleRename = (index) => {
        setEditingIndex(index);
        // Find patch by index (patches may have non-sequential indices)
        const patch = patches?.find(p => (typeof p === 'object' ? p.index : patches.indexOf(p)) === index);
        const patchName = typeof patch === 'object' ? patch.name : (patch || '');
        setEditingName(patchName);
    };

    const handleRenameSubmit = () => {
        if (editingIndex !== null && onRename) {
            onRename(editingIndex, editingName);
        }
        setEditingIndex(null);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleRenameSubmit();
        } else if (e.key === 'Escape') {
            setEditingIndex(null);
        }
    };

    return (
        <div className="ap-patches-list">
            <div className="ap-patches-header">
                <span>PATCHES</span>
            </div>
            <div className="ap-patches-scroll">
                {!isConnected && (
                    <div className="ap-patches-empty">
                        <p>Not connected</p>
                    </div>
                )}
                {isConnected && (!patches || patches.length === 0) && (
                    <div className="ap-patches-empty">
                        <p>Loading...</p>
                    </div>
                )}
                {patches && patches.map((patch, idx) => {
                    // Handle both object format { index, name } and string format
                    const patchIndex = typeof patch === 'object' ? patch.index : idx;
                    const patchName = typeof patch === 'object' ? patch.name : patch;

                    const isHighlighted = patchIndex === highlightIndex;
                    const isDragging = patchIndex === dragIndex;

                    return (
                        <div
                            key={patchIndex}
                            className={`ap-patch-item ${isHighlighted ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isLoading ? 'loading-disabled' : ''}`}
                            draggable={!isLoading}
                            onDragStart={() => !isLoading && handleDragStart(patchIndex)}
                            onDragOver={(e) => !isLoading && handleDragOver(patchIndex, e)}
                            onDrop={() => !isLoading && handleDrop(patchIndex)}
                            onClick={() => !isLoading && onSelect && onSelect(patchIndex)}
                        >
                            {editingIndex === patchIndex ? (
                                <input
                                    className="ap-input ap-patch-name-input"
                                    value={editingName}
                                    onChange={(e) => setEditingName(e.target.value)}
                                    onBlur={handleRenameSubmit}
                                    onKeyDown={handleKeyDown}
                                    autoFocus
                                />
                            ) : (
                                <>
                                    <span className="ap-patch-name">{patchName}</span>
                                    <div className="ap-patch-actions">
                                        <button
                                            className="ap-patch-action"
                                            onClick={(e) => { e.stopPropagation(); handleRename(patchIndex); }}
                                            title="Rename"
                                        >
                                            E
                                        </button>
                                        <button
                                            className="ap-patch-action ap-patch-delete"
                                            onClick={(e) => { e.stopPropagation(); onDelete && onDelete(patchIndex); }}
                                            title="Delete"
                                        >
                                            X
                                        </button>
                                    </div>
                            </>
                        )}
                    </div>
                    );
                })}
            </div>
            <button className="ap-btn ap-btn-primary ap-patches-new" onClick={onCreate}>
                + NEW
            </button>
        </div>
    );
}

//======================================================================
// MODULE DRAWER
//======================================================================

function ModuleDrawer({ moduleDefinitions, enabledModules, onAddModule, currentPatch, pendingModuleId }) {
    const [showJson, setShowJson] = useState(false);

    return (
        <div className="ap-module-drawer">
            <div className="ap-drawer-header">
                <span>MODULES</span>
            </div>
            <div className="ap-drawer-scroll">
                <DrawerSection
                    title="AUDIO"
                    modules={moduleDefinitions.audio}
                    enabledModules={enabledModules}
                    onAddModule={onAddModule}
                    pendingModuleId={pendingModuleId}
                />
                <DrawerSection
                    title="MOD"
                    modules={moduleDefinitions.mod}
                    enabledModules={enabledModules}
                    onAddModule={onAddModule}
                    pendingModuleId={pendingModuleId}
                />
                <DrawerSection
                    title="CONTROL"
                    modules={moduleDefinitions.control}
                    enabledModules={enabledModules}
                    onAddModule={onAddModule}
                    pendingModuleId={pendingModuleId}
                />
            </div>
            <div className="ap-drawer-footer">
                <button
                    className="ap-btn ap-btn-small ap-btn-secondary"
                    onClick={() => setShowJson(true)}
                    disabled={!currentPatch}
                >
                    View JSON
                </button>
            </div>
            {showJson && currentPatch && (
                <JsonPopover
                    patch={currentPatch}
                    onClose={() => setShowJson(false)}
                />
            )}
        </div>
    );
}

function DrawerSection({ title, modules, enabledModules, onAddModule, pendingModuleId }) {
    // Filter to only show modules NOT in workspace (and not pending)
    const availableModules = modules.filter(m =>
        !enabledModules.has(m.id) && m.id !== pendingModuleId
    );

    if (availableModules.length === 0) return null;

    const handleDragStart = (e, moduleId) => {
        e.dataTransfer.setData('moduleId', moduleId);
        e.dataTransfer.effectAllowed = 'copy';
    };

    const handleClick = (module) => {
        // All modules can be clicked to add at default position
        onAddModule(module.id);
    };

    return (
        <div className="ap-drawer-section">
            <div className="ap-drawer-section-title">{title}</div>
            {availableModules.map(module => (
                <div
                    key={module.id}
                    className="ap-drawer-module"
                    draggable
                    onDragStart={(e) => handleDragStart(e, module.id)}
                    onClick={() => handleClick(module)}
                >
                    {module.name}
                </div>
            ))}
        </div>
    );
}

//======================================================================
// JSON POPOVER
//======================================================================

function JsonPopover({ patch, onClose }) {
    const popoverRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        const handleClick = (e) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target)) {
                onClose();
            }
        };
        // Use setTimeout to avoid immediate close from the button click
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClick);
        }, 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClick);
        };
    }, [onClose]);

    // Close on Escape
    useEffect(() => {
        const handleKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [onClose]);

    const jsonString = JSON.stringify(patch, null, 2);

    return (
        <div className="ap-json-popover" ref={popoverRef}>
            <div className="ap-json-popover-header">
                <span>Patch JSON</span>
                <button className="ap-json-popover-close" onClick={onClose}>X</button>
            </div>
            <pre className="ap-json-popover-content">{jsonString}</pre>
        </div>
    );
}

//======================================================================
// CONFIRM DIALOG COMPONENT
//======================================================================

function ConfirmDialog({ dialog, onConfirm, onCancel }) {
    // Build message based on dialog type
    let title, message;

    if (dialog.type === 'module') {
        title = `Delete ${dialog.name}?`;
        const lines = [];

        if (dialog.impact.routesRemoved.length > 0) {
            lines.push('This will remove:');
            dialog.impact.routesRemoved.forEach(r => {
                lines.push(`  - ${r.source} → ${r.param} (amount: ${r.amount})`);
            });
        }

        if (dialog.impact.orphanedModules.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push('This will also disconnect:');
            dialog.impact.orphanedModules.forEach(m => {
                lines.push(`  - ${m} (no remaining targets)`);
            });
        }

        if (lines.length === 0) {
            lines.push('This module has no active connections.');
        }

        message = lines.join('\n');
    } else if (dialog.type === 'wire') {
        title = 'Delete Connection?';
        message = `Remove ${dialog.source} → ${dialog.param}${dialog.amount !== undefined ? ` (amount: ${dialog.amount})` : ''}`;
    }

    return (
        <div className="ap-modal-overlay">
            <div className="ap-confirm-dialog">
                <div className="ap-confirm-header">{title}</div>
                <pre className="ap-confirm-body">{message}</pre>
                <div className="ap-confirm-actions">
                    <button className="ap-btn ap-btn-secondary" onClick={onCancel}>Cancel</button>
                    <button className="ap-btn ap-btn-danger" onClick={onConfirm}>Delete</button>
                </div>
            </div>
        </div>
    );
}

//======================================================================
// NODE WORKSPACE
//======================================================================

function NodeWorkspace({
    topology,
    moduleDefinitions,
    currentPatch,
    enabledModules,
    nodePositions,
    onNodePositionChange,
    onSelectModule,
    onSelectWire,
    onClearSelection,
    selection,
    deletingModules,
    pendingModule,
    setPendingModule,
    onAddModule,
    onToggleModule,
    onRemoveModule,
    wiringFrom,
    onStartWiring,
    onWireDrop,
    onWiringMouseMove,
    wiringMousePos,
    modConnections,
    onUpdateParam,
    onUpdateModAmount,
    log = () => {}  // Default to no-op if not provided
}) {
    const workspaceRef = useRef(null);
    const [draggingNode, setDraggingNode] = useState(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [hoverTarget, setHoverTarget] = useState(null); // { module, param }
    const [isDragOver, setIsDragOver] = useState(false);

    // Port position registry - tracks actual DOM positions of all ports
    // Use ref to collect positions without triggering re-renders
    const portPositionsRef = useRef({});
    const [portPositions, setPortPositions] = useState({});
    const positionUpdateTimeoutRef = useRef(null);

    // Callback for nodes to report their port positions
    // Collects in ref, then batches a single state update
    const handlePortPositionChange = useCallback((portId, globalPos) => {
        const wsRect = workspaceRef.current?.getBoundingClientRect();
        if (!wsRect) return;

        // Store in ref (no re-render)
        const newPos = {
            x: globalPos.x - wsRect.left,
            y: globalPos.y - wsRect.top
        };

        // Only update if position actually changed
        const oldPos = portPositionsRef.current[portId];
        if (oldPos && Math.abs(oldPos.x - newPos.x) < 1 && Math.abs(oldPos.y - newPos.y) < 1) {
            return; // Position unchanged, skip
        }

        portPositionsRef.current[portId] = newPos;

        // Debounce the state update - short delay for batching but fast enough for drag
        if (positionUpdateTimeoutRef.current) {
            clearTimeout(positionUpdateTimeoutRef.current);
        }
        positionUpdateTimeoutRef.current = setTimeout(() => {
            setPortPositions({ ...portPositionsRef.current });
        }, 10);
    }, []);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (positionUpdateTimeoutRef.current) {
                clearTimeout(positionUpdateTimeoutRef.current);
            }
        };
    }, []);

    // Default positions matching intended layout
    const DEFAULT_POSITIONS = {
        // Audio - oscillators stacked vertically, then filter/amp/effects flow right
        OSC0:     { x: 50, y: 50 },
        OSC1:     { x: 50, y: 160 },
        OSC2:     { x: 50, y: 270 },
        FILTER:   { x: 250, y: 50 },
        VAMP:     { x: 450, y: 50 },
        DISTORT:  { x: 650, y: 50 },
        DELAY:    { x: 650, y: 160 },

        // Mod sources - below audio
        MOD_ENV:  { x: 50, y: 420 },
        VAMP_ENV: { x: 250, y: 420 },
        GLFO:     { x: 50, y: 530 },
        VLFO:     { x: 250, y: 530 },

        // Control sources - bottom
        VELOCITY: { x: 50, y: 640 },
        PRESSURE: { x: 200, y: 640 },
        BEND:     { x: 350, y: 640 },
    };

    // Get default position for a module
    const getDefaultPosition = (moduleId, index) => {
        // Use predefined position if available
        if (DEFAULT_POSITIONS[moduleId]) {
            return DEFAULT_POSITIONS[moduleId];
        }

        // Fallback for unknown modules
        const allModules = [...moduleDefinitions.audio, ...moduleDefinitions.mod, ...moduleDefinitions.control];
        const moduleDef = allModules.find(m => m.id === moduleId);

        if (moduleDef?.type === 'audio') {
            return { x: 50 + index * 200, y: 50 };
        } else if (moduleDef?.type === 'mod') {
            return { x: 50 + index * 150, y: 420 };
        } else {
            return { x: 50 + index * 150, y: 640 };
        }
    };

    // Get enabled modules grouped by type
    // Modules show if: (1) enabled in patch, OR (2) alwaysEnabled in definition
    const enabledByType = useMemo(() => {
        const audio = [];
        const mod = [];
        const control = [];

        moduleDefinitions.audio.forEach(m => {
            if (enabledModules.has(m.id) || m.alwaysEnabled) audio.push(m);
        });
        moduleDefinitions.mod.forEach(m => {
            if (enabledModules.has(m.id) || m.alwaysEnabled) mod.push(m);
        });
        moduleDefinitions.control.forEach(m => {
            if (enabledModules.has(m.id) || m.alwaysEnabled) control.push(m);
        });

        return { audio, mod, control };
    }, [moduleDefinitions, enabledModules]);

    // Handle node drag
    const handleMouseDown = (moduleId, e) => {
        if (e.button !== 0) return;

        const rect = e.currentTarget.getBoundingClientRect();
        setDraggingNode(moduleId);
        setDragOffset({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        });
        e.preventDefault();
    };

    const handleMouseMove = (e) => {
        if (!draggingNode || !workspaceRef.current) return;

        const rect = workspaceRef.current.getBoundingClientRect();
        const newX = e.clientX - rect.left - dragOffset.x;
        const newY = e.clientY - rect.top - dragOffset.y;

        onNodePositionChange(draggingNode, { x: Math.max(0, newX), y: Math.max(0, newY) });
    };

    const handleMouseUp = () => {
        setDraggingNode(null);
    };

    useEffect(() => {
        if (draggingNode) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            return () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
        }
    }, [draggingNode, dragOffset]);

    // Build audio wires with proper parallel routing
    // OSCs -> Filter (parallel), Filter -> Amp, Amp -> Effects (chain)
    const audioWires = useMemo(() => {
        const wires = [];
        const modules = enabledByType.audio;

        // Find modules by category/role
        const oscillators = modules.filter(m => m.id.startsWith('OSC'));
        const filter = modules.find(m => m.id === 'FILTER');
        const amp = modules.find(m => m.id === 'VAMP');
        const effects = modules.filter(m => ['DISTORT', 'DELAY'].includes(m.id));

        // OSCs -> Filter (parallel)
        if (filter) {
            oscillators.forEach(osc => {
                wires.push({ from: osc.id, to: filter.id, type: 'audio' });
            });
        } else if (amp) {
            // No filter - OSCs go directly to amp
            oscillators.forEach(osc => {
                wires.push({ from: osc.id, to: amp.id, type: 'audio' });
            });
        }

        // Filter -> Amp
        if (filter && amp) {
            wires.push({ from: filter.id, to: amp.id, type: 'audio' });
        }

        // Amp -> Effects chain
        if (amp && effects.length > 0) {
            wires.push({ from: amp.id, to: effects[0].id, type: 'audio' });
            for (let i = 0; i < effects.length - 1; i++) {
                wires.push({ from: effects[i].id, to: effects[i + 1].id, type: 'audio' });
            }
        }

        return wires;
    }, [enabledByType.audio]);

    // Handle workspace mouse move for wiring
    const handleWorkspaceMouseMove = (e) => {
        if (wiringFrom && workspaceRef.current) {
            const rect = workspaceRef.current.getBoundingClientRect();
            onWiringMouseMove({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }
    };

    // Handle drag-and-drop from drawer
    const handleDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setIsDragOver(true);
    };

    const handleDragLeave = (e) => {
        // Only set false if leaving the workspace entirely
        if (!workspaceRef.current?.contains(e.relatedTarget)) {
            setIsDragOver(false);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragOver(false);

        const moduleId = e.dataTransfer.getData('moduleId');
        if (!moduleId) return;

        // Calculate drop position relative to workspace
        const rect = workspaceRef.current?.getBoundingClientRect();
        if (!rect) return;

        const dropPosition = {
            x: e.clientX - rect.left - 50,  // Center the node
            y: e.clientY - rect.top - 15
        };

        log('Module Dropped', { moduleId, position: dropPosition });

        // Set the position BEFORE adding module
        onNodePositionChange(moduleId, dropPosition);

        const moduleDef = findModuleDef(moduleId, moduleDefinitions);

        // For mod/control modules: set pending and start wiring (NO API call yet)
        // The API call happens when the wire is connected
        if (moduleDef?.type === 'mod' || moduleDef?.type === 'control') {
            setPendingModule({ moduleId, position: dropPosition });
            onStartWiring(moduleId, moduleDef.type);
            log('Pending Module Created', { moduleId, type: moduleDef.type });
        } else {
            // For audio modules: add immediately via API
            if (onAddModule) {
                onAddModule(moduleId);
            }
        }
    };

    // Handle workspace click to clear selection or cancel pending module
    const handleWorkspaceClick = (e) => {
        // Only handle clicks directly on the workspace, not on nodes
        if (e.target !== workspaceRef.current) return;

        // If we have a pending module, just clear it (no API call needed)
        if (pendingModule) {
            log('Pending Module Removed', { moduleId: pendingModule.moduleId });
            setPendingModule(null);
        }

        // Clear selection
        if (onClearSelection) {
            onClearSelection();
        }
    };

    // Parse selected wire to get target info for highlighting
    // wireKey format: "source:targetModule:targetParam"
    // NOTE: Must be before conditional return to satisfy React hooks rules
    const selectedWireTarget = useMemo(() => {
        if (selection?.type !== 'wire' || !selection?.wireKey) return null;
        const parts = selection.wireKey.split(':');
        if (parts.length !== 3) return null;
        return { module: parts[1], param: parts[2] };
    }, [selection]);

    if (!currentPatch) {
        return (
            <div className="ap-node-workspace">
                <div className="ap-workspace-empty">
                    <p>Select a patch to edit</p>
                </div>
            </div>
        );
    }

    return (
        <div
            className={`ap-node-workspace ${wiringFrom ? 'wiring' : ''} ${isDragOver ? 'drag-over' : ''}`}
            ref={workspaceRef}
            onMouseMove={handleWorkspaceMouseMove}
            onClick={handleWorkspaceClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* SVG layer for wires */}
            <svg className="ap-wires-layer">
                {/* Audio wires */}
                {audioWires.map((wire, i) => (
                    <Wire
                        key={`audio-${i}`}
                        from={wire.from}
                        to={wire.to}
                        type="audio"
                        portPositions={portPositions}
                    />
                ))}

                {/* Modulation wires */}
                {modConnections.map((conn, i) => {
                    const wireKey = `${conn.from}:${conn.toModule}:${conn.toParam}`;
                    return (
                        <ModWire
                            key={`mod-${i}`}
                            connection={conn}
                            wireKey={wireKey}
                            portPositions={portPositions}
                            isSelected={selection?.wireKey === wireKey}
                            onSelect={() => onSelectWire(wireKey)}
                        />
                    );
                })}

                {/* Wire being dragged */}
                {wiringFrom && wiringMousePos && (
                    <DraggingWire
                        fromModule={wiringFrom.moduleId}
                        mousePos={wiringMousePos}
                        portPositions={portPositions}
                    />
                )}
            </svg>

            {/* Audio nodes */}
            {enabledByType.audio.map((module, index) => {
                const pos = nodePositions[module.id] || getDefaultPosition(module.id, index);
                const isSelected = selection?.type === 'module' && selection?.moduleId === module.id;
                const isDeleting = deletingModules?.has(module.id);
                return (
                    <Node
                        key={module.id}
                        module={module}
                        topology={topology}
                        patch={currentPatch}
                        position={pos}
                        isSelected={isSelected}
                        isDeleting={isDeleting}
                        onMouseDown={(e) => handleMouseDown(module.id, e)}
                        onSelectModule={() => onSelectModule(module.id)}
                        onRemoveModule={() => onRemoveModule(module.id)}
                        wiringFrom={wiringFrom}
                        onParamDrop={onWireDrop}
                        onPortPositionChange={handlePortPositionChange}
                        selectedWireTarget={selectedWireTarget}
                        onUpdateParam={onUpdateParam}
                        onUpdateModAmount={onUpdateModAmount}
                    />
                );
            })}

            {/* Mod source nodes */}
            {enabledByType.mod.map((module, index) => {
                const pos = nodePositions[module.id] || getDefaultPosition(module.id, index);
                const isSelected = selection?.type === 'module' && selection?.moduleId === module.id;
                const isDeleting = deletingModules?.has(module.id);
                return (
                    <Node
                        key={module.id}
                        module={module}
                        topology={topology}
                        patch={currentPatch}
                        position={pos}
                        isSelected={isSelected}
                        isDeleting={isDeleting}
                        onMouseDown={(e) => handleMouseDown(module.id, e)}
                        onSelectModule={() => onSelectModule(module.id)}
                        onRemoveModule={() => onRemoveModule(module.id)}
                        onStartWiring={() => onStartWiring(module.id, module.type)}
                        isWiringSource={wiringFrom?.moduleId === module.id}
                        onPortPositionChange={handlePortPositionChange}
                        selectedWireTarget={selectedWireTarget}
                        onUpdateParam={onUpdateParam}
                        onUpdateModAmount={onUpdateModAmount}
                    />
                );
            })}

            {/* Control nodes */}
            {enabledByType.control.map((module, index) => {
                const pos = nodePositions[module.id] || getDefaultPosition(module.id, index);
                const isSelected = selection?.type === 'module' && selection?.moduleId === module.id;
                const isDeleting = deletingModules?.has(module.id);
                return (
                    <Node
                        key={module.id}
                        module={module}
                        topology={topology}
                        patch={currentPatch}
                        position={pos}
                        isSelected={isSelected}
                        isDeleting={isDeleting}
                        onMouseDown={(e) => handleMouseDown(module.id, e)}
                        onSelectModule={() => onSelectModule(module.id)}
                        onRemoveModule={() => onRemoveModule(module.id)}
                        onStartWiring={() => onStartWiring(module.id, module.type)}
                        isWiringSource={wiringFrom?.moduleId === module.id}
                        onPortPositionChange={handlePortPositionChange}
                        selectedWireTarget={selectedWireTarget}
                        onUpdateParam={onUpdateParam}
                        onUpdateModAmount={onUpdateModAmount}
                    />
                );
            })}

            {/* Pending module (dropped but not yet wired) */}
            {pendingModule && !enabledModules.has(pendingModule.moduleId) && (() => {
                const moduleDef = findModuleDef(pendingModule.moduleId, moduleDefinitions);
                if (!moduleDef) return null;
                const pos = nodePositions[pendingModule.moduleId] || pendingModule.position;
                return (
                    <Node
                        key={`pending-${pendingModule.moduleId}`}
                        module={moduleDef}
                        topology={topology}
                        patch={currentPatch}
                        position={pos}
                        isSelected={false}
                        isDeleting={deletingModules?.has(pendingModule.moduleId)}
                        isPending={true}
                        onMouseDown={(e) => handleMouseDown(pendingModule.moduleId, e)}
                        onSelectModule={() => {}}
                        onRemoveModule={() => {}}
                        onStartWiring={() => onStartWiring(pendingModule.moduleId, moduleDef.type)}
                        isWiringSource={wiringFrom?.moduleId === pendingModule.moduleId}
                        onPortPositionChange={handlePortPositionChange}
                        selectedWireTarget={selectedWireTarget}
                        onUpdateParam={onUpdateParam}
                        onUpdateModAmount={onUpdateModAmount}
                    />
                );
            })()}
        </div>
    );
}

//======================================================================
// NODE COMPONENT
//======================================================================

function Node({
    module,
    topology,
    patch,
    position,
    isSelected,
    isDeleting,
    isPending,
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
    onUpdateModAmount
}) {
    const moduleData = patch?.[module.id];

    // Port refs for position tracking
    const headerInputRef = useRef(null);
    const headerOutputRef = useRef(null);
    const paramPortRefs = useRef({});

    const isAudioModule = module.type === 'audio';

    // Get key parameters to display with full range info
    const digestParams = useMemo(() => {
        if (!moduleData) return [];

        const params = [];
        Object.entries(moduleData).forEach(([key, value]) => {
            // Skip amount params and meta
            if (key.endsWith('_AMOUNT') || key === 'name' || key === 'version' || key === 'targets') return;
            if (typeof value === 'object' && value !== null) {
                // It's a parameter with range/initial/etc
                if (value.initial !== undefined) {
                    params.push({
                        key,
                        value: value.initial,
                        min: value.range?.[0] ?? 0,
                        max: value.range?.[1] ?? 1
                    });
                }
            }
        });

        return params.slice(0, 4); // Show up to 4 params
    }, [moduleData]);

    // Report port positions when mounted or position changes
    // Use useLayoutEffect for synchronous updates during drag
    useLayoutEffect(() => {
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

    // Build class list
    const classNames = ['ap-node', `ap-node-${module.type}`];
    if (isWiringSource) classNames.push('wiring-source');
    if (isSelected) classNames.push('selected');
    if (isDeleting) classNames.push('deleting');
    if (isPending) classNames.push('pending');

    return (
        <div
            className={classNames.join(' ')}
            style={{ left: position.x, top: position.y }}
            onMouseDown={onMouseDown}
        >
            <div className="ap-node-header" onClick={handleHeaderClick}>
                {/* Input port - audio modules only */}
                {isAudioModule && (
                    <div
                        ref={headerInputRef}
                        className="ap-node-port ap-node-port-header-in"
                    />
                )}
                {/* Delete button for removable modules */}
                {!module.alwaysEnabled && (
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
                {/* Output port - all modules */}
                <div
                    ref={headerOutputRef}
                    className={`ap-node-port ap-node-port-header-out ${isWiringSource ? 'active' : ''}`}
                    onMouseDown={(module.type === 'mod' || module.type === 'control') ? handlePortClick : undefined}
                    title={(module.type === 'mod' || module.type === 'control') ? "Drag to connect" : undefined}
                />
            </div>
            <div className="ap-node-body">
                {digestParams.map(param => {
                    // Check if this param is a valid target for the current wiring source
                    const canReceiveWire = wiringFrom &&
                        canSourceModulateParam(topology, wiringFrom.moduleId, param.key);

                    // Check if this param is the target of a selected wire
                    const isWireTarget = selectedWireTarget &&
                        selectedWireTarget.module === module.id &&
                        selectedWireTarget.param === param.key;

                    // Find AMOUNT params for this param
                    const amountParams = findAmountParamsForTarget(moduleData, param.key);

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
                                    className="ap-node-port ap-node-port-param-in"
                                />
                                <span className="ap-node-param-key">{param.key}</span>
                                <NodeParamSlider
                                    param={param}
                                    onUpdateParam={onUpdateParam}
                                />
                            </div>
                            {/* Amount sliders under param */}
                            {amountParams.map(amt => (
                                <div key={amt.source} className="ap-node-mod-amount">
                                    <span
                                        className="ap-mod-source-label"
                                        style={{ color: WIRE_COLORS[amt.source] }}
                                    >
                                        {amt.source.replace('_', ' ')}
                                    </span>
                                    <input
                                        type="range"
                                        className="ap-mod-amount-mini"
                                        min={amt.min}
                                        max={amt.max}
                                        step={0.01}
                                        value={amt.value}
                                        onChange={(e) => onUpdateModAmount && onUpdateModAmount(
                                            param.key,
                                            amt.source,
                                            parseFloat(e.target.value)
                                        )}
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                    />
                                    <span className="ap-mod-amount-value">{amt.value.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

//======================================================================
// NODE PARAM SLIDER - Inline slider with local state
//======================================================================

function NodeParamSlider({ param, onUpdateParam }) {
    const [localValue, setLocalValue] = useState(param.value);

    // Sync with external value changes
    useEffect(() => {
        setLocalValue(param.value);
    }, [param.value]);

    // Determine step size based on parameter type
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

    const handleChange = (e) => {
        setLocalValue(parseFloat(e.target.value));
    };

    const handleCommit = () => {
        if (onUpdateParam && localValue !== param.value) {
            onUpdateParam(param.key, localValue);
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
            <span className="ap-node-param-value">{formatValue(localValue)}</span>
        </>
    );
}

//======================================================================
// MODULATION WIRE COMPONENT
//======================================================================

function ModWire({ connection, wireKey, portPositions, isSelected, onSelect }) {
    const { from, toModule, toParam, amount } = connection;

    // Get port positions from registry
    const fromPort = portPositions[`${from}:out`];
    const toPort = portPositions[`${toModule}:${toParam}:in`];

    // Don't render until we have positions
    if (!fromPort || !toPort) return null;

    // Wire endpoints
    const x1 = fromPort.x;
    const y1 = fromPort.y;
    const x2 = toPort.x;
    const y2 = toPort.y;

    // Always use horizontal stubs - exit right, enter left
    // Scale offset based on vertical distance - more vertical = more horizontal stub needed
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const offset = Math.max(40, Math.min(200, dx / 3 + dy / 2));
    const cx1 = x1 + offset;
    const cy1 = y1;
    const cx2 = x2 - offset;
    const cy2 = y2;

    const color = WIRE_COLORS[from] || 'var(--ap-wire-mod)';
    const pathD = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;

    const handleClick = (e) => {
        e.stopPropagation();
        if (onSelect) {
            onSelect();
        }
    };

    return (
        <g className={`ap-mod-wire ${isSelected ? 'selected' : ''}`}>
            {/* Invisible wider path for easier clicking */}
            <path
                d={pathD}
                stroke="transparent"
                strokeWidth={24}
                fill="none"
                style={{ cursor: 'pointer' }}
                onClick={handleClick}
            />
            {/* Visible wire path */}
            <path
                d={pathD}
                stroke={color}
                strokeWidth={isSelected ? 3 : 2}
                fill="none"
                strokeDasharray="4,2"
                style={{ pointerEvents: 'none' }}
            />
            {/* Selection glow effect */}
            {isSelected && (
                <path
                    d={pathD}
                    stroke={color}
                    strokeWidth={6}
                    fill="none"
                    strokeDasharray="4,2"
                    opacity={0.3}
                    style={{ pointerEvents: 'none' }}
                />
            )}
            {/* Amount label */}
            <text
                x={(x1 + x2) / 2}
                y={(y1 + y2) / 2 - 5}
                fill={color}
                fontSize="8"
                textAnchor="middle"
                style={{ fontFamily: 'var(--ap-font-family)', pointerEvents: 'none' }}
            >
                {amount}
            </text>
        </g>
    );
}

//======================================================================
// DRAGGING WIRE COMPONENT
//======================================================================

function DraggingWire({ fromModule, mousePos, portPositions }) {
    // Get source port position from registry
    const fromPort = portPositions[`${fromModule}:out`];

    // Don't render until we have position
    if (!fromPort) return null;

    const x1 = fromPort.x;
    const y1 = fromPort.y;
    const x2 = mousePos.x;
    const y2 = mousePos.y;

    // Always use horizontal stubs - exit right, enter left
    // Scale offset based on vertical distance - more vertical = more horizontal stub needed
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const offset = Math.max(40, Math.min(200, dx / 3 + dy / 2));
    const cx1 = x1 + offset;
    const cy1 = y1;
    const cx2 = x2 - offset;
    const cy2 = y2;

    const color = WIRE_COLORS[fromModule] || 'var(--ap-wire-mod)';

    return (
        <path
            d={`M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`}
            stroke={color}
            strokeWidth={2}
            fill="none"
            strokeDasharray="4,2"
            opacity={0.7}
            className="ap-dragging-wire"
        />
    );
}

//======================================================================
// WIRE COMPONENT (Audio wires: header output -> header input)
//======================================================================

function Wire({ from, to, type, portPositions }) {
    // Get port positions from registry
    const fromPort = portPositions[`${from}:out`];
    const toPort = portPositions[`${to}:in`];

    // Don't render until we have positions
    if (!fromPort || !toPort) return null;

    // Wire endpoints
    const x1 = fromPort.x;
    const y1 = fromPort.y;
    const x2 = toPort.x;
    const y2 = toPort.y;

    // Always use horizontal stubs - exit right, enter left
    // Scale offset based on vertical distance - more vertical = more horizontal stub needed
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const offset = Math.max(40, Math.min(200, dx / 3 + dy / 2));
    const cx1 = x1 + offset;
    const cy1 = y1;
    const cx2 = x2 - offset;
    const cy2 = y2;

    const strokeColor = type === 'audio' ? 'var(--ap-wire-audio)' : 'var(--ap-wire-mod)';
    const strokeWidth = type === 'audio' ? 3 : 2;
    const strokeDash = type === 'audio' ? 'none' : '4,4';

    return (
        <path
            d={`M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDash}
            fill="none"
            className="ap-wire"
        />
    );
}

//======================================================================
// NODE CONTEXT MENU
//======================================================================

function NodeContextMenu({
    moduleId,
    moduleDefinitions,
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
    useEffect(() => {
        const handleClick = (e) => {
            if (!e.target.closest('.ap-context-menu')) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [onClose]);

    // Find module definition
    const allModules = [...moduleDefinitions.audio, ...moduleDefinitions.mod, ...moduleDefinitions.control];
    const moduleDef = allModules.find(m => m.id === moduleId);
    const canRemove = moduleDef && !moduleDef.alwaysEnabled;
    const isModSource = moduleDef?.type === 'mod' || moduleDef?.type === 'control';

    // Extract parameters from moduleData
    const parameters = useMemo(() => {
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
    // New model: Check for {TARGET}_{SOURCE}_AMOUNT params in target modules
    const routedTargets = useMemo(() => {
        if (!isModSource || !patch) return [];
        const targets = [];

        // Get this source's valid targets list
        const sourceData = patch[moduleId];
        const validTargets = sourceData?.targets || [];

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
                            amount: amount || 0
                        });
                    }
                }
            });
        });

        return targets;
    }, [isModSource, moduleId, patch]);

    // Constrain position to viewport
    const constrainedPos = useMemo(() => {
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
                                    min="-100"
                                    max="100"
                                    value={target.amount}
                                    onChange={(e) => onUpdateModAmount(
                                        target.param,
                                        moduleId,
                                        parseInt(e.target.value)
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
                {canRemove && (
                    <button
                        className="ap-btn ap-btn-danger ap-btn-small ap-mt-md"
                        onClick={onRemove}
                    >
                        Remove Module
                    </button>
                )}
            </div>
        </div>
    );
}

//======================================================================
// PARAMETER CONTROL
//======================================================================

function ParameterControl({ moduleId, param, onUpdate }) {
    const [localValue, setLocalValue] = useState(param.value);

    useEffect(() => {
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

function ModulationControl({ moduleId, param, moduleData, patch, onToggle, onAmountChange }) {
    // Get sources that CAN modulate this param (from source's targets array)
    const availableSources = MOD_SOURCES.filter(source => {
        const sourceData = patch?.[source];
        return sourceData?.targets?.includes(param.key);
    });

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

                    return (
                        <div key={source} className="ap-mod-source-row">
                            <label className="ap-mod-source-toggle">
                                <input
                                    type="checkbox"
                                    checked={isActive}
                                    onChange={(e) => onToggle(param.key, source, e.target.checked)}
                                />
                                <span className="ap-mod-source-name" style={{ color: WIRE_COLORS[source] }}>
                                    {source.replace('_', ' ')}
                                </span>
                            </label>
                            {isActive && (
                                <input
                                    type="range"
                                    className="ap-slider ap-mod-amount-slider"
                                    min="-100"
                                    max="100"
                                    value={amount}
                                    onChange={(e) => onAmountChange(param.key, source, parseInt(e.target.value))}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
