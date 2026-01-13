/**
 * Attach Part - Unified Web Interface
 *
 * Architecture:
 *   DeviceRegistry     - multi-device detection + MIDI routing
 *   App (orchestrator) - owns shared state, coordinates hooks
 *   usePatchList       - patch list CRUD (isolated, can be rewritten)
 *   useModuleToggle    - module enable/disable (working)
 *   useParameterEditor - param/range/modulation (working)
 */

const { useState, useEffect, useRef, useMemo, useCallback } = React;

//======================================================================
// UTILITY FUNCTIONS (unchanged)
//======================================================================

function formatParamName(param) {
    return param
        .split('_')
        .map(word => word.charAt(0) + word.slice(1).toLowerCase())
        .join(' ');
}

function getAmountRange(amountParam) {
    if (amountParam.includes('_LEVEL_')) {
        return [0.0, 1.0];
    }
    return [-1.0, 1.0];
}

function extractTopology(patch) {
    if (!patch) return {};

    const modules = {};
    const skipKeys = ['name', 'version', 'index'];

    for (const moduleName in patch) {
        if (skipKeys.includes(moduleName)) continue;
        if (typeof patch[moduleName] !== 'object') continue;

        const moduleData = patch[moduleName];
        const params = [];

        for (const paramKey in moduleData) {
            const paramData = moduleData[paramKey];

            // Skip AMOUNT params - they're tracked via disabledSources on targets
            if (paramKey.endsWith('_AMOUNT')) {
                continue;
            }

            params.push({
                key: paramKey,
                disabledSources: paramData.disabledSources || [],
                ...paramData
            });
        }

        if (params.length > 0) {
            modules[moduleName] = { params };
        }
    }

    return modules;
}

function getEnabledModules(patch) {
    const enabled = new Set();
    if (!patch) return enabled;

    const skipKeys = ['name', 'version', 'index'];

    for (const moduleName in patch) {
        if (skipKeys.includes(moduleName)) continue;
        const moduleData = patch[moduleName];
        if (moduleData && typeof moduleData === 'object' && Object.keys(moduleData).length > 0) {
            enabled.add(moduleName);
        }
    }
    return enabled;
}

// Get ordered list of enabled modules (preserves JSON object order for priority)
function getOrderedModules(patch) {
    const ordered = [];
    if (!patch) return ordered;

    const skipKeys = ['name', 'version', 'index'];

    for (const moduleName in patch) {
        if (skipKeys.includes(moduleName)) continue;
        const moduleData = patch[moduleName];
        if (moduleData && typeof moduleData === 'object' && Object.keys(moduleData).length > 0) {
            ordered.push(moduleName);
        }
    }
    return ordered;
}

function hasModulation(patch, moduleName, target, source) {
    const amountKey = `${target}_${source}_AMOUNT`;
    return patch && patch[moduleName] && patch[moduleName][amountKey] !== undefined;
}

//======================================================================
// HOOK: usePatchList (ISOLATED - CLEAN DESIGN)
//======================================================================

/**
 * Manages patch list state and CRUD operations.
 *
 * DESIGN PRINCIPLES:
 *   1. Mutations are ACK-only - we don't parse response data
 *   2. Device is source of truth - list-patches gives us everything
 *   3. Clear separation: UNIQUE action logic vs GENERIC sync logic
 *   4. Predictable flow: mutation → sync → notify
 *
 * FLOW FOR ALL OPERATIONS:
 *   1. UNIQUE: Execute mutation (each op has unique pre/post logic)
 *   2. GENERIC: Sync with device (list-patches → select-patch)
 *   3. GENERIC: Notify app (onPatchSelected callback)
 *
 * RESULTANT INDEX (who to select after operation):
 *   - select: the requested index
 *   - create: new patch (end of list)
 *   - rename: same index (unchanged)
 *   - delete: none (-1)
 *   - move: target position
 */
function usePatchList(api, { onPatchSelected, addLog }) {
    const [patchList, setPatchList] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [busy, setBusy] = useState(false);

    //==================================================================
    // GENERIC: Sync with device
    //==================================================================

    /**
     * Fetch authoritative list from device.
     * This is the ONLY way we update patchList.
     */
    const syncList = useCallback(async () => {
        const resp = await api.listPatches();
        const patches = Array.isArray(resp?.patches) ? resp.patches : [];
        const deviceIndex = typeof resp?.current_index === 'number' ? resp.current_index : -1;

        console.log(`[syncList] ${patches.length} patches, device selection: ${deviceIndex}`);
        setPatchList(patches);

        return { patches, deviceIndex };
    }, [api]);

    /**
     * Tell device to select a patch and update local state.
     * index = -1 means no selection (just update local state, don't call API)
     */
    const syncSelection = useCallback(async (index) => {
        console.log(`[syncSelection] selecting ${index}`);

        if (index >= 0) {
            await api.selectPatch(index);
        }

        setCurrentIndex(index);
        onPatchSelected(index);
    }, [api, onPatchSelected]);

    /**
     * Full sync: get list from device, then select specified index.
     * This is the GENERIC ending for all operations.
     */
    const syncWithDevice = useCallback(async (targetIndex) => {
        // Step 1: Get authoritative list
        const { patches } = await syncList();

        // Step 2: Validate target index
        let finalIndex = targetIndex;
        if (finalIndex >= patches.length) {
            finalIndex = patches.length - 1; // clamp to valid range
        }
        if (patches.length === 0) {
            finalIndex = -1; // empty list = no selection
        }

        // Step 3: Select and notify
        await syncSelection(finalIndex);

        return finalIndex;
    }, [syncList, syncSelection]);

    //==================================================================
    // GENERIC: Error recovery
    //==================================================================

    const recoverFromError = useCallback(async (error, operation) => {
        addLog(`Error in ${operation}: ${error.message}`, 'error');

        // Try to sync with device to get back to known state
        try {
            await syncWithDevice(-1); // select none
        } catch (syncError) {
            addLog(`Recovery failed: ${syncError.message}`, 'error');
            setPatchList([]);
            setCurrentIndex(-1);
            onPatchSelected(-1);
        }
    }, [addLog, syncWithDevice, onPatchSelected]);

    //==================================================================
    // OPERATIONS: Each has UNIQUE logic + GENERIC sync
    //==================================================================

    /**
     * Initial load on connect.
     * UNIQUE: No mutation, just sync with whatever device has.
     */
    const initialLoad = useCallback(async () => {
        if (busy) return;
        setBusy(true);

        try {
            const { patches, deviceIndex } = await syncList();

            // Use device's current selection (no select API call needed)
            setCurrentIndex(deviceIndex);
            onPatchSelected(deviceIndex);

            addLog(`Loaded ${patches.length} patches`);
            return { patches, current_index: deviceIndex };
        } catch (e) {
            await recoverFromError(e, 'initialLoad');
            throw e;
        } finally {
            setBusy(false);
        }
    }, [busy, syncList, onPatchSelected, addLog, recoverFromError]);

    /**
     * Select a patch.
     * UNIQUE: No mutation, just change selection.
     */
    const selectPatch = useCallback(async (index) => {
        if (busy || index === currentIndex) return;
        setBusy(true);

        try {
            addLog(`Selecting patch ${index}`);

            // GENERIC: sync (refreshes list + selects target)
            await syncWithDevice(index);
        } catch (e) {
            await recoverFromError(e, 'select');
        } finally {
            setBusy(false);
        }
    }, [busy, currentIndex, addLog, syncWithDevice, recoverFromError]);

    /**
     * Create a new patch.
     * UNIQUE: Generate name, call create API.
     * RESULTANT: New patch (will be at end of list)
     */
    const createPatch = useCallback(async () => {
        if (busy) return;
        setBusy(true);

        try {
            // UNIQUE: Generate auto-numbered name
            let maxNum = 0;
            const pattern = /^New Patch (\d+)$/;
            patchList.forEach(p => {
                const match = p.name.match(pattern);
                if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
            });
            const name = `New Patch ${maxNum + 1}`;

            // UNIQUE: Call mutation (treat response as ACK only)
            await api.createPatch(name);
            addLog(`Created: ${name}`);

            // GENERIC: sync with device, select new patch (end of list)
            const targetIndex = patchList.length; // new patch appended
            await syncWithDevice(targetIndex);
        } catch (e) {
            await recoverFromError(e, 'create');
        } finally {
            setBusy(false);
        }
    }, [busy, patchList, api, addLog, syncWithDevice, recoverFromError]);

    /**
     * Rename a patch.
     * UNIQUE: Validate name, call rename API.
     * RESULTANT: Same index (unchanged)
     */
    const renamePatch = useCallback(async (index, newName) => {
        if (busy || !newName?.trim()) return;
        setBusy(true);

        try {
            // UNIQUE: Call mutation (treat response as ACK only)
            await api.renamePatch(index, newName.trim());
            addLog(`Renamed patch ${index}: ${newName.trim()}`);

            // GENERIC: sync with device, keep same selection
            await syncWithDevice(index);
        } catch (e) {
            await recoverFromError(e, 'rename');
        } finally {
            setBusy(false);
        }
    }, [busy, api, addLog, syncWithDevice, recoverFromError]);

    /**
     * Delete a patch.
     * UNIQUE: Call delete API.
     * RESULTANT: None (-1) - clear editor after delete
     */
    const deletePatch = useCallback(async (index) => {
        if (busy) return;
        setBusy(true);

        try {
            // UNIQUE: Call mutation (treat response as ACK only)
            await api.deletePatch(index);
            addLog(`Deleted patch ${index}`);

            // GENERIC: sync with device, select none
            await syncWithDevice(-1);
        } catch (e) {
            await recoverFromError(e, 'delete');
        } finally {
            setBusy(false);
        }
    }, [busy, api, addLog, syncWithDevice, recoverFromError]);

    /**
     * Move a patch from one position to another.
     * UNIQUE: Call move API.
     * RESULTANT: Target position (where the patch moved to)
     */
    const movePatch = useCallback(async (from, to) => {
        if (busy || from === to) return;
        setBusy(true);

        try {
            // UNIQUE: Call mutation (treat response as ACK only)
            await api.movePatch(from, to);
            addLog(`Moved patch ${from} -> ${to}`);

            // GENERIC: sync with device, select the moved patch at its new position
            await syncWithDevice(to);
        } catch (e) {
            await recoverFromError(e, 'move');
        } finally {
            setBusy(false);
        }
    }, [busy, api, addLog, syncWithDevice, recoverFromError]);

    //==================================================================
    // PUBLIC API
    //==================================================================
    // RESET: Clear state on disconnect
    //==================================================================

    const reset = useCallback(() => {
        setPatchList([]);
        setCurrentIndex(-1);
    }, []);

    /**
     * Handle external patch change (encoder/console while in EDITOR mode).
     * Device already changed the patch - just update local state.
     */
    const handleExternalPatchChange = useCallback((newIndex) => {
        console.log(`[handleExternalPatchChange] external change to ${newIndex}`);
        setCurrentIndex(newIndex);
        onPatchSelected(newIndex);
        addLog(`Patch changed externally to ${newIndex}`);
    }, [onPatchSelected, addLog]);

    //==================================================================

    return {
        // State (read-only)
        patchList,
        currentIndex,
        busy,

        // Operations
        initialLoad,
        selectPatch,
        createPatch,
        renamePatch,
        deletePatch,
        movePatch,
        reset,
        handleExternalPatchChange,
    };
}

