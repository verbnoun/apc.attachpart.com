/**
 * Patch Editor Window - Node-based patch editing
 *
 * Layout: Patches List | Module Drawer | Node Workspace
 *
 * Features:
 * - Patch list with drag-to-reorder
 * - Module drawer with synth-defined group sections
 * - Node workspace with free positioning
 * - Chain wires (auto, from topology chains)
 * - Modulation wires (user-created, editable)
 *
 * Topology-driven: synth defines groups, chains, colors, and fixed/removable behavior.
 */

const { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } = React;

//======================================================================
// TOPOLOGY → MODULE STATE
//======================================================================

/**
 * Build module state from topology
 * Returns { allModules: Map, groups: [], modSourceIds: Set, chains: [] }
 */
function buildModuleState(topology) {
    const empty = { allModules: new Map(), groups: [], modSourceIds: new Set(), chains: [] };
    if (!topology?.groups) return empty;

    const allModules = new Map();
    const groups = topology.groups.map(g => {
        const group = {
            id: g.id,
            name: g.name,
            color: g.color || '#888',
            fixed: g.fixed === true,
            modules: (g.modules || []).map(m => ({
                id: m.id,
                name: m.name,
                groupId: g.id,
                groupColor: g.color || '#888',
                fixed: g.fixed === true
            }))
        };
        group.modules.forEach(m => allModules.set(m.id, m));
        return group;
    });

    const modSourceIds = new Set(Object.keys(topology.mod_targets || {}));
    const chains = topology.chains || [];

    // Track which modules participate in chains
    const chainModuleIds = new Set();
    chains.forEach(chain => {
        (chain.stages || []).forEach(stage => {
            stage.forEach(id => chainModuleIds.add(id));
        });
    });

    // Annotate modules with chain/mod membership
    allModules.forEach((mod, id) => {
        mod.isChainMember = chainModuleIds.has(id);
        mod.isModSource = modSourceIds.has(id);
    });

    return { allModules, groups, modSourceIds, chains, chainModuleIds };
}

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
function findModuleDef(moduleId, moduleState) {
    return moduleState?.allModules?.get(moduleId) || null;
}

/**
 * Find all AMOUNT params for a given target parameter
 * Returns array of { source, key, value, min, max }
 */
