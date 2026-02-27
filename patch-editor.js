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

// Topology utility functions loaded from topology-utils.js:
// buildModuleState, canSourceModulateParam, findModuleDef,
// findAmountParamsForTarget, calculateDeletionImpact

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

// Components loaded from separate files:
// - PatchesList (patches-list.js)
// - ModuleDrawer, DrawerSection (module-drawer.js)
// - ConfirmDialog (confirm-dialog.js)
// - EnvelopeCurve, WaveIcon, WaveSelector, EditableValue, PriorityBadge,
//   VelocityCurvePreview, NodeParamSlider (node-widgets.js)
// - Node (node-component.js)
// - ModWire, DraggingWire, Wire (node-wires.js)
// - NodeContextMenu, ParameterControl, ModulationControl (node-context-menu.js)

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