//======================================================================
// HOOK: useModuleToggle (WORKING - DON'T TOUCH)
//======================================================================

/**
 * Manages module enable/disable operations.
 *
 * @param {CandideAPI} api - API instance
 * @param {Function} getCurrentIndex - returns current patch index
 * @param {Object} callbacks
 * @param {Function} callbacks.onPatchUpdated - called with new patch data
 * @param {Function} callbacks.addLog - logging function
 * @returns {Object} module toggle operations
 */
function useModuleToggle(api, getCurrentIndex, { onPatchUpdated, addLog }) {
    const [busy, setBusy] = useState(false);

    const toggleModule = useCallback(async (moduleName, enabled) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        try {
            await api.toggleModule(currentIndex, moduleName, enabled);
            addLog(`Toggled module ${moduleName}: ${enabled}`);

            // Refresh patch to get new/removed parameters
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error toggling module: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    const moveModule = useCallback(async (fromModule, toModule) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        try {
            await api.moveModule(currentIndex, fromModule, toModule);
            addLog(`Moved module ${fromModule} -> ${toModule}`);

            // Refresh patch to get new order/priorities
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error moving module: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    return {
        busy,
        toggleModule,
        moveModule,
    };
}

//======================================================================
// HOOK: useParameterEditor
//======================================================================

/**
 * Manages parameter value, range, and modulation operations.
 *
 * @param {CandideAPI} api - API instance
 * @param {Function} getCurrentIndex - returns current patch index
 * @param {Object} callbacks
 * @param {Function} callbacks.onPatchUpdated - called with new patch data
 * @param {Function} callbacks.addLog - logging function
 * @returns {Object} parameter editing operations
 */
function useParameterEditor(api, getCurrentIndex, { onPatchUpdated, addLog }) {
    const [busy, setBusy] = useState(false);

    // Update parameter value
    const updateParam = useCallback(async (moduleName, paramKey, value) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        try {
            await api.updateParam(currentIndex, paramKey, value);
            addLog(`Updated ${paramKey}: ${value}`);

            // Refresh patch
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error updating param: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    // Update parameter range
    const updateRange = useCallback(async (moduleName, paramKey, min, max) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        try {
            await api.updateRange(currentIndex, paramKey, min, max);
            addLog(`Updated range for ${paramKey}: [${min}, ${max}]`);

            // Refresh patch
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error updating range: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    // Toggle modulation routing
    const toggleModulation = useCallback(async (target, source, enabled) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        try {
            await api.toggleModulation(currentIndex, target, source, enabled);
            addLog(`Toggled modulation ${target} ← ${source}: ${enabled}`);

            // Refresh patch
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error toggling modulation: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    // Update modulation amount
    const updateModAmount = useCallback(async (target, source, value) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        const amountKey = `${target}_${source}_AMOUNT`;
        try {
            await api.updateModulationAmount(currentIndex, amountKey, value);
            addLog(`Updated ${amountKey}: ${value}`);

            // Refresh patch
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error updating mod amount: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    // Toggle MIDI CC control
    const toggleCC = useCallback(async (paramKey, enabled) => {
        if (busy) return;
        const currentIndex = getCurrentIndex();
        if (currentIndex < 0) return;

        setBusy(true);

        try {
            const resp = await api.toggleCC(currentIndex, paramKey, enabled);
            if (enabled) {
                addLog(`Enabled CC ${resp.cc} for ${paramKey}`);
            } else {
                addLog(`Disabled CC for ${paramKey}`);
            }

            // Refresh patch
            const patchResp = await api.getPatch(currentIndex);
            onPatchUpdated(patchResp);
        } catch (e) {
            addLog(`Error toggling CC: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, getCurrentIndex, busy, onPatchUpdated, addLog]);

    return {
        busy,
        updateParam,
        updateRange,
        toggleModulation,
        updateModAmount,
        toggleCC,
    };
}

//======================================================================
// ERROR BOUNDARY (unchanged)
//======================================================================

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error('React Error Boundary caught error:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: '40px',
                    maxWidth: '600px',
                    margin: '0 auto',
                    fontFamily: 'monospace',
                    backgroundColor: '#2d2d30',
                    color: '#d4d4d4',
                    minHeight: '100vh'
                }}>
                    <h1 style={{ color: '#f48771' }}>Application Error</h1>
                    <p>The web editor encountered an unexpected error.</p>
                    <pre style={{
                        backgroundColor: '#1e1e1e',
                        padding: '16px',
                        borderRadius: '4px',
                        overflow: 'auto',
                        color: '#f48771'
                    }}>
                        {this.state.error && this.state.error.toString()}
                    </pre>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            marginTop: '20px',
                            padding: '10px 20px',
                            backgroundColor: '#007acc',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer'
                        }}
                    >
                        Reload Application
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

//======================================================================
// MAIN APP COMPONENT - ORCHESTRATOR
//======================================================================

const api = new CandideAPI();

function App() {
    // Connection state
    // 'waiting' = monitoring for device, 'connecting' = handshaking, 'connected' = ready, 'disconnected' = was connected, now lost
    const [status, setStatus] = useState('waiting');
    const [error, setError] = useState(null);
    const [logs, setLogs] = useState([]);
    const [logCollapsed, setLogCollapsed] = useState(true);  // Start collapsed

    // Device registry state (for multi-device display)
    const [deviceStates, setDeviceStates] = useState({
        bartleby: { connected: false, name: null },
        candide: { connected: false, name: null }
    });
    const [isLinked, setIsLinked] = useState(false);

    // Shared patch state (owned by App, used by all hooks)
    const [currentPatch, setCurrentPatch] = useState(null);

    // Save status (device-driven: 'saved' | 'saving' | 'unsaved')
    const [saveStatus, setSaveStatus] = useState('saved');

    // MIDI state (shared between MidiControlsRow and ParameterEditor)
    const [velocity, setVelocity] = useState(0.8);

    // UI state
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleteTargetIndex, setDeleteTargetIndex] = useState(-1);

    // Firmware update state
    const [showFirmwareModal, setShowFirmwareModal] = useState(false);
    const [firmwarePhase, setFirmwarePhase] = useState(null); // 'confirm' | 'erasing' | 'transferring' | 'flashing' | 'ready' | 'restarting'
    const [firmwareProgress, setFirmwareProgress] = useState(0);

    // Device info state
    const [deviceInfo, setDeviceInfo] = useState(null);  // {project, version}
    const [targetFirmwareInfo, setTargetFirmwareInfo] = useState(null);  // {version, size}

    // Derived state
    const topology = useMemo(() => extractTopology(currentPatch), [currentPatch]);
    const enabledModules = useMemo(() => getEnabledModules(currentPatch), [currentPatch]);
    const orderedModules = useMemo(() => getOrderedModules(currentPatch), [currentPatch]);

    // Logging
    const addLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs(prev => [...prev, { message, type, timestamp }]);
    }, []);

    // Shared callbacks for hooks
    const handlePatchUpdated = useCallback((patch) => setCurrentPatch(patch), []);

    // Ref for current index (avoids stale closures in hooks)
    const currentIndexRef = useRef(-1);
    const getCurrentIndex = useCallback(() => currentIndexRef.current, []);

    // Load patch data by index
    const loadPatch = useCallback(async (index) => {
        if (index < 0) {
            setCurrentPatch(null);
            return;
        }
        try {
            const patchResp = await api.getPatch(index);
            setCurrentPatch(patchResp);
            addLog(`Loaded patch: ${patchResp.name}`);
        } catch (e) {
            addLog(`Error loading patch: ${e.message}`, 'error');
            setError(e.message);
        }
    }, [addLog]);

    // Callback when patch list selects a new patch
    const handlePatchSelected = useCallback(async (index) => {
        currentIndexRef.current = index;
        await loadPatch(index);
    }, [loadPatch]);

    //------------------------------------------------------------------
    // Initialize hooks
    //------------------------------------------------------------------

    const patchListHook = usePatchList(api, {
        onPatchSelected: handlePatchSelected,
        addLog,
    });

    const moduleToggleHook = useModuleToggle(api, getCurrentIndex, {
        onPatchUpdated: handlePatchUpdated,
        addLog,
    });

    const parameterEditorHook = useParameterEditor(api, getCurrentIndex, {
        onPatchUpdated: handlePatchUpdated,
        addLog,
    });

    // Keep ref in sync with hook state
    useEffect(() => {
        currentIndexRef.current = patchListHook.currentIndex;
    }, [patchListHook.currentIndex]);

    // Combined busy state
    const busy = patchListHook.busy || moduleToggleHook.busy || parameterEditorHook.busy;

    //------------------------------------------------------------------
    // Transport task loop
    //------------------------------------------------------------------

    useEffect(() => {
        if (status !== 'connected') return;

        const interval = setInterval(() => {
            api.task();
        }, 100);

        return () => clearInterval(interval);
    }, [status]);

    //------------------------------------------------------------------
    // Connection handlers
    //------------------------------------------------------------------

    // Complete connection after device is detected
    const completeConnection = useCallback(async (deviceResult) => {
        setStatus('connecting');

        try {
            api.connectToDevice(deviceResult);

            // Register save status callback (for auto-save updates from device)
            api.onSaveStatusChanged((status) => {
                setSaveStatus(status);
            });

            // Register external patch change callback (encoder/console while in EDITOR mode)
            api.onExternalPatchChange((response) => {
                patchListHook.handleExternalPatchChange(response.current_index);
            });

            await api.init();
            addLog('Editor mode activated');

            // Get device info including firmware version
            try {
                const info = await api.getDeviceInfo();
                setDeviceInfo(info);
                addLog(`Device: ${info.project} v${info.version}`);
            } catch (e) {
                addLog(`Warning: Could not get device info`, 'warn');
            }

            // Initial load: get list + sync selection from device
            // This triggers onPatchSelected which calls loadPatch
            const listResp = await patchListHook.initialLoad();
            addLog(`Loaded ${listResp.patches.length} patches`);

            setStatus('connected');
        } catch (e) {
            addLog(`Error: ${e.message}`, 'error');
            setStatus('error');
            setError(e.message);
        }
    }, [addLog, patchListHook]);

    // Handle device disconnection
    const handleDisconnect = useCallback(() => {
        setStatus('disconnected');
        setCurrentPatch(null);
        setDeviceInfo(null);
        setSaveStatus('saved');  // Reset save status on disconnect
        patchListHook.reset();
        addLog('Device disconnected - waiting for reconnection...');
    }, [addLog, patchListHook]);

    // Start monitoring on mount (auto-connect via device registry)
    useEffect(() => {
        let mounted = true;

        const startUp = async () => {
            try {
                // Initialize device registry for multi-device support
                await deviceRegistry.init((msg, type) => {
                    if (mounted) addLog(msg, type);
                });

                // Update UI when any device connects/disconnects
                deviceRegistry.onDeviceChange(() => {
                    if (!mounted) return;

                    // Update device status display
                    setDeviceStates({
                        bartleby: deviceRegistry.getDeviceStatus('bartleby'),
                        candide: deviceRegistry.getDeviceStatus('candide')
                    });
                    setIsLinked(deviceRegistry.isLinked());

                    // When Candide connects, complete the API connection
                    const candideInput = deviceRegistry.getCandideInput();
                    const candideOutput = deviceRegistry.getCandideOutput();

                    if (candideInput && candideOutput && status === 'waiting') {
                        completeConnection({ input: candideInput, output: candideOutput });
                    }

                    // When Candide disconnects
                    if (!candideInput && status === 'connected') {
                        handleDisconnect();
                    }
                });

                // Check if Candide already connected
                const candideInput = deviceRegistry.getCandideInput();
                const candideOutput = deviceRegistry.getCandideOutput();
                if (candideInput && candideOutput && mounted) {
                    // Update states immediately
                    setDeviceStates({
                        bartleby: deviceRegistry.getDeviceStatus('bartleby'),
                        candide: deviceRegistry.getDeviceStatus('candide')
                    });
                    setIsLinked(deviceRegistry.isLinked());
                    completeConnection({ input: candideInput, output: candideOutput });
                }

            } catch (e) {
                if (mounted) {
                    addLog(`Error: ${e.message}`, 'error');
                    setStatus('error');
                    setError(e.message);
                }
            }
        };

        startUp();

        return () => {
            mounted = false;
        };
    }, []); // Run once on mount

    // Legacy manual connect (kept for fallback/retry)
    const handleConnect = async () => {
        // If we have midiAccess but no device, just wait
        if (status === 'waiting') {
            addLog('Waiting for device to be connected...');
            return;
        }

        // If disconnected, try to reconnect
        if (status === 'disconnected' || status === 'error') {
            setStatus('waiting');
            setError(null);

            try {
                const deviceResult = await api.startMonitoring(addLog, {
                    onDeviceFound: (result) => completeConnection(result),
                    onDeviceDisconnected: () => handleDisconnect()
                });

                if (deviceResult) {
                    completeConnection(deviceResult);
                }
            } catch (e) {
                addLog(`Error: ${e.message}`, 'error');
                setStatus('error');
                setError(e.message);
            }
        }
    };

    //------------------------------------------------------------------
    // Save handler
    //------------------------------------------------------------------

    const handleSave = async () => {
        if (busy || saveStatus === 'saving') return;

        try {
            await api.save();
            addLog('Manual save triggered');
            // Note: saveStatus is updated by device status messages, not here
        } catch (e) {
            addLog(`Error: ${e.message}`, 'error');
            setError(e.message);
        }
    };

    //------------------------------------------------------------------
    // Firmware update handlers
    //------------------------------------------------------------------

    const handleOpenFirmwareModal = async () => {
        setShowFirmwareModal(true);
        setFirmwarePhase('confirm');
        setFirmwareProgress(0);

        // Discover firmware file in /firmware/ directory
        try {
            const response = await fetch('/firmware/');
            if (!response.ok) {
                throw new Error('Cannot list firmware directory');
            }
            const html = await response.text();

            // Parse directory listing for .bin files
            const binMatches = html.match(/href="([^"]+\.bin)"/gi) || [];
            const binFiles = binMatches.map(m => m.match(/href="([^"]+\.bin)"/i)[1]);

            if (binFiles.length === 0) {
                throw new Error('No firmware .bin file found in /firmware/');
            }
            if (binFiles.length > 1) {
                throw new Error(`Multiple firmware files found: ${binFiles.join(', ')}. Only one allowed.`);
            }

            const firmwareFilename = binFiles[0];
            setTargetFirmwareInfo({ filename: firmwareFilename });

            // Extract version from filename (e.g., "candide_0.2.3.bin" -> "0.2.3")
            const versionMatch = firmwareFilename.match(/_(\d+\.\d+\.\d+)\.bin$/);
            if (versionMatch) {
                setTargetFirmwareInfo({ filename: firmwareFilename, version: versionMatch[1] });
                addLog(`Target firmware: v${versionMatch[1]}`);
            } else {
                addLog(`Target firmware: ${firmwareFilename}`);
            }
        } catch (e) {
            addLog(`Firmware discovery error: ${e.message}`, 'error');
            setTargetFirmwareInfo(null);
        }
    };

    const handleStartFirmwareUpdate = async () => {
        try {
            if (!targetFirmwareInfo?.filename) {
                throw new Error('No firmware file discovered');
            }

            addLog('Fetching firmware binary...');

            // Fetch firmware from backend (cache-bust to ensure latest)
            const response = await fetch(`/firmware/${targetFirmwareInfo.filename}?t=${Date.now()}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch firmware: ${response.status}`);
            }
            const firmware = new Uint8Array(await response.arrayBuffer());
            addLog(`Firmware size: ${firmware.length} bytes`);

            // Upload to device with progress callback
            await api.uploadFirmware(firmware, ({ phase, percent, sector, total }) => {
                setFirmwarePhase(phase);
                setFirmwareProgress(percent);

                if (phase === 'erasing' && sector !== undefined) {
                    addLog(`Erasing: sector ${sector}/${total} (${percent}%)`);
                } else if (phase === 'transferring') {
                    addLog(`Transferring: ${percent}%`);
                }
            });

            setFirmwarePhase('ready');
            addLog('Firmware written successfully');
        } catch (e) {
            addLog(`Firmware update failed: ${e.message}`, 'error');
            setFirmwarePhase('confirm');
            setError(e.message);
        }
    };

    const handleRestartDevice = async () => {
        setFirmwarePhase('restarting');
        addLog('Restarting device...');
        try {
            await api.restartDevice();
        } catch (e) {
            // "Device disconnected" is expected - the device restarted successfully
            // Only log unexpected errors
            if (!e.message.includes('disconnected')) {
                addLog(`Restart error: ${e.message}`, 'error');
            }
        }
        // Device will reconnect automatically via monitoring
    };

    const handleCancelFirmwareUpdate = () => {
        setShowFirmwareModal(false);
        setFirmwarePhase(null);
        setFirmwareProgress(0);
    };

    //------------------------------------------------------------------
    // Delete modal handler (bridges UI to hook)
    //------------------------------------------------------------------

    const handleConfirmDelete = async () => {
        await patchListHook.deletePatch(deleteTargetIndex);
        setShowDeleteModal(false);
        setDeleteTargetIndex(-1);
    };

    //------------------------------------------------------------------
    // Render
    //------------------------------------------------------------------

    return (
        <div className="app">
            <TopNav
                status={status}
                saveStatus={saveStatus}
                deviceInfo={deviceInfo}
                onConnect={handleConnect}
                onSave={handleSave}
                onUpdateFirmware={handleOpenFirmwareModal}
                commandPending={busy}
            />
            <DeviceStatus devices={deviceStates} isLinked={isLinked} />
            <div className={`log-section ${logCollapsed ? 'collapsed' : ''}`}>
                <div className="log-header" onClick={() => setLogCollapsed(!logCollapsed)}>
                    <span className="log-toggle">{logCollapsed ? '\u25B6' : '\u25BC'}</span>
                    <span>Log ({logs.length})</span>
                </div>
                {!logCollapsed && <LogDisplay logs={logs} />}
            </div>
            <MidiControlsRow
                api={api}
                isConnected={status === 'connected'}
                velocity={velocity}
                setVelocity={setVelocity}
                addLog={addLog}
            />
            <PatchesPanel
                patches={patchListHook.patchList}
                currentPatchIndex={patchListHook.currentIndex}
                onSelect={patchListHook.selectPatch}
                onCreate={patchListHook.createPatch}
                onRename={patchListHook.renamePatch}
                onDelete={(idx) => { setDeleteTargetIndex(idx); setShowDeleteModal(true); }}
                onMoveUp={(idx) => patchListHook.movePatch(idx, idx - 1)}
                onMoveDown={(idx) => patchListHook.movePatch(idx, idx + 1)}
                disabled={status !== 'connected' || busy}
            />
            <ModuleChecklist
                enabledModules={enabledModules}
                orderedModules={orderedModules}
                onToggle={moduleToggleHook.toggleModule}
                onMoveModule={moduleToggleHook.moveModule}
                disabled={busy}
            />
            <ParameterEditor
                patch={currentPatch}
                topology={topology}
                enabledModules={enabledModules}
                onParameterChange={parameterEditorHook.updateParam}
                onRangeChange={parameterEditorHook.updateRange}
                onModToggle={parameterEditorHook.toggleModulation}
                onModAmountChange={parameterEditorHook.updateModAmount}
                onCCToggle={parameterEditorHook.toggleCC}
                disabled={busy}
                api={api}
                velocity={velocity}
            />
            <JsonViewer patch={currentPatch} />

            {showDeleteModal && (
                <DeleteConfirmModal
                    patchName={patchListHook.patchList[deleteTargetIndex]?.name || 'Unknown'}
                    onConfirm={handleConfirmDelete}
                    onCancel={() => { setShowDeleteModal(false); setDeleteTargetIndex(-1); }}
                />
            )}

            {showFirmwareModal && (
                <FirmwareUpdateModal
                    phase={firmwarePhase}
                    progress={firmwareProgress}
                    deviceInfo={deviceInfo}
                    targetFirmwareInfo={targetFirmwareInfo}
                    onConfirm={handleStartFirmwareUpdate}
                    onRestart={handleRestartDevice}
                    onCancel={handleCancelFirmwareUpdate}
                />
            )}

            {busy && (
                <div className="command-pending-indicator">Processing...</div>
            )}

            {error && (
                <div className="command-error-indicator" onClick={() => setError(null)}>
                    Error: {error} (click to dismiss)
                </div>
            )}
        </div>
    );
}

//======================================================================
// UI COMPONENTS (unchanged)
//======================================================================

function TopNav({ status, saveStatus, deviceInfo, onConnect, onSave, onUpdateFirmware, commandPending }) {
    const isConnected = status === 'connected';
    const isDisconnected = status === 'disconnected';

    const statusText = {
        'connected': 'Connected',
        'connecting': 'Connecting...',
        'waiting': 'Waiting for device...',
        'disconnected': 'Disconnected',
        'error': 'Error'
    }[status] || status;

    // Save button styling based on device-reported save status
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
        <div className="top-nav">
            <div className="top-nav-left">
                <button
                    onClick={onSave}
                    disabled={!isConnected || commandPending || saveStatus === 'saving'}
                    className={saveButtonClass}
                >
                    {saveButtonText}
                </button>
                <span className={`status ${status}`}>
                    {statusText}
                </span>
                {isConnected && deviceInfo && (
                    <span className="device-version">
                        {deviceInfo.project} v{deviceInfo.version}
                    </span>
                )}
                {(isDisconnected || status === 'error') && (
                    <button onClick={onConnect}>
                        Reconnect
                    </button>
                )}
                <button
                    onClick={onUpdateFirmware}
                    disabled={!isConnected || commandPending}
                    title="Update device firmware"
                >
                    Update Firmware
                </button>
            </div>
        </div>
    );
}

//======================================================================
// DEVICE STATUS DISPLAY
//======================================================================

function DeviceStatus({ devices, isLinked }) {
    return (
        <div className="device-status">
            <div className={`device-badge ${devices.bartleby.connected ? 'connected' : ''}`}>
                <span className="device-name">Bartleby</span>
                <span className="device-state">
                    {devices.bartleby.connected ? devices.bartleby.name : 'Not connected'}
                </span>
            </div>
            <div className={`device-badge ${devices.candide.connected ? 'connected' : ''}`}>
                <span className="device-name">Candide</span>
                <span className="device-state">
                    {devices.candide.connected ? devices.candide.name : 'Not connected'}
                </span>
            </div>
            {isLinked && (
                <div className="linked-badge">LINKED</div>
            )}
        </div>
    );
}

function PatchesPanel({ patches, currentPatchIndex, onSelect, onCreate, onRename, onDelete, onMoveUp, onMoveDown, disabled }) {
    return (
        <div className="patches-panel">
            <div className="patches-panel-header">
                <span className="patches-panel-title">Patches</span>
                <button
                    className="new-patch-button"
                    onClick={onCreate}
                    disabled={disabled}
                >
                    + New
                </button>
            </div>
            <div className="patches-list">
                {patches.map((patch) => (
                    <div
                        key={patch.index}
                        className={`patch-item ${patch.index === currentPatchIndex ? 'selected' : ''}`}
                    >
                        <div
                            className="patch-item-name"
                            onClick={() => !disabled && onSelect(patch.index)}
                            style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
                        >
                            <span className="patch-index">{patch.index}.</span>
                            <span className="patch-name">{patch.name}</span>
                        </div>
                        <div className="patch-item-actions">
                            <button
                                onClick={() => onMoveUp(patch.index)}
                                disabled={disabled || patch.index === 0}
                                title="Move Up"
                            >
                                ▲
                            </button>
                            <button
                                onClick={() => onMoveDown(patch.index)}
                                disabled={disabled || patch.index === patches.length - 1}
                                title="Move Down"
                            >
                                ▼
                            </button>
                            <button
                                onClick={() => {
                                    const newName = window.prompt('Rename patch:', patch.name);
                                    if (newName && newName !== patch.name) onRename(patch.index, newName);
                                }}
                                disabled={disabled}
                                title="Rename"
                            >
                                ✎
                            </button>
                            <button
                                onClick={() => onDelete(patch.index)}
                                disabled={disabled || patches.length <= 1}
                                title="Delete"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function LogDisplay({ logs }) {
    const logEndRef = useRef(null);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    return (
        <div className="log-display">
            {logs.map((log, idx) => (
                <div key={idx} className={`log-entry ${log.type}`}>
                    [{log.timestamp}] {log.message}
                </div>
            ))}
            <div ref={logEndRef} />
        </div>
    );
}

//======================================================================
// MIDI CONTROLS ROW (Expression Pad + Velocity)
//======================================================================

// Melody sequence for expression pad
const MELODY = [
    60, 64, 67, 72,  // C major arpeggio up
    71, 67, 64, 60,  // Down with leading tone
    62, 65, 69, 74,  // D minor arpeggio up
    72, 69, 65, 62,  // Down
];

function MidiControlsRow({ api, isConnected, velocity, setVelocity, addLog }) {
    const canvasRef = useRef(null);
    // velocity and setVelocity are now passed from App (shared state)
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentNote, setCurrentNote] = useState(60);
    const [bendValue, setBendValue] = useState(0);
    const [pressureValue, setPressureValue] = useState(0.5);
    const melodyIndexRef = useRef(0);
    const playingRef = useRef(false);

    // MPE mode - each note gets its own channel for independent expression
    const [mpeEnabled, setMpeEnabled] = useState(false);
    const mpeAllocatorRef = useRef(new MpeChannelAllocator());
    const currentChannelRef = useRef(0);  // Track channel for current note

    // Expression throttling (similar to Bartleby rate limiting)
    // Prevents flooding Candide with expression data during mouse movement
    const lastSendTimeRef = useRef(0);
    const lastBendRef = useRef(0);
    const lastPressureRef = useRef(0.5);
    const THROTTLE_INTERVAL_MS = 50;  // ~20Hz max (matches Candide throughput)
    const CHANGE_THRESHOLD = 0.02;    // 2% change required to send

    // Canvas dimensions
    const PAD_SIZE = 200;
    const CENTER = PAD_SIZE / 2;
    const NEUTRAL_RADIUS = 30;

    // Get next note in melody
    const getNextNote = useCallback(() => {
        const note = MELODY[melodyIndexRef.current];
        melodyIndexRef.current = (melodyIndexRef.current + 1) % MELODY.length;
        return note;
    }, []);

    // Convert canvas position to bend/pressure
    const positionToValues = useCallback((x, y) => {
        // Check if in dead zone (center circle)
        const dx = x - CENTER;
        const dy = y - CENTER;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy);

        if (distFromCenter <= NEUTRAL_RADIUS) {
            // Dead zone: lock to neutral values
            return { bend: 0, pressure: 0.5 };
        }

        // X: 0 = -1, CENTER = 0, PAD_SIZE = +1
        const bend = ((x / PAD_SIZE) * 2) - 1;
        // Y: 0 = 0%, CENTER = 50%, PAD_SIZE = 100%
        const pressure = y / PAD_SIZE;
        return {
            bend: Math.max(-1, Math.min(1, bend)),
            pressure: Math.max(0, Math.min(1, pressure))
        };
    }, [PAD_SIZE, CENTER, NEUTRAL_RADIUS]);

    // Draw the expression pad
    const drawPad = useCallback((x = null, y = null) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        // Clear
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, PAD_SIZE, PAD_SIZE);

        // Draw crosshairs
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(CENTER, 0);
        ctx.lineTo(CENTER, PAD_SIZE);
        ctx.moveTo(0, CENTER);
        ctx.lineTo(PAD_SIZE, CENTER);
        ctx.stroke();

        // Draw neutral circle at center
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, NEUTRAL_RADIUS, 0, Math.PI * 2);
        ctx.stroke();

        // Draw position indicator if active
        if (x !== null && y !== null) {
            // Glow effect
            ctx.shadowColor = '#ffb000';
            ctx.shadowBlur = 15;
            ctx.fillStyle = '#ffb000';
            ctx.beginPath();
            ctx.arc(x, y, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    }, [PAD_SIZE, CENTER, NEUTRAL_RADIUS]);

    // Initialize canvas
    useEffect(() => {
        drawPad();
    }, [drawPad]);

    // Handle mouse down - start note
    const handleMouseDown = useCallback((e) => {
        if (!isConnected) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { bend, pressure } = positionToValues(x, y);
        const note = getNextNote();

        // Set state
        setBendValue(bend);
        setPressureValue(pressure);
        setCurrentNote(note);
        setIsPlaying(true);
        playingRef.current = true;

        // Determine channel: MPE allocates per-note, otherwise use channel 0
        const channel = mpeEnabled ? mpeAllocatorRef.current.allocate(note) : 0;
        currentChannelRef.current = channel;

        // Reset throttle state for new note
        lastSendTimeRef.current = performance.now();
        lastBendRef.current = bend;
        lastPressureRef.current = pressure;

        // Send MIDI: bend/pressure first, then note
        api.sendPitchBend(channel, bend);
        api.sendChannelPressure(channel, pressure);
        api.sendNoteOn(channel, note, velocity);

        // Enhanced MIDI logging for troubleshooting
        const vel7 = Math.round(velocity * 127);
        const noteOnBytes = `${(0x90 | channel).toString(16).toUpperCase()} ${note.toString(16).toUpperCase().padStart(2, '0')} ${vel7.toString(16).toUpperCase().padStart(2, '0')}`;
        const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
        addLog(`TX: Note On [${noteOnBytes}] note=${note} vel=${vel7}${mpeInfo}`);

        // Draw with indicator
        drawPad(x, y);
    }, [isConnected, velocity, positionToValues, getNextNote, drawPad, api, addLog, mpeEnabled]);

    // Handle mouse move - modulate while playing (with throttling)
    const handleMouseMove = useCallback((e) => {
        if (!playingRef.current) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { bend, pressure } = positionToValues(x, y);

        // Always update visual state (responsive UI)
        setBendValue(bend);
        setPressureValue(pressure);
        drawPad(x, y);

        // Throttle MIDI sends to prevent flooding Candide
        const now = performance.now();
        const elapsed = now - lastSendTimeRef.current;
        const bendDelta = Math.abs(bend - lastBendRef.current);
        const pressureDelta = Math.abs(pressure - lastPressureRef.current);

        // Only send if: enough time elapsed AND significant change
        const shouldSend = elapsed >= THROTTLE_INTERVAL_MS &&
                          (bendDelta >= CHANGE_THRESHOLD || pressureDelta >= CHANGE_THRESHOLD);

        if (shouldSend) {
            const channel = currentChannelRef.current;
            api.sendPitchBend(channel, bend);
            api.sendChannelPressure(channel, pressure);

            // Update throttle state
            lastSendTimeRef.current = now;
            lastBendRef.current = bend;
            lastPressureRef.current = pressure;
        }
    }, [positionToValues, drawPad, api]);

    // Handle mouse up - stop note (only on mouseup, not mouseleave)
    // Bend/pressure values persist until next mouse down (avoids modulation snap during release phase)
    const handleMouseUp = useCallback(() => {
        if (!playingRef.current) return;

        // Send note off on the same channel
        const channel = currentChannelRef.current;
        api.sendNoteOff(channel, currentNote, 0);

        // Release MPE channel back to pool
        if (mpeEnabled) {
            mpeAllocatorRef.current.release(currentNote);
        }

        // Enhanced MIDI logging for troubleshooting
        const noteOffBytes = `${(0x80 | channel).toString(16).toUpperCase()} ${currentNote.toString(16).toUpperCase().padStart(2, '0')} 00`;
        const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
        addLog(`TX: Note Off [${noteOffBytes}] note=${currentNote}${mpeInfo}`);

        setIsPlaying(false);
        playingRef.current = false;

        // Redraw without indicator
        drawPad();
    }, [currentNote, drawPad, api, addLog, mpeEnabled]);

    // Add global mouseup listener for when user releases outside canvas
    useEffect(() => {
        const handleGlobalMouseUp = () => {
            if (playingRef.current) {
                handleMouseUp();
            }
        };

        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, [handleMouseUp]);

    // Note name helper
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const getNoteName = (note) => {
        const octave = Math.floor(note / 12) - 1;
        return `${noteNames[note % 12]}${octave}`;
    };

    return (
        <div className="midi-controls-row">
            <div className="velocity-control">
                <label>Velocity</label>
                <input
                    type="range"
                    className="velocity-slider"
                    min="0"
                    max="1"
                    step="0.01"
                    value={velocity}
                    onChange={(e) => setVelocity(parseFloat(e.target.value))}
                    disabled={!isConnected}
                />
                <span className="velocity-value">{Math.round(velocity * 127)}</span>
            </div>

            <div className="mpe-toggle">
                <label>
                    <input
                        type="checkbox"
                        checked={mpeEnabled}
                        onChange={(e) => {
                            const enabled = e.target.checked;
                            setMpeEnabled(enabled);
                            // Reset allocator when toggling
                            mpeAllocatorRef.current.reset();

                            // Send MPE Configuration Message (CC#127 on ch0)
                            // Value: 15 = enable (15 member channels), 0 = disable
                            if (api.midiOutput) {
                                const value = enabled ? 15 : 0;
                                const msg = new Uint8Array([0xB0, 0x7F, value]);
                                api.midiOutput.send(msg);
                                addLog(`TX: MPE Config [B0 7F ${value.toString(16).toUpperCase().padStart(2, '0')}] - ${enabled ? '15 member channels' : 'disabled'}`);
                            }
                        }}
                        disabled={!isConnected}
                    />
                    MPE Mode
                </label>
                {mpeEnabled && <span className="mpe-indicator">Per-note channels</span>}
            </div>

            <div className="expression-pad-container">
                <canvas
                    ref={canvasRef}
                    width={PAD_SIZE}
                    height={PAD_SIZE}
                    className="expression-pad"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    style={{ cursor: isConnected ? 'crosshair' : 'not-allowed' }}
                />
                <div className="pad-labels">
                    <span className="pad-label-bend">Bend: {bendValue.toFixed(2)}</span>
                    <span className="pad-label-pressure">Pres: {Math.round(pressureValue * 100)}%</span>
                </div>
            </div>

            <div className="note-display">
                {isPlaying ? (
                    <span className="note-playing">{getNoteName(currentNote)}</span>
                ) : (
                    <span className="note-waiting">Click pad</span>
                )}
            </div>
        </div>
    );
}

function ModuleChecklist({ enabledModules, orderedModules, onToggle, onMoveModule, disabled }) {
    const allModules = ['OSC0', 'OSC1', 'OSC2', 'FILTER', 'VAMP', 'GLFO', 'VLFO', 'MOD_ENV', 'VAMP_ENV'];

    // Enabled modules in priority order (from JSON), then disabled modules
    const enabledList = orderedModules || Array.from(enabledModules);
    const disabledList = allModules.filter(mod => !enabledModules.has(mod));

    return (
        <div className="module-checklist">
            <h3>Modules</h3>
            {/* Enabled modules with arrows */}
            {enabledList.map((mod, idx) => (
                <div key={mod} className="module-row">
                    <label>
                        <input
                            type="checkbox"
                            checked={true}
                            onChange={() => onToggle(mod, false)}
                            disabled={disabled}
                        />
                        {mod}
                    </label>
                    {enabledList.length > 1 && (
                        <div className="module-arrows">
                            <button
                                className="arrow-button"
                                onClick={() => onMoveModule(mod, enabledList[idx - 1])}
                                disabled={disabled || idx === 0}
                                title="Move up (higher priority)"
                            >
                                ▲
                            </button>
                            <button
                                className="arrow-button"
                                onClick={() => onMoveModule(mod, enabledList[idx + 1])}
                                disabled={disabled || idx === enabledList.length - 1}
                                title="Move down (lower priority)"
                            >
                                ▼
                            </button>
                        </div>
                    )}
                </div>
            ))}
            {/* Disabled modules (no arrows) */}
            {disabledList.length > 0 && enabledList.length > 0 && (
                <div className="module-divider" />
            )}
            {disabledList.map(mod => (
                <div key={mod} className="module-row disabled">
                    <label>
                        <input
                            type="checkbox"
                            checked={false}
                            onChange={() => onToggle(mod, true)}
                            disabled={disabled}
                        />
                        {mod}
                    </label>
                </div>
            ))}
        </div>
    );
}

function DeleteConfirmModal({ patchName, onConfirm, onCancel }) {
    return (
        <div className="progress-overlay">
            <div className="progress-modal delete-modal">
                <h3>Delete Patch?</h3>
                <p>Are you sure you want to delete "{patchName}"?</p>
                <p className="warning">This cannot be undone.</p>
                <div className="modal-buttons">
                    <button onClick={onCancel} className="cancel-button">Cancel</button>
                    <button onClick={onConfirm} className="confirm-delete-button">Delete</button>
                </div>
            </div>
        </div>
    );
}

function ExitPromptModal({ onSaveAndExit, onExitWithoutSaving, onCancel }) {
    return (
        <div className="progress-overlay">
            <div className="progress-modal exit-modal">
                <h3>Unsaved Changes</h3>
                <p>You have unsaved changes in RAM.</p>
                <p className="warning">Changes will be lost if you exit without saving.</p>
                <div className="modal-buttons">
                    <button onClick={onCancel} className="cancel-button">Cancel</button>
                    <button onClick={onExitWithoutSaving} className="exit-without-save-button">Exit Without Saving</button>
                    <button onClick={onSaveAndExit} className="save-and-exit-button">Save & Exit</button>
                </div>
            </div>
        </div>
    );
}

function FirmwareUpdateModal({ phase, progress, deviceInfo, targetFirmwareInfo, onConfirm, onRestart, onCancel }) {
    return (
        <div className="progress-overlay">
            <div className="progress-modal firmware-modal">
                {phase === 'confirm' && (
                    <>
                        <h3>Update Firmware</h3>
                        <div className="firmware-version-info">
                            <p>Current: {deviceInfo ? `v${deviceInfo.version}` : 'Unknown'}</p>
                            <p>Update to: {targetFirmwareInfo ? `v${targetFirmwareInfo.version}` : 'Unknown'}</p>
                        </div>
                        <p className="warning">Do not disconnect power during the update.</p>
                        <div className="modal-buttons">
                            <button onClick={onCancel} className="cancel-button">Cancel</button>
                            <button onClick={onConfirm} className="confirm-button" disabled={!targetFirmwareInfo}>Update</button>
                        </div>
                    </>
                )}

                {phase === 'erasing' && (
                    <>
                        <h3>Preparing Flash</h3>
                        <p>Erasing flash sectors...</p>
                        <div className="progress-bar-container">
                            <div className="progress-bar" style={{ width: `${progress}%` }}></div>
                        </div>
                        <p className="progress-text">{progress}%</p>
                        <p className="warning">Do not disconnect power.</p>
                    </>
                )}

                {(phase === 'transferring' || phase === 'flashing') && (
                    <>
                        <h3>Updating Firmware</h3>
                        <p>{phase === 'transferring' ? 'Transferring firmware...' : 'Writing to flash...'}</p>
                        <div className="progress-bar-container">
                            <div className="progress-bar" style={{ width: `${progress}%` }}></div>
                        </div>
                        <p className="progress-text">{progress}%</p>
                        <p className="warning">Do not disconnect power.</p>
                    </>
                )}

                {phase === 'ready' && (
                    <>
                        <h3>Firmware Ready</h3>
                        <p>Firmware has been written successfully.</p>
                        <p>Click Restart to apply the update.</p>
                        <div className="modal-buttons">
                            <button onClick={onRestart} className="confirm-button">Restart</button>
                        </div>
                    </>
                )}

                {phase === 'restarting' && (
                    <>
                        <h3>Restarting...</h3>
                        <p>Device is restarting. It will reconnect automatically.</p>
                        <div className="modal-buttons">
                            <button onClick={onCancel} className="confirm-button">OK</button>
                        </div>
                    </>
                )}

                {phase === 'complete' && (
                    <>
                        <h3>Update Complete</h3>
                        <p>Please reconnect to the device to continue.</p>
                        <div className="modal-buttons">
                            <button onClick={onCancel} className="confirm-button">Close</button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function ParameterEditor({ patch, topology, enabledModules, onParameterChange, onRangeChange, onModToggle, onModAmountChange, onCCToggle, disabled, api, velocity }) {
    if (!patch) {
        return (
            <div className="parameter-editor">
                <p>No patch loaded. Waiting for device connection...</p>
            </div>
        );
    }

    return (
        <div className="parameter-editor">
            {Array.from(enabledModules).map(moduleName => (
                <ModuleSection
                    key={moduleName}
                    moduleName={moduleName}
                    patch={patch}
                    topology={topology}
                    enabledModules={enabledModules}
                    onParameterChange={onParameterChange}
                    onRangeChange={onRangeChange}
                    onModToggle={onModToggle}
                    onModAmountChange={onModAmountChange}
                    onCCToggle={onCCToggle}
                    disabled={disabled}
                    api={api}
                    velocity={velocity}
                />
            ))}
        </div>
    );
}

function ModuleSection({ moduleName, patch, topology, enabledModules, onParameterChange, onRangeChange, onModToggle, onModAmountChange, onCCToggle, disabled, api, velocity }) {
    const moduleData = patch[moduleName];
    const moduleTopology = topology[moduleName];

    if (!moduleData || !moduleTopology) return null;

    return (
        <div className="module-section">
            <h3>{moduleName}</h3>
            {moduleTopology.params.map(({ key, disabledSources }) => {
                const paramData = moduleData[key];
                if (!paramData) return null;

                return (
                    <ParameterSlider
                        key={key}
                        moduleName={moduleName}
                        paramKey={key}
                        paramData={paramData}
                        patch={patch}
                        disabledSources={disabledSources}
                        enabledModules={enabledModules}
                        onParameterChange={onParameterChange}
                        onRangeChange={onRangeChange}
                        onModToggle={onModToggle}
                        onModAmountChange={onModAmountChange}
                        onCCToggle={onCCToggle}
                        disabled={disabled}
                        api={api}
                        velocity={velocity}
                    />
                );
            })}
        </div>
    );
}

// Map source names to their corresponding module names
function getSourceModuleName(source) {
    switch (source) {
        case 'GLFO': return 'GLFO';
        case 'VLFO': return 'VLFO';
        case 'MOD_ENV': return 'MOD_ENV';
        case 'VAMP_ENV': return 'VAMP_ENV';
        // VELOCITY, PRESSURE, BEND don't need modules enabled
        default: return null;
    }
}

/**
 * Value Slider - Single handle for editing default value
 *
 * Visual: [min input] [========●========] [max input]
 *                         ^value handle
 *
 * - Slider shows value within the current range [min, max]
 * - Click plays note, drag sends CC, mouse up commits value
 * - Min/max are edited via number inputs (thin client - device validates)
 */
function ValueSlider({
    min,              // Current range minimum (from patch)
    max,              // Current range maximum (from patch)
    value,            // Current default/initial value
    onValueChange,    // (newValue) => void - called on mouse UP only
    onDragStart,      // () => void (trigger note)
    onDragMove,       // (value) => void (send CC during drag)
    onDragEnd,        // () => void (note off)
    disabled,
    paramName         // Parameter name for curve lookup (see slider-config.js)
}) {
    const trackRef = useRef(null);
    const [dragging, setDragging] = useState(false);
    const [pendingValue, setPendingValue] = useState(value);

    // Sync pending value when prop changes (and not dragging)
    useEffect(() => {
        if (!dragging) {
            setPendingValue(value);
        }
    }, [value, dragging]);

    // Convert value to percentage position (0-100) within current range
    // Uses SliderConfig curves if available (see slider-config.js)
    const valueToPercent = useCallback((val) => {
        if (max === min) return 50;
        // SliderConfig provides LOG curves for frequency params (temporary fix)
        if (typeof SliderConfig !== 'undefined' && paramName) {
            const curve = SliderConfig.getCurve(paramName);
            return curve.valueToPercent(val, min, max) * 100;
        }
        return ((val - min) / (max - min)) * 100;
    }, [min, max, paramName]);

    // Convert percentage to value within current range
    // Uses SliderConfig curves if available (see slider-config.js)
    const percentToValue = useCallback((pct) => {
        pct = Math.max(0, Math.min(100, pct));
        // SliderConfig provides LOG curves for frequency params (temporary fix)
        if (typeof SliderConfig !== 'undefined' && paramName) {
            const curve = SliderConfig.getCurve(paramName);
            return curve.percentToValue(pct / 100, min, max);
        }
        return min + (pct / 100) * (max - min);
    }, [min, max, paramName]);

    // Get position from mouse/touch event
    const getPositionFromEvent = useCallback((e) => {
        if (!trackRef.current) return 50;
        const rect = trackRef.current.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const pct = ((clientX - rect.left) / rect.width) * 100;
        return Math.max(0, Math.min(100, pct));
    }, []);

    // Handle drag start
    const handleMouseDown = useCallback((e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
        onDragStart?.();
    }, [disabled, onDragStart]);

    // Handle drag move - only updates local state + CC
    useEffect(() => {
        if (!dragging) return;

        const handleMove = (e) => {
            const pct = getPositionFromEvent(e);
            const newValue = percentToValue(pct);
            setPendingValue(newValue);
            onDragMove?.(newValue);
        };

        const handleUp = () => {
            // Commit value on mouse up
            if (pendingValue !== value) {
                onValueChange?.(pendingValue);
            }
            setDragging(false);
            onDragEnd?.();
        };

        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
        document.addEventListener('touchmove', handleMove);
        document.addEventListener('touchend', handleUp);

        return () => {
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('mouseup', handleUp);
            document.removeEventListener('touchmove', handleMove);
            document.removeEventListener('touchend', handleUp);
        };
    }, [dragging, pendingValue, value, getPositionFromEvent, percentToValue, onValueChange, onDragMove, onDragEnd]);

    // Calculate handle position
    const valuePct = valueToPercent(pendingValue);

    return (
        <div className={`value-slider ${disabled ? 'disabled' : ''} ${dragging ? 'dragging' : ''}`}>
            <div className="slider-track" ref={trackRef}>
                {/* Fill from left to value */}
                <div
                    className="slider-fill"
                    style={{ width: `${valuePct}%` }}
                />
                {/* Value handle */}
                <div
                    className={`slider-handle ${dragging ? 'active' : ''}`}
                    style={{ left: `${valuePct}%` }}
                    onMouseDown={handleMouseDown}
                    onTouchStart={handleMouseDown}
                />
            </div>
        </div>
    );
}

function ParameterSlider({ moduleName, paramKey, paramData, patch, disabledSources, enabledModules, onParameterChange, onRangeChange, onModToggle, onModAmountChange, onCCToggle, disabled, api, velocity }) {
    const [min, max] = paramData.range;
    const value = paramData.initial;
    const cc = paramData.cc;  // CC number: 0-127 = enabled, -2 = disabled
    const ccEnabled = cc !== undefined && cc >= 0;

    const [editValue, setEditValue] = useState(value);
    const [editMin, setEditMin] = useState(min);
    const [editMax, setEditMax] = useState(max);

    // Track playing note for cleanup
    const playingNoteRef = useRef(null);

    useEffect(() => {
        setEditValue(value);
        setEditMin(min);
        setEditMax(max);
    }, [value, min, max]);

    // Handle value text input update
    const handleValueUpdate = () => {
        const numValue = parseFloat(editValue);
        if (!isNaN(numValue) && numValue !== value) {
            onParameterChange(moduleName, paramKey, numValue);
        } else {
            setEditValue(value);
        }
    };

    // Handle range text input update (device validates)
    const handleRangeUpdate = () => {
        const numMin = parseFloat(editMin);
        const numMax = parseFloat(editMax);
        if (!isNaN(numMin) && !isNaN(numMax) && numMin < numMax) {
            if (numMin !== min || numMax !== max) {
                onRangeChange(moduleName, paramKey, numMin, numMax);
            }
        } else {
            setEditMin(min);
            setEditMax(max);
        }
    };

    // MIDI callbacks for value slider
    const handleDragStart = useCallback(() => {
        if (api && velocity > 0) {
            const note = 60;  // Middle C for preview
            api.sendNoteOn(0, note, velocity);
            playingNoteRef.current = note;
        }
    }, [api, velocity]);

    const handleDragMove = useCallback((newValue) => {
        if (api && ccEnabled && cc >= 0) {
            // Use SliderConfig curve to convert value back to normalized CC
            // This reverses the percentToValue() transformation (see slider-config.js)
            let normalized;
            if (typeof SliderConfig !== 'undefined') {
                const curve = SliderConfig.getCurve(paramKey);
                normalized = curve.valueToPercent(newValue, min, max);
            } else {
                normalized = (max !== min) ? (newValue - min) / (max - min) : 0.5;
            }
            api.sendCC(0, cc, Math.max(0, Math.min(1, normalized)));
        }
    }, [api, ccEnabled, cc, min, max, paramKey]);

    const handleDragEnd = useCallback(() => {
        if (api && playingNoteRef.current !== null) {
            api.sendNoteOff(0, playingNoteRef.current);
            playingNoteRef.current = null;
        }
    }, [api]);

    // Handle value changes from ValueSlider
    const handleSliderValueChange = useCallback((newValue) => {
        setEditValue(newValue);
        onParameterChange(moduleName, paramKey, newValue);
    }, [moduleName, paramKey, onParameterChange]);

    // Compute active sources from existing AMOUNT params
    const activeSources = useMemo(() => {
        const sources = [];
        const moduleData = patch[moduleName];
        if (!moduleData) return sources;

        // Look for AMOUNT params matching this target
        const prefix = `${paramKey}_`;
        const suffix = '_AMOUNT';
        for (const key in moduleData) {
            if (key.startsWith(prefix) && key.endsWith(suffix)) {
                // Extract source name from "{paramKey}_{SOURCE}_AMOUNT"
                const source = key.slice(prefix.length, -suffix.length);
                sources.push(source);
            }
        }
        return sources;
    }, [patch, moduleName, paramKey]);

    // Combine active + disabled sources for display
    const allSources = useMemo(() => {
        const combined = new Set([...activeSources, ...disabledSources]);
        // Sort in consistent order
        const order = ['VELOCITY', 'GLFO', 'VLFO', 'MOD_ENV', 'VAMP_ENV', 'PRESSURE', 'BEND'];
        return order.filter(s => combined.has(s));
    }, [activeSources, disabledSources]);

    return (
        <div className="parameter">
            <div className="parameter-header">
                <span className="parameter-label">{formatParamName(paramKey)}</span>
                <input
                    type="number"
                    className="parameter-value-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleValueUpdate}
                    onKeyPress={(e) => e.key === 'Enter' && handleValueUpdate()}
                    step="any"
                    disabled={disabled}
                />
                <label className="cc-toggle">
                    <span className="cc-label">CC</span>
                    <input
                        type="checkbox"
                        checked={ccEnabled}
                        onChange={(e) => onCCToggle(paramKey, e.target.checked)}
                        disabled={disabled}
                    />
                    {ccEnabled && <span className="cc-number">{cc}</span>}
                </label>
            </div>
            <div className="parameter-range-controls">
                <input
                    type="number"
                    className="range-input"
                    value={editMin}
                    onChange={(e) => setEditMin(e.target.value)}
                    onBlur={handleRangeUpdate}
                    onKeyPress={(e) => e.key === 'Enter' && handleRangeUpdate()}
                    step="any"
                    disabled={disabled}
                />
                <ValueSlider
                    min={min}
                    max={max}
                    value={value}
                    onValueChange={handleSliderValueChange}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDragEnd={handleDragEnd}
                    disabled={disabled}
                    paramName={paramKey}
                />
                <input
                    type="number"
                    className="range-input"
                    value={editMax}
                    onChange={(e) => setEditMax(e.target.value)}
                    onBlur={handleRangeUpdate}
                    onKeyPress={(e) => e.key === 'Enter' && handleRangeUpdate()}
                    step="any"
                    disabled={disabled}
                />
            </div>

            {allSources.length > 0 && (
                <div className="modulation-routing">
                    {allSources.map(source => {
                        const isChecked = activeSources.includes(source);
                        const amountKey = `${paramKey}_${source}_AMOUNT`;
                        const amountData = isChecked && patch[moduleName] ? patch[moduleName][amountKey] : null;
                        const [amountMin, amountMax] = amountData ? amountData.range : getAmountRange(amountKey);
                        const amountValue = amountData ? amountData.initial : 1.0;

                        // Check if source module is enabled (VELOCITY/PRESSURE/BEND don't need modules)
                        const sourceModule = getSourceModuleName(source);
                        const sourceEnabled = sourceModule === null || enabledModules.has(sourceModule);

                        return (
                            <ModulationSlider
                                key={source}
                                source={source}
                                paramKey={paramKey}
                                amountKey={amountKey}
                                isChecked={isChecked}
                                amountValue={amountValue}
                                amountMin={amountMin}
                                amountMax={amountMax}
                                amountCC={amountData ? amountData.cc : undefined}
                                onModToggle={onModToggle}
                                onModAmountChange={onModAmountChange}
                                onCCToggle={onCCToggle}
                                disabled={disabled || !sourceEnabled}
                                sourceEnabled={sourceEnabled}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function ModulationSlider({ source, paramKey, amountKey, isChecked, amountValue, amountMin, amountMax, amountCC, onModToggle, onModAmountChange, onCCToggle, disabled, sourceEnabled }) {
    const [editAmount, setEditAmount] = useState(amountValue);
    const ccEnabled = amountCC !== undefined && amountCC >= 0;

    useEffect(() => {
        setEditAmount(amountValue);
    }, [amountValue]);

    return (
        <div className={`modulation-item ${!sourceEnabled ? 'source-disabled' : ''}`}>
            <label className="modulation-checkbox">
                <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => onModToggle(paramKey, source, e.target.checked)}
                    disabled={disabled}
                />
                <span className={!sourceEnabled ? 'source-label-disabled' : ''}>{source}</span>
            </label>
            {isChecked && (
                <div className="modulation-slider">
                    <input
                        type="range"
                        min={amountMin}
                        max={amountMax}
                        step={0.001}
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        onMouseUp={(e) => onModAmountChange(paramKey, source, parseFloat(e.target.value))}
                        onTouchEnd={(e) => onModAmountChange(paramKey, source, parseFloat(e.target.value))}
                        disabled={disabled}
                    />
                    <span className="modulation-value">{parseFloat(editAmount).toFixed(3)}</span>
                    <label className="cc-toggle cc-toggle-small">
                        <span className="cc-label">CC</span>
                        <input
                            type="checkbox"
                            checked={ccEnabled}
                            onChange={(e) => onCCToggle(amountKey, e.target.checked)}
                            disabled={disabled}
                        />
                        {ccEnabled && <span className="cc-number">{amountCC}</span>}
                    </label>
                </div>
            )}
        </div>
    );
}

function JsonViewer({ patch }) {
    return (
        <div className="json-viewer">
            <pre>{patch ? JSON.stringify(patch, null, 2) : 'No patch loaded'}</pre>
        </div>
    );
}

//======================================================================
// RENDER APP
//======================================================================

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
);