function findAmountParamsForTarget(moduleData, targetParamKey, modSourceIds) {
    if (!moduleData) return [];
    const amounts = [];
    const sources = modSourceIds ? Array.from(modSourceIds) : [];

    sources.forEach(source => {
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
function calculateDeletionImpact(patch, moduleId, modConnections) {
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
            impact.orphanedModules.push(sourceId);
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
    deviceKey,
    modulesCol,      // DOM element for modules column portal
    workspaceCol,    // DOM element for workspace column portal
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
    onLiveChange,
    onToggleModulation,
    onUpdateModAmount,
    isConnected = true,
    addLog = (msg, type) => console.log(`[${type}] ${msg}`),
    midiState,
    controllerConfig
}) {
    // Create logger that uses the addLog prop
    const log = useMemo(() => createPatchLogger(addLog), [addLog]);

    // Build module state from topology (groups, chains, modSourceIds)
    const moduleState = useMemo(() => buildModuleState(topology), [topology]);

    // Check if a module is fixed (non-removable) based on its group's fixed flag
    const isFixedModule = useCallback((moduleId) => {
        const mod = moduleState.allModules.get(moduleId);
        return mod?.fixed === true;
    }, [moduleState]);

    // Node positions — persisted per device + patch in localStorage
    const [nodePositions, setNodePositions] = useState(() => {
        if (deviceKey && currentIndex >= 0) {
            return WorkspacePersistence.loadNodePositions(deviceKey, currentIndex) || {};
        }
        return {};
    });
    const nodePositionsRef = useRef(nodePositions);
    nodePositionsRef.current = nodePositions;

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

    // Optimistic state - changes confirmed by ok but patch not yet refreshed
    const [optimisticDeletes, setOptimisticDeletes] = useState(new Set());  // moduleIds
    const [optimisticAdds, setOptimisticAdds] = useState(new Set());        // moduleIds
    const [optimisticWireDeletes, setOptimisticWireDeletes] = useState(new Set()); // wireKeys
    const [optimisticWireAdds, setOptimisticWireAdds] = useState(new Set());       // wireKeys

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

    // Clear optimistic state and stale port positions when real patch data arrives
    useEffect(() => {
        setOptimisticDeletes(new Set());
        setOptimisticAdds(new Set());
        setOptimisticWireDeletes(new Set());
        setOptimisticWireAdds(new Set());
    }, [currentPatch]);

    // Reload persisted node positions when switching patches
    useEffect(() => {
        if (deviceKey && currentIndex >= 0) {
            const saved = WorkspacePersistence.loadNodePositions(deviceKey, currentIndex);
            setNodePositions(saved || {});
        } else {
            setNodePositions({});
        }
    }, [deviceKey, currentIndex]);

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
    // Fixed groups: all modules always enabled
    // Non-fixed groups: enabled if module has params in patch OR has active modulation routes
    const enabledModules = useMemo(() => {
        if (!currentPatch) return new Set();
        const enabled = new Set();
        const metadataKeys = ['name', 'version', 'index'];

        // First pass: collect all AMOUNT param sources (active routes)
        const activeSources = new Set();
        const modSources = Array.from(moduleState.modSourceIds);

        Object.values(currentPatch).forEach(moduleData => {
            if (typeof moduleData !== 'object' || !moduleData) return;
            Object.keys(moduleData).forEach(key => {
                if (!key.endsWith('_AMOUNT')) return;
                const withoutAmount = key.slice(0, -7);
                modSources.forEach(src => {
                    if (withoutAmount.endsWith('_' + src)) {
                        activeSources.add(src);
                    }
                });
            });
        });

        // Fixed groups: all modules always enabled
        moduleState.groups.forEach(group => {
            if (group.fixed) {
                group.modules.forEach(m => enabled.add(m.id));
            }
        });

        // Non-fixed modules: enabled from patch keys
        Object.keys(currentPatch).forEach(key => {
            if (metadataKeys.includes(key)) return;
            const moduleData = currentPatch[key];
            const moduleKeys = Object.keys(moduleData || {});
            const hasParams = moduleKeys.some(k => k !== 'name' && k !== 'targets');
            if (hasParams) {
                enabled.add(key);
            }
        });

        // Add mod sources that have active routes
        activeSources.forEach(src => enabled.add(src));

        // Apply optimistic changes
        optimisticDeletes.forEach(id => enabled.delete(id));
        optimisticAdds.forEach(id => enabled.add(id));

        return enabled;
    }, [currentPatch, optimisticDeletes, optimisticAdds, moduleState]);

    // Extract existing modulation connections from patch
    // Fixed-group mod sources: wires derived from topology.mod_targets (non-editable)
    // Non-fixed mod sources: wires derived from _AMOUNT params (editable)
    const modConnections = useMemo(() => {
        if (!currentPatch) return [];
        const connections = [];
        const knownSources = Array.from(moduleState.modSourceIds);

        // Fixed wires: mod sources in fixed groups → targets via topology
        moduleState.groups.forEach(group => {
            if (!group.fixed) return;
            group.modules.forEach(mod => {
                if (!moduleState.modSourceIds.has(mod.id)) return;
                const targets = topology?.mod_targets?.[mod.id] || [];
                targets.forEach(targetParam => {
                    for (const [modKey, modData] of Object.entries(currentPatch)) {
                        if (typeof modData !== 'object' || !modData) continue;
                        if (['name', 'version', 'index'].includes(modKey)) continue;
                        if (modData[targetParam]) {
                            connections.push({ from: mod.id, toModule: modKey, toParam: targetParam, amount: null, fixed: true });
                            break;
                        }
                    }
                });
            });
        });

        // Editable wires: from _AMOUNT params (non-fixed sources only)
        Object.entries(currentPatch).forEach(([moduleId, moduleData]) => {
            if (typeof moduleData !== 'object' || !moduleData) return;
            if (['name', 'version', 'index'].includes(moduleId)) return;

            Object.entries(moduleData).forEach(([key, value]) => {
                if (!key.endsWith('_AMOUNT')) return;
                const withoutAmount = key.slice(0, -7);
                let source = null;
                let target = null;
                for (const src of knownSources) {
                    if (withoutAmount.endsWith('_' + src)) {
                        source = src;
                        target = withoutAmount.slice(0, -(src.length + 1));
                        break;
                    }
                }
                if (source && target) {
                    // Skip if source is in a fixed group (already handled as fixed wire)
                    const sourceMod = moduleState.allModules.get(source);
                    if (sourceMod?.fixed) return;
                    connections.push({
                        from: source,
                        toModule: moduleId,
                        toParam: target,
                        amount: typeof value === 'object' ? value.initial : value
                    });
                }
            });
        });

        // Apply optimistic wire changes (only to non-fixed wires)
        const filtered = connections.filter(conn => {
            if (conn.fixed) return true;
            const wireKey = `${conn.from}:${conn.toModule}:${conn.toParam}`;
            return !optimisticWireDeletes.has(wireKey);
        });

        // Add optimistically added wires (with default amount)
        optimisticWireAdds.forEach(wireKey => {
            const [from, toModule, toParam] = wireKey.split(':');
            if (!filtered.some(c => c.from === from && c.toModule === toModule && c.toParam === toParam)) {
                filtered.push({ from, toModule, toParam, amount: 0.5 });
            }
        });

        return filtered;
    }, [currentPatch, optimisticWireDeletes, optimisticWireAdds, moduleState, topology]);

    // Select a module (click on header)
    const handleSelectModule = (moduleId) => {
        if (wiringFrom) return; // Don't select while wiring
        if (isFixedModule(moduleId)) return; // Fixed modules not selectable
        log('Module Selected', { moduleId });
        setSelection({
            type: 'module',
            moduleId,
            wireKey: null
        });
    };

    // Select a wire (click on wire path)
    const handleSelectWire = (wireKey) => {
        // Fixed wires not selectable
        const conn = modConnections.find(c => `${c.from}:${c.toModule}:${c.toParam}` === wireKey);
        if (conn?.fixed) return;
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
            const impact = calculateDeletionImpact(currentPatch, id, modConnections);
            const moduleDef = findModuleDef(id, moduleState);
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

            // Call API and await result
            let result = null;
            if (onToggleModule) {
                result = await onToggleModule(moduleId, false);
            }

            // On success, apply optimistic delete (module disappears immediately)
            if (result?.status === 'ok') {
                setOptimisticDeletes(prev => new Set([...prev, moduleId]));
            }

            // Clean up animation state
            setDeletingModules(prev => {
                const next = new Set(prev);
                next.delete(moduleId);
                return next;
            });
        } else if (confirmDialog.type === 'wire') {
            const { source, target, param } = confirmDialog;
            const wireKey = `${source}:${target}:${param}`;
            log('Wire Delete Confirmed', { source, target, param });

            // Call API and await result
            let result = null;
            if (onToggleModulation) {
                result = await onToggleModulation(param, source, false);
            }

            // On success, apply optimistic wire delete
            if (result?.status === 'ok') {
                setOptimisticWireDeletes(prev => new Set([...prev, wireKey]));
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
    const handleAddModule = async (moduleId) => {
        log('Module Added', { moduleId });

        // Call API and await result
        let result = null;
        if (onToggleModule) {
            result = await onToggleModule(moduleId, true);
        }

        // On success, apply optimistic add
        if (result?.status === 'ok') {
            setOptimisticAdds(prev => new Set([...prev, moduleId]));
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
    const handleWireDrop = async (targetModule, targetParam) => {
        if (!wiringFrom || !onToggleModulation) return;

        const wireKey = `${wiringFrom.moduleId}:${targetModule}:${targetParam}`;
        log('Wire Created', {
            source: wiringFrom.moduleId,
            target: targetModule,
            param: targetParam
        });

        // API signature: toggleModulation(targetParam, sourceModule, enabled)
        const result = await onToggleModulation(targetParam, wiringFrom.moduleId, true);

        // On success, apply optimistic wire add
        if (result?.status === 'ok') {
            setOptimisticWireAdds(prev => new Set([...prev, wireKey]));
        }

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
                if (selection.type === 'module' && isFixedModule(selection.moduleId)) return;
                if (selection.type === 'wire') {
                    const conn = modConnections.find(c => `${c.from}:${c.toModule}:${c.toParam}` === selection.wireKey);
                    if (conn?.fixed) return;
                }
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
    }, [selection, confirmDialog, wiringFrom, isFixedModule, modConnections]);

    // Render: Patches list into this column (the React root), portals for modules & workspace
    const workspaceContent = (
        <div className="ap-workspace-container" onMouseUp={handleCancelWiring}>
            <NodeWorkspace
                topology={topology}
                moduleState={moduleState}
                currentPatch={currentPatch}
                enabledModules={enabledModules}
                nodePositions={nodePositions}
                onNodePositionChange={(id, pos) => setNodePositions(prev => ({ ...prev, [id]: pos }))}
                onDragEnd={() => {
                    if (deviceKey && currentIndex >= 0) {
                        WorkspacePersistence.saveNodePositions(deviceKey, currentIndex, nodePositionsRef.current);
                    }
                }}
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
                midiState={midiState}
                controllerConfig={controllerConfig}
                deviceKey={deviceKey}
            />
            <LoadingOverlay isLoading={isLoading} isVisible={isLoading} />
            {confirmDialog && (
                <ConfirmDialog
                    dialog={confirmDialog}
                    onConfirm={handleConfirmDelete}
                    onCancel={handleCancelDelete}
                />
            )}
        </div>
    );

    return (
        <>
            {/* Patches — renders directly into patches column (the React root) */}
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

            {/* Modules — portal into modules column */}
            {modulesCol && ReactDOM.createPortal(
                <ModuleDrawer
                    moduleState={moduleState}
                    enabledModules={enabledModules}
                    onAddModule={handleAddModule}
                    currentPatch={currentPatch}
                    pendingModuleId={pendingModule?.moduleId}
                />,
                modulesCol
            )}

            {/* Workspace — portal into workspace column */}
            {workspaceCol && ReactDOM.createPortal(workspaceContent, workspaceCol)}
        </>
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

    // Renders directly into patches WindowManager column (sticky header + items)
    return (
        <>
            <div className="ap-patches-header">
                <span>Patches</span>
                <button className="ap-btn ap-btn-primary ap-patches-new" onClick={onCreate}>+ NEW</button>
            </div>
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
        </>
    );
}

//======================================================================
// MODULE DRAWER
//======================================================================

function ModuleDrawer({ moduleState, enabledModules, onAddModule, currentPatch, pendingModuleId }) {
    const [showJson, setShowJson] = useState(false);

    // Renders directly into modules WindowManager column (sticky header + sections)
    return (
        <>
            <div className="ap-drawer-header">
                <span>Modules</span>
                <button
                    className="ap-btn ap-btn-small ap-btn-secondary"
                    onClick={() => setShowJson(true)}
                    disabled={!currentPatch}
                >
                    View JSON
                </button>
            </div>
            <div className="ap-drawer-content">
                {moduleState.groups.filter(g => !g.fixed).map(group => (
                    <DrawerSection
                        key={group.id}
                        title={group.name.toUpperCase()}
                        color={group.color}
                        modules={group.modules}
                        enabledModules={enabledModules}
                        onAddModule={onAddModule}
                        pendingModuleId={pendingModuleId}
                    />
                ))}
            </div>
            {showJson && currentPatch && (
                <JsonPopover
                    patch={currentPatch}
                    onClose={() => setShowJson(false)}
                />
            )}
        </>
    );
}

function DrawerSection({ title, color, modules, enabledModules, onAddModule, pendingModuleId }) {
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
            <div className="ap-drawer-section-title" style={color ? { color } : undefined}>{title}</div>
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
        <div className="ap-modal-overlay" onClick={onClose}>
            <div className="ap-json-modal" onClick={e => e.stopPropagation()}>
                <div className="ap-window-titlebar">
                    <button className="ap-window-close" onClick={onClose}></button>
                    <div className="ap-window-title">Patch JSON</div>
                </div>
                <pre className="ap-json-modal-content">{jsonString}</pre>
            </div>
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
    moduleState,
    currentPatch,
    enabledModules,
    nodePositions,
    onNodePositionChange,
    onDragEnd,
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
    onLiveChange,
    onUpdateModAmount,
    log = () => {},  // Default to no-op if not provided
    midiState,
    controllerConfig,
    deviceKey
}) {
    const workspaceRef = useRef(null);
    const [draggingNode, setDraggingNode] = useState(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [hoverTarget, setHoverTarget] = useState(null); // { module, param }
    const [isDragOver, setIsDragOver] = useState(false);

    // Ref to avoid stale closure in mouseup event listener
    const onDragEndRef = useRef(onDragEnd);
    onDragEndRef.current = onDragEnd;

    // Pan state (mouse drag to scroll)
    const [isPanning, setIsPanning] = useState(false);
    const panStartRef = useRef({ x: 0, y: 0 });
    const scrollStartRef = useRef({ left: 0, top: 0 });
    const panContainerRef = useRef(null);

    // Port position registry - tracks actual DOM positions of all ports
    // Use ref to collect positions without triggering re-renders
    const portPositionsRef = useRef({});
    const [portPositions, setPortPositions] = useState({});
    const positionUpdateTimeoutRef = useRef(null);

    // Callback for nodes to report their port positions
    // Collects in ref, then batches a single state update
    const handlePortPositionChange = useCallback((portId, globalPos) => {
        const pcRect = panContainerRef.current?.getBoundingClientRect();
        if (!pcRect) return;

        // Store in ref (no re-render) — relative to pan container
        const newPos = {
            x: globalPos.x - pcRect.left,
            y: globalPos.y - pcRect.top
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

    // Clear stale port positions when switching between patches (prevents phantom wires)
    // Track by patch index — not object identity — so param edits don't wipe positions
    const patchIdentityRef = useRef(null);
    useEffect(() => {
        const identity = currentPatch?.index;
        if (identity !== patchIdentityRef.current) {
            // Only clear when switching between real patches, not on initial load
            if (patchIdentityRef.current !== null && patchIdentityRef.current !== undefined) {
                portPositionsRef.current = {};
                setPortPositions({});
            }
            patchIdentityRef.current = identity;
        }
    }, [currentPatch]);

    // Content offset — ensures scroll margin on north/west edges
    const CONTENT_OFFSET = 100;

    // Get default position for a module — group-index-based layout
    const GROUP_Y_SPACING = 200;
    const MODULE_X_SPACING = 200;

    const getDefaultPosition = useCallback((moduleId) => {
        const mod = moduleState.allModules.get(moduleId);
        if (!mod) return { x: CONTENT_OFFSET, y: CONTENT_OFFSET };

        const groupIndex = moduleState.groups.findIndex(g => g.id === mod.groupId);
        const group = moduleState.groups[groupIndex];
        const modIndex = group ? group.modules.findIndex(m => m.id === moduleId) : 0;

        return {
            x: CONTENT_OFFSET + modIndex * MODULE_X_SPACING,
            y: CONTENT_OFFSET + Math.max(0, groupIndex) * GROUP_Y_SPACING
        };
    }, [moduleState]);

    // Get enabled modules grouped by topology group
    const enabledByGroup = useMemo(() => {
        return moduleState.groups.map(group => ({
            ...group,
            modules: group.modules.filter(m => enabledModules.has(m.id))
        })).filter(g => g.modules.length > 0);
    }, [moduleState, enabledModules]);

    // Compute pan container size from node bounding box + margin
    const contentBounds = useMemo(() => {
        const MARGIN = 200;
        const FALLBACK_W = 200, FALLBACK_H = 120;
        let maxX = 0, maxY = 0;

        // Use port positions for actual node extent where available
        const moduleBounds = {};
        Object.entries(portPositions).forEach(([portId, pos]) => {
            const moduleId = portId.split(':')[0];
            if (!moduleBounds[moduleId]) {
                moduleBounds[moduleId] = { maxX: -Infinity, maxY: -Infinity };
            }
            moduleBounds[moduleId].maxX = Math.max(moduleBounds[moduleId].maxX, pos.x);
            moduleBounds[moduleId].maxY = Math.max(moduleBounds[moduleId].maxY, pos.y);
        });

        enabledByGroup.flatMap(g => g.modules).forEach((m, i) => {
            const pos = nodePositions[m.id] || getDefaultPosition(m.id);
            const bounds = moduleBounds[m.id];
            const nodeRight = bounds ? bounds.maxX + 20 : pos.x + FALLBACK_W;
            const nodeBottom = bounds ? bounds.maxY + 20 : pos.y + FALLBACK_H;
            maxX = Math.max(maxX, nodeRight);
            maxY = Math.max(maxY, nodeBottom);
        });

        return { width: maxX + MARGIN, height: maxY + MARGIN };
    }, [enabledByGroup, nodePositions, getDefaultPosition, portPositions]);

    // Compute group box outlines for each topology group
    // Uses port positions to measure actual rendered node extent
    const groupBoxes = useMemo(() => {
        const PAD = 20;
        const FALLBACK_W = 200, FALLBACK_H = 120;
        const boxes = [];

        // Build per-module bounding box from port positions
        const moduleBounds = {};
        Object.entries(portPositions).forEach(([portId, pos]) => {
            const moduleId = portId.split(':')[0];
            if (!moduleBounds[moduleId]) {
                moduleBounds[moduleId] = { maxX: -Infinity, maxY: -Infinity };
            }
            moduleBounds[moduleId].maxX = Math.max(moduleBounds[moduleId].maxX, pos.x);
            moduleBounds[moduleId].maxY = Math.max(moduleBounds[moduleId].maxY, pos.y);
        });

        enabledByGroup.forEach(group => {
            if (group.modules.length === 0) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            group.modules.forEach(m => {
                const pos = nodePositions[m.id] || getDefaultPosition(m.id);
                const bounds = moduleBounds[m.id];
                const nodeRight = bounds ? bounds.maxX + 20 : pos.x + FALLBACK_W;
                const nodeBottom = bounds ? bounds.maxY + 20 : pos.y + FALLBACK_H;
                minX = Math.min(minX, pos.x);
                minY = Math.min(minY, pos.y);
                maxX = Math.max(maxX, nodeRight);
                maxY = Math.max(maxY, nodeBottom);
            });
            boxes.push({ x: minX - PAD, y: minY - PAD,
                          width: maxX - minX + 2 * PAD, height: maxY - minY + 2 * PAD,
                          color: group.color, label: group.name.toUpperCase() });
        });
        return boxes;
    }, [enabledByGroup, nodePositions, getDefaultPosition, portPositions]);

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
        if (!draggingNode || !panContainerRef.current) return;

        const pcRect = panContainerRef.current.getBoundingClientRect();
        const newX = e.clientX - pcRect.left - dragOffset.x;
        const newY = e.clientY - pcRect.top - dragOffset.y;

        onNodePositionChange(draggingNode, { x: Math.max(0, newX), y: Math.max(0, newY) });
    };

    const handleMouseUp = () => {
        if (draggingNode && onDragEndRef.current) {
            onDragEndRef.current();
        }
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

    // Background drag-to-pan (adjusts native scroll position)
    const handlePanStart = (e) => {
        if (e.button !== 0) return;
        // Only pan when clicking empty workspace or the pan container
        if (e.target !== workspaceRef.current && e.target !== panContainerRef.current) return;
        // Don't pan when clicking on scrollbar area (let native resize/scroll handle it)
        const ws = workspaceRef.current;
        const rect = ws.getBoundingClientRect();
        if (e.clientX > rect.left + ws.clientWidth || e.clientY > rect.top + ws.clientHeight) return;
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        scrollStartRef.current = {
            left: workspaceRef.current.scrollLeft,
            top: workspaceRef.current.scrollTop
        };
    };

    const handlePanMove = useCallback((e) => {
        if (!isPanning) return;
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        workspaceRef.current.scrollLeft = scrollStartRef.current.left - dx;
        workspaceRef.current.scrollTop = scrollStartRef.current.top - dy;
    }, [isPanning]);

    const handlePanEnd = useCallback(() => {
        setIsPanning(false);
    }, []);

    useEffect(() => {
        if (isPanning) {
            document.addEventListener('mousemove', handlePanMove);
            document.addEventListener('mouseup', handlePanEnd);
            return () => {
                document.removeEventListener('mousemove', handlePanMove);
                document.removeEventListener('mouseup', handlePanEnd);
            };
        }
    }, [isPanning, handlePanMove, handlePanEnd]);

    // Build chain wires from topology — array-of-arrays stages
    // Filter each stage to enabled modules, drop empty stages, wire all-to-all between adjacent stages
    const chainWires = useMemo(() => {
        const wires = [];
        if (!moduleState.chains) return wires;

        moduleState.chains.forEach(chain => {
            const color = chain.color || '#888';
            const stages = (chain.stages || [])
                .map(stage => stage.filter(id => enabledModules.has(id)))
                .filter(stage => stage.length > 0);

            for (let i = 0; i < stages.length - 1; i++) {
                stages[i].forEach(fromId => {
                    stages[i + 1].forEach(toId => {
                        wires.push({ from: fromId, to: toId, color });
                    });
                });
            }
        });

        return wires;
    }, [moduleState.chains, enabledModules]);

    // Handle workspace mouse move for wiring
    const handleWorkspaceMouseMove = (e) => {
        if (wiringFrom && panContainerRef.current) {
            const pcRect = panContainerRef.current.getBoundingClientRect();
            onWiringMouseMove({ x: e.clientX - pcRect.left, y: e.clientY - pcRect.top });
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

        // Reject drops from fixed groups
        const dropMod = moduleState.allModules.get(moduleId);
        if (dropMod?.fixed) return;

        // Calculate drop position relative to pan container
        const pcRect = panContainerRef.current?.getBoundingClientRect();
        if (!pcRect) return;

        const dropPosition = {
            x: e.clientX - pcRect.left - 50,  // Center the node
            y: e.clientY - pcRect.top - 15
        };

        log('Module Dropped', { moduleId, position: dropPosition });

        // Set the position BEFORE adding module
        onNodePositionChange(moduleId, dropPosition);

        const moduleDef = findModuleDef(moduleId, moduleState);

        // For mod sources: set pending and start wiring (NO API call yet)
        // The API call happens when the wire is connected
        if (moduleDef?.isModSource) {
            setPendingModule({ moduleId, position: dropPosition });
            onStartWiring(moduleId, 'mod');
            log('Pending Module Created', { moduleId });
        } else {
            // For non-mod-source modules: add immediately via API
            if (onAddModule) {
                onAddModule(moduleId);
            }
        }
    };

    // Handle workspace click to clear selection or cancel pending module
    const handleWorkspaceClick = (e) => {
        // Only handle clicks directly on the workspace or pan container, not on nodes
        if (e.target !== workspaceRef.current && e.target !== panContainerRef.current) return;

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

    // Calculate envelope params for both envelopes (for overlay feature)
    const envelopeData = useMemo(() => {
        if (!currentPatch) return {};

        const extractEnvelopeParams = (moduleId) => {
            const moduleData = currentPatch[moduleId];
            if (!moduleData) return null;

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
        };

        // Extract envelope data for all envelope-type modules
        const data = {};
        ['MOD_ENV', 'VAMP_ENV', 'AMP_ENV'].forEach(id => {
            data[id] = extractEnvelopeParams(id);
        });
        return data;
    }, [currentPatch]);

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
            className={`ap-node-workspace ${wiringFrom ? 'wiring' : ''} ${isDragOver ? 'drag-over' : ''} ${isPanning ? 'panning' : ''}`}
            ref={workspaceRef}
            onMouseDown={handlePanStart}
            onMouseMove={handleWorkspaceMouseMove}
            onClick={handleWorkspaceClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div
                className="ap-pan-container"
                ref={panContainerRef}
                style={{ width: contentBounds.width, height: contentBounds.height }}
            >
            {/* SVG layer for wires */}
            <svg className="ap-wire-layer" width={contentBounds.width} height={contentBounds.height}>
                {/* Group boxes behind nodes */}
                {groupBoxes.map((box, i) => (
                    <g key={`group-${i}`}>
                        <rect x={box.x} y={box.y} width={box.width} height={box.height}
                              fill="none" stroke={box.color}
                              strokeOpacity="0.5" strokeWidth="2" rx="8" />
                        <text x={box.x + 8} y={box.y + 14} fill={box.color} opacity="0.4"
                              fontSize="11" fontFamily="Chicago_12, Chicago, sans-serif">
                            {box.label}
                        </text>
                    </g>
                ))}

                {/* Chain wires */}
                {chainWires.map((wire, i) => (
                    <Wire
                        key={`chain-${i}`}
                        from={wire.from}
                        to={wire.to}
                        color={wire.color}
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
                            moduleState={moduleState}
                        />
                    );
                })}

                {/* Wire being dragged */}
                {wiringFrom && wiringMousePos && (
                    <DraggingWire
                        fromModule={wiringFrom.moduleId}
                        mousePos={wiringMousePos}
                        portPositions={portPositions}
                        moduleState={moduleState}
                    />
                )}
            </svg>

            {/* All module nodes — single loop over topology groups */}
            {enabledByGroup.flatMap(group => group.modules.map(module => {
                const pos = nodePositions[module.id] || getDefaultPosition(module.id);
                const isSelected = selection?.type === 'module' && selection?.moduleId === module.id;
                const isDeleting = deletingModules?.has(module.id);

                // Envelope overlay: pair MOD_ENV ↔ VAMP_ENV
                let otherEnvelopeParams = null;
                let otherEnvelopeColor = null;
                if (module.id === 'MOD_ENV' && envelopeData.VAMP_ENV) {
                    otherEnvelopeParams = envelopeData.VAMP_ENV;
                    otherEnvelopeColor = 'var(--ap-accent-red)';
                } else if (module.id === 'VAMP_ENV' && envelopeData.MOD_ENV) {
                    otherEnvelopeParams = envelopeData.MOD_ENV;
                    otherEnvelopeColor = 'var(--ap-accent-yellow)';
                }

                return (
                    <Node
                        key={module.id}
                        module={module}
                        moduleState={moduleState}
                        topology={topology}
                        patch={currentPatch}
                        position={pos}
                        isSelected={isSelected}
                        isDeleting={isDeleting}
                        isFixed={module.fixed}
                        onMouseDown={(e) => handleMouseDown(module.id, e)}
                        onSelectModule={() => onSelectModule(module.id)}
                        onRemoveModule={module.fixed ? undefined : () => onRemoveModule(module.id)}
                        onStartWiring={(!module.fixed && module.isModSource) ? () => onStartWiring(module.id, 'mod') : undefined}
                        isWiringSource={wiringFrom?.moduleId === module.id}
                        wiringFrom={wiringFrom}
                        onParamDrop={onWireDrop}
                        onPortPositionChange={handlePortPositionChange}
                        selectedWireTarget={selectedWireTarget}
                        onUpdateParam={onUpdateParam}
                        onLiveChange={onLiveChange}
                        onUpdateModAmount={onUpdateModAmount}
                        otherEnvelopeParams={otherEnvelopeParams}
                        otherEnvelopeColor={otherEnvelopeColor}
                        midiState={midiState}
                        controllerConfig={controllerConfig}
                        deviceKey={deviceKey}
                    />
                );
            }))}

            {/* Pending module (dropped but not yet wired) */}
            {pendingModule && !enabledModules.has(pendingModule.moduleId) && (() => {
                const moduleDef = findModuleDef(pendingModule.moduleId, moduleState);
                if (!moduleDef) return null;
                const pos = nodePositions[pendingModule.moduleId] || pendingModule.position;
                return (
                    <Node
                        key={`pending-${pendingModule.moduleId}`}
                        module={moduleDef}
                        moduleState={moduleState}
                        topology={topology}
                        patch={currentPatch}
                        position={pos}
                        isSelected={false}
                        isDeleting={deletingModules?.has(pendingModule.moduleId)}
                        isPending={true}
                        onMouseDown={(e) => handleMouseDown(pendingModule.moduleId, e)}
                        onSelectModule={() => {}}
                        onRemoveModule={() => {}}
                        onStartWiring={moduleDef.isModSource ? () => onStartWiring(pendingModule.moduleId, 'mod') : undefined}
                        isWiringSource={wiringFrom?.moduleId === pendingModule.moduleId}
                        onPortPositionChange={handlePortPositionChange}
                        selectedWireTarget={selectedWireTarget}
                        onUpdateParam={onUpdateParam}
                        onLiveChange={onLiveChange}
                        onUpdateModAmount={onUpdateModAmount}
                    />
                );
            })()}
            </div>
        </div>
    );
}

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
    const [localValue, setLocalValue] = useState(Math.round(param.value));

    // Sync with external value changes (device round-trip)
    useEffect(() => {
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
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState(value.toString());
    const inputRef = useRef(null);

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

    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.select();
        }
    }, [editing]);

    // Sync with external value when not editing
    useEffect(() => {
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
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState(priority?.toString() || '');
    const [error, setError] = useState(false);
    const inputRef = useRef(null);

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

    useEffect(() => {
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
    const canvasRef = useRef(null);
    const velocityDotsRef = useRef([]);
    const animFrameRef = useRef(null);
    const [drawTrigger, setDrawTrigger] = useState(0);
    const resolvedColorRef = useRef('#92cc41');

    // Resolve CSS variable for canvas drawing
    useEffect(() => {
        const el = document.documentElement;
        const computed = getComputedStyle(el).getPropertyValue('--ap-accent-green').trim();
        if (computed) resolvedColorRef.current = computed;
    }, []);

    const cx = curve?.x ?? 0.5;
    const cy = curve?.y ?? 0.5;

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

    const drawCanvas = useCallback(() => {
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
// NODE COMPONENT
//======================================================================

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
    onLiveChange,
    onUpdateModAmount,
    otherEnvelopeParams,  // For envelope overlay
    otherEnvelopeColor,   // Color for the other envelope curve
    midiState,
    controllerConfig,
    deviceKey
}) {
    const moduleData = patch?.[module.id];

    // Port refs for position tracking
    const headerInputRef = useRef(null);
    const headerOutputRef = useRef(null);
    const paramPortRefs = useRef({});

    const isChainMember = module.isChainMember === true;
    const isModSource = module.isModSource === true;

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
                        name: value.name || key,  // Human-readable name
                        value: value.initial,
                        min: value.range?.[0] ?? 0,
                        max: value.range?.[1] ?? 1,
                        priority: value.priority ?? 999,  // For sorting
                        cc: value.cc,
                        uid: value.uid  // Parameter UID for value feedback
                    });
                }
            }
        });

        // Sort by priority
        return params.sort((a, b) => a.priority - b.priority);
    }, [moduleData]);

    // Collect all existing priorities from the entire patch for duplicate checking
    const existingPriorities = useMemo(() => {
        const priorities = new Set();
        if (!patch) return priorities;

        Object.entries(patch).forEach(([moduleId, modData]) => {
            if (typeof modData !== 'object' || modData === null) return;
            Object.entries(modData).forEach(([key, value]) => {
                if (typeof value === 'object' && value !== null && value.priority) {
                    priorities.add(value.priority);
                }
            });
        });
        return priorities;
    }, [patch]);

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
    const envelopeParams = useMemo(() => {
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
                                    existingPriorities={existingPriorities}
                                    onUpdatePriority={(key, pri) => onUpdateParam(key, { priority: pri })}
                                />
                                <span className="ap-node-param-key">{param.name}</span>
                                {isWaveControl ? (
                                    <WaveSelector
                                        param={param}
                                        waves={waves}
                                        onUpdateParam={onUpdateParam}
                                    />
                                ) : (
                                    <NodeParamSlider
                                        param={param}
                                        onUpdateParam={onUpdateParam}
                                        onLiveChange={onLiveChange}
                                        midiState={midiState}
                                        deviceKey={deviceKey}
                                    />
                                )}
                            </div>
                            {/* Amount sliders under param */}
                            {amountParams.map(amt => (
                                <div key={amt.source} className="ap-node-mod-amount">
                                    <span
                                        className="ap-mod-source-label"
                                        style={{ color: moduleState?.allModules?.get(amt.source)?.groupColor || 'var(--ap-wire-mod)' }}
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

function NodeParamSlider({ param, onUpdateParam, onLiveChange, midiState, deviceKey }) {
    const [localValue, setLocalValue] = useState(param.value);
    const [displayText, setDisplayText] = useState(null);
    const lastLiveSendRef = useRef(0);

    // Sync with external value changes
    useEffect(() => {
        setLocalValue(param.value);
    }, [param.value]);

    // Subscribe to value feedback for this param's UID (scoped by device)
    useEffect(() => {
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

//======================================================================
// MODULATION WIRE COMPONENT
//======================================================================

function ModWire({ connection, wireKey, portPositions, isSelected, onSelect, moduleState }) {
    const { from, toModule, toParam, amount, fixed } = connection;

    const fromPort = portPositions[`${from}:out`];
    const toPort = portPositions[`${toModule}:${toParam}:in`];
    if (!fromPort || !toPort) return null;

    const { x: x1, y: y1 } = fromPort;
    const { x: x2, y: y2 } = toPort;
    const color = moduleState?.allModules?.get(from)?.groupColor || 'var(--ap-wire-mod)';
    const pathD = apBezierPath(x1, y1, x2, y2);

    const handleClick = (e) => {
        e.stopPropagation();
        if (!fixed && onSelect) onSelect();
    };

    return (
        <g className={`ap-wire-group ap-mod-wire ${isSelected ? 'selected' : ''} ${fixed ? 'fixed' : ''}`}>
            {!fixed && (
                <path d={pathD} stroke="transparent" strokeWidth={24} fill="none"
                      style={{ cursor: 'pointer' }} onClick={handleClick} />
            )}
            <path d={pathD} stroke={color} strokeWidth={isSelected ? 3 : 2} fill="none"
                  strokeDasharray="4,2" opacity={fixed ? 0.6 : 1}
                  style={{ pointerEvents: 'none' }} />
            {isSelected && (
                <path d={pathD} stroke={color} strokeWidth={6} fill="none"
                      strokeDasharray="4,2" opacity={0.3} style={{ pointerEvents: 'none' }} />
            )}
            {!fixed && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} fill={color} fontSize="8"
                      textAnchor="middle" style={{ fontFamily: 'var(--ap-font-family)', pointerEvents: 'none' }}>
                    {amount}
                </text>
            )}
        </g>
    );
}

//======================================================================
// DRAGGING WIRE COMPONENT
//======================================================================

function DraggingWire({ fromModule, mousePos, portPositions, moduleState }) {
    const fromPort = portPositions[`${fromModule}:out`];
    if (!fromPort) return null;
    const color = moduleState?.allModules?.get(fromModule)?.groupColor || 'var(--ap-wire-mod)';
    return <APPreviewWire fromPos={fromPort} toPos={mousePos} color={color} />;
}

//======================================================================
// WIRE COMPONENT (Audio wires: header output -> header input)
//======================================================================

function Wire({ from, to, color, portPositions }) {
    const fromPort = portPositions[`${from}:out`];
    const toPort = portPositions[`${to}:in`];
    if (!fromPort || !toPort) return null;

    return (
        <path d={apBezierPath(fromPort.x, fromPort.y, toPort.x, toPort.y)}
              stroke={color || '#888'} strokeWidth={3}
              fill="none" className="ap-wire" />
    );
}

//======================================================================
// NODE CONTEXT MENU
//======================================================================

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
    const moduleDef = moduleState?.allModules?.get(moduleId);
    const isModSource = moduleDef?.isModSource === true;

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
    // Uses topology.mod_targets as single source of truth for valid targets
    const routedTargets = useMemo(() => {
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

function ModulationControl({ moduleId, param, moduleData, patch, topology, moduleState, onToggle, onAmountChange }) {
    // Get sources that CAN modulate this param (from topology.mod_targets)
    const availableSources = useMemo(() => {
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
