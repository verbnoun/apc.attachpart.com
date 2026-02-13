/**
 * Attach Part Console - Main Application (Unified Protocol)
 *
 * Architecture:
 * - Menu Bar (top): app name, log/sync buttons, device status
 * - Desktop (main area): device icons + workspace windows
 *
 * Backend layer:
 * - UnifiedDeviceAPI (capability-based device communication)
 * - DeviceRegistry (generic MIDI port management)
 * - Transport layers (chunked SysEx)
 *
 * Device discovery: get-device-info returns capabilities array
 * All devices handled identically - capabilities determine features
 */

const { useState, useEffect, useCallback, useRef } = React;

//======================================================================
// MAIN APP COMPONENT
//======================================================================

function App() {
    // Device state - indexed by port name
    // { 'Candide MPE': { status, deviceInfo, api, ... }, ... }
    const [devices, setDevices] = useState({});

    // Device APIs - indexed by port name
    const deviceApisRef = useRef({});
    const deviceRegistryRef = useRef(null);
    const midiStateRef = useRef(null);

    // Patch state (for devices with PATCHES capability)
    const [patchList, setPatchList] = useState([]);
    const [currentPatchIndex, setCurrentPatchIndex] = useState(-1);
    const [currentPatch, setCurrentPatch] = useState(null);
    const [topology, setTopology] = useState(null);

    // Config state (for devices with CONFIG capability)
    const [configByDevice, setConfigByDevice] = useState({});

    // Track which device has which role
    const [synthPortName, setSynthPortName] = useState(null);
    const [controllerPortName, setControllerPortName] = useState(null);

    // Ref to track synthPortName for use in callbacks (avoids stale closure)
    const synthPortNameRef = useRef(null);

    // Focused window app name (for menu bar)
    const [focusedApp, setFocusedApp] = useState(null);

    // Logs
    const [logs, setLogs] = useState([]);

    const addLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs(prev => [...prev.slice(-99), { message, type, timestamp }]);
    }, []);

    // Sync logs (separate from main log)
    const [syncLogs, setSyncLogs] = useState([]);

    const addSyncLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setSyncLogs(prev => [...prev.slice(-49), { message, type, timestamp }]);
    }, []);

    //------------------------------------------------------------------
    // DEVICE REGISTRY SETUP
    //------------------------------------------------------------------

    useEffect(() => {
        const registry = new DeviceRegistry();
        deviceRegistryRef.current = registry;

        const midiState = new MidiState();
        midiStateRef.current = midiState;
        registry.onMidiThrough((data) => midiState.handleMidiThrough(data));
        registry.onAllMidiInput((portName, data) => midiState.handleAllMidiInput(portName, data));

        registry.onDeviceConnected((portName) => {
            addLog(`Device connected: ${portName}`, 'success');
            initDevice(portName);
        });

        registry.onDeviceDisconnected((portName) => {
            addLog(`Device disconnected: ${portName}`, 'warning');
            cleanupDevice(portName);
        });

        registry.init(addLog).then(() => {
            addLog('Device registry initialized', 'info');
        }).catch(err => {
            console.error('Registry init failed:', err);
            addLog(`Registry init failed: ${err.message}`, 'error');
        });

        // Setup workspace persistence callbacks
        WindowManager.onGeometryChange = (windowId, geometry) => {
            WorkspacePersistence.saveGeometry(windowId, geometry);
        };

        WindowManager.onWindowClose = (windowId) => {
            WorkspacePersistence.setWasOpen(windowId, false);
        };

        WindowManager.onWindowFocus = (windowId, title) => {
            setFocusedApp(title || null);
        };

        // Restore tool windows that were previously open
        const openTools = WorkspacePersistence.getOpenToolWindows();
        // Defer to next tick to ensure handlers are ready
        setTimeout(() => {
            for (const windowId of openTools) {
                if (windowId === 'log-window') {
                    openLogWindow();
                } else if (windowId === 'expression-pad') {
                    openExpressionPad();
                } else if (windowId === 'sync-window') {
                    openSyncWindow();
                }
            }
        }, 0);

        return () => {
            WindowManager.onGeometryChange = null;
            WindowManager.onWindowClose = null;
            WindowManager.onWindowFocus = null;
        };
    }, []);

    //------------------------------------------------------------------
    // DEVICE INITIALIZATION (Generic)
    //------------------------------------------------------------------

    const initDevice = async (portName) => {
        const registry = deviceRegistryRef.current;
        if (!registry) return;

        // Update status to connecting
        setDevices(prev => ({
            ...prev,
            [portName]: { ...prev[portName], status: 'connecting' }
        }));

        addLog(`Initializing ${portName}...`, 'info');

        try {
            const api = new UnifiedDeviceAPI();
            api._logFn = addLog;

            // Configure API with registry (API uses registry for all I/O)
            api.setRegistry(registry, portName);

            // Register with registry for SysEx routing
            registry.registerApi(portName, api);

            deviceApisRef.current[portName] = api;

            api.onSaveStatusChanged((status) => {
                setDevices(prev => ({
                    ...prev,
                    [portName]: { ...prev[portName], saveStatus: status }
                }));
            });

            api.onExternalPatchChange((index) => {
                addLog(`External patch change to ${index}`, 'info');
                loadPatch(index);
            });

            // Discover capabilities
            const discovered = await api.discover();
            if (!discovered) {
                throw new Error('Device discovery failed');
            }

            const deviceInfo = api.deviceInfo;
            const capabilities = api.capabilities;

            // Set device roles based on capabilities
            if (capabilities.includes(CAPABILITIES.CONTROLLER)) {
                registry.setControllerDevice(portName);
                setControllerPortName(portName);
            }
            if (capabilities.includes(CAPABILITIES.SYNTH)) {
                registry.setSynthDevice(portName);
                setSynthPortName(portName);
                synthPortNameRef.current = portName;
            }

            // Load capability-specific data
            if (capabilities.includes(CAPABILITIES.CONFIG)) {
                const config = await api.getConfig();
                // Synth config has modules/mod_targets (used by patch editor)
                if (config.modules && config.mod_targets) {
                    setTopology(config);
                    addLog(`Loaded config: ${Object.keys(config.mod_targets || {}).length} mod sources`, 'info');
                }
                // Controller config has keyboard/pots (stored separately)
                if (config.keyboard || config.pots) {
                    setConfigByDevice(prev => ({
                        ...prev,
                        [portName]: config
                    }));
                }
            }

            if (capabilities.includes(CAPABILITIES.PATCHES)) {
                const patches = await api.listPatches();
                const patchNames = patches.patches || [];
                const deviceCurrentIndex = patches.current_index ?? 0;
                addLog(`Loaded ${patchNames.length} patches (device on patch ${deviceCurrentIndex})`, 'info');
                setPatchList(patchNames);
                setCurrentPatchIndex(deviceCurrentIndex);
            }

            // Update device state
            setDevices(prev => ({
                ...prev,
                [portName]: {
                    status: 'connected',
                    deviceInfo,
                    capabilities,
                    saveStatus: 'saved'
                }
            }));

            addLog(`${deviceInfo.name || portName} initialized`, 'success');

            // Auto-reopen device window if it was previously open
            if (WorkspacePersistence.wasDeviceWindowOpen(portName)) {
                setTimeout(() => openDeviceApp(portName), 0);
            }
        } catch (err) {
            addLog(`${portName} init failed: ${err.message}`, 'error');
            setDevices(prev => ({
                ...prev,
                [portName]: { ...prev[portName], status: 'error' }
            }));
        }
    };

    const cleanupDevice = (portName) => {
        const registry = deviceRegistryRef.current;
        if (registry) {
            registry.unregisterApi(portName);
        }

        delete deviceApisRef.current[portName];

        // Close device app window
        const windowId = `device-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.close(windowId);
            delete windowContainersRef.current[windowId];
        }

        // Clear role if this device had one
        if (synthPortNameRef.current === portName) {
            setSynthPortName(null);
            synthPortNameRef.current = null;
            setTopology(null);
            setPatchList([]);
            setCurrentPatchIndex(-1);
            setCurrentPatch(null);
        }
        if (controllerPortName === portName) {
            setControllerPortName(null);
            midiStateRef.current?.reset();
        }

        setConfigByDevice(prev => {
            const next = { ...prev };
            delete next[portName];
            return next;
        });

        setDevices(prev => {
            const next = { ...prev };
            delete next[portName];
            return next;
        });
    };

    //------------------------------------------------------------------
    // PATCH OPERATIONS
    //------------------------------------------------------------------

    const loadPatch = async (index) => {
        if (!synthPortName) return null;
        const api = deviceApisRef.current[synthPortName];
        if (!api) return null;
        if (index < 0) return null;

        try {
            const patch = await api.getPatch(index);
            setCurrentPatch(patch);
            setCurrentPatchIndex(index);
            return patch;
        } catch (err) {
            addLog(`Failed to load patch: ${err.message}`, 'error');
            return null;
        }
    };

    const selectPatch = async (index) => {
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api) return;

        try {
            await api.selectPatch(index);
            await loadPatch(index);
        } catch (err) {
            addLog(`Failed to select patch: ${err.message}`, 'error');
        }
    };

    const createPatch = async () => {
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api) return;

        try {
            const name = `New Patch ${patchList.length + 1}`;
            await api.createPatch(name);
            const patches = await api.listPatches();
            setPatchList(patches.patches || []);
            await selectPatch(patches.patches.length - 1);
        } catch (err) {
            addLog(`Failed to create patch: ${err.message}`, 'error');
        }
    };

    const deletePatch = async (index) => {
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api) return;

        try {
            await api.deletePatch(index);
            const patches = await api.listPatches();
            setPatchList(patches.patches || []);
            setCurrentPatchIndex(-1);
            setCurrentPatch(null);
        } catch (err) {
            addLog(`Failed to delete patch: ${err.message}`, 'error');
        }
    };

    const renamePatch = async (index, newName) => {
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api) return;

        try {
            await api.renamePatch(index, newName);
            const patches = await api.listPatches();
            setPatchList(patches.patches || []);
        } catch (err) {
            addLog(`Failed to rename patch: ${err.message}`, 'error');
        }
    };

    const movePatch = async (from, to) => {
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api) return;

        try {
            await api.movePatch(from, to);
            const patches = await api.listPatches();
            setPatchList(patches.patches || []);
            setCurrentPatchIndex(to);
        } catch (err) {
            addLog(`Failed to move patch: ${err.message}`, 'error');
        }
    };

    //------------------------------------------------------------------
    // MODULE OPERATIONS
    //------------------------------------------------------------------

    const toggleModule = async (moduleName, enabled) => {
        if (!synthPortName) return null;
        const api = deviceApisRef.current[synthPortName];
        if (!api || currentPatchIndex < 0) return null;

        try {
            const result = await api.toggleModule(currentPatchIndex, moduleName, enabled);
            await loadPatch(currentPatchIndex);
            return result;  // Return for optimistic UI
        } catch (err) {
            addLog(`Failed to toggle module: ${err.message}`, 'error');
            return null;
        }
    };

    const updateParam = async (paramKey, options) => {
        // options can be a raw value (number) or object { value, priority }
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api || currentPatchIndex < 0) return;

        try {
            await api.updateParam(currentPatchIndex, paramKey, options);
            await loadPatch(currentPatchIndex);
        } catch (err) {
            addLog(`Failed to update param: ${err.message}`, 'error');
        }
    };

    const toggleModulation = async (targetParam, sourceModule, enabled) => {
        if (!synthPortName) return null;
        const api = deviceApisRef.current[synthPortName];
        if (!api || currentPatchIndex < 0) return null;

        try {
            const result = await api.toggleModulation(currentPatchIndex, targetParam, sourceModule, enabled);
            await loadPatch(currentPatchIndex);
            return result;  // Return for optimistic UI
        } catch (err) {
            addLog(`Failed to toggle modulation: ${err.message}`, 'error');
            return null;
        }
    };

    const updateModulationAmount = async (targetParam, sourceModule, amount) => {
        if (!synthPortName) return;
        const api = deviceApisRef.current[synthPortName];
        if (!api || currentPatchIndex < 0) return;

        const amountParam = `${targetParam}_${sourceModule}_AMOUNT`;
        try {
            await api.updateModulationAmount(currentPatchIndex, amountParam, amount);
            await loadPatch(currentPatchIndex);
        } catch (err) {
            addLog(`Failed to update mod amount: ${err.message}`, 'error');
        }
    };

    //------------------------------------------------------------------
    // CONFIG OPERATIONS
    //------------------------------------------------------------------

    const updateConfig = async (portName, partialConfig) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        try {
            const result = await api.setConfig(partialConfig);
            if (result.config) {
                setConfigByDevice(prev => ({
                    ...prev,
                    [portName]: result.config
                }));
            }
        } catch (err) {
            addLog(`Failed to update config: ${err.message}`, 'error');
        }
    };

    const saveDevice = async (portName) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        try {
            await api.save();
        } catch (err) {
            addLog(`Failed to save: ${err.message}`, 'error');
        }
    };

    //------------------------------------------------------------------
    // DESKTOP HANDLERS
    //------------------------------------------------------------------

    const handleDeviceOpen = (portName) => {
        addLog(`Opening device: ${portName}`, 'info');
        openDeviceApp(portName);
    };

    const handleToolOpen = (tool) => {
        addLog(`Tool: ${tool}`, 'info');
        if (tool === 'expression') {
            openExpressionPad();
        }
    };

    /**
     * Trigger exchange between synth and controller
     * Sends 'controller-available' to synth, which initiates the exchange
     */
    const triggerExchange = async () => {
        // Find synth and controller
        const synth = Object.entries(devices).find(([_, d]) =>
            d.status === 'connected' && d.capabilities?.includes('SYNTH')
        );
        const controller = Object.entries(devices).find(([_, d]) =>
            d.status === 'connected' && d.capabilities?.includes('CONTROLLER')
        );

        if (!synth) {
            addLog('No synth connected', 'warn');
            addSyncLog('No synth connected', 'warning');
            return;
        }
        if (!controller) {
            addLog('No controller connected', 'warn');
            addSyncLog('No controller connected', 'warning');
            return;
        }

        const [synthPort, synthDevice] = synth;
        const [controllerPort, controllerDevice] = controller;
        const synthApi = deviceApisRef.current[synthPort];

        if (!synthApi) {
            addLog('Synth API not ready', 'error');
            return;
        }

        addLog(`Triggering exchange: ${synthDevice.deviceInfo?.name || synthPort} → ${controllerDevice.deviceInfo?.name || controllerPort}`, 'info');
        addSyncLog(`Syncing: ${synthDevice.deviceInfo?.name || synthPort} → ${controllerDevice.deviceInfo?.name || controllerPort}`, 'info');

        // Enable SysEx relay between synth and controller
        const registry = deviceRegistryRef.current;
        if (registry) {
            registry.enableExchangeRelay(synthPort, controllerPort);
        }

        try {
            // Send controller-available to synth
            const controllerInfo = {
                device: controllerDevice.deviceInfo?.name || 'Controller',
                port: controllerPort
            };
            await synthApi.sendControllerAvailable(controllerInfo);
            addLog('Exchange initiated', 'success');
            addSyncLog('Exchange initiated', 'success');
        } catch (err) {
            addLog(`Exchange failed: ${err.message}`, 'error');
            addSyncLog(`Exchange failed: ${err.message}`, 'error');
            // Disable relay on failure
            if (registry) {
                registry.disableExchangeRelay();
            }
        }
    };

    //------------------------------------------------------------------
    // DERIVED STATE
    //------------------------------------------------------------------

    const isLinked = controllerPortName && synthPortName &&
                     devices[controllerPortName]?.status === 'connected' &&
                     devices[synthPortName]?.status === 'connected';

    //------------------------------------------------------------------
    // WINDOW CONTAINERS (for re-rendering)
    //------------------------------------------------------------------

    const windowContainersRef = useRef({});

    // Re-render device app windows when any relevant state changes
    useEffect(() => {
        for (const [portName, device] of Object.entries(devices)) {
            const windowId = `device-${portName}`;
            const container = windowContainersRef.current[windowId];
            if (container && WindowManager.exists(windowId)) {
                const capabilities = device.capabilities || [];
                const hasPatch = capabilities.includes(CAPABILITIES.PATCHES);
                const cConfig = controllerPortName ? configByDevice[controllerPortName] : null;
                ReactDOM.render(
                    <DeviceAppWindow
                        portName={portName}
                        device={device}
                        topology={topology}
                        patchList={patchList}
                        currentPatchIndex={currentPatchIndex}
                        currentPatch={currentPatch}
                        onSelectPatch={selectPatch}
                        onCreatePatch={createPatch}
                        onDeletePatch={deletePatch}
                        onRenamePatch={renamePatch}
                        onMovePatch={movePatch}
                        onToggleModule={toggleModule}
                        onUpdateParam={updateParam}
                        onToggleModulation={toggleModulation}
                        onUpdateModAmount={updateModulationAmount}
                        addLog={addLog}
                        midiState={midiStateRef.current}
                        controllerConfig={cConfig}
                        config={configByDevice[portName]}
                        onConfigChange={(cfg) => updateConfig(portName, cfg)}
                        onSave={() => saveDevice(portName)}
                        api={deviceApisRef.current[portName]}
                        defaultTab={hasPatch ? 'patches' : 'config'}
                    />,
                    container
                );
            }
        }
    }, [devices, configByDevice, topology, patchList, currentPatchIndex, currentPatch,
        synthPortName, controllerPortName, addLog]);

    // Re-render Log window when logs or topology change
    useEffect(() => {
        const container = windowContainersRef.current['log-window'];
        if (container && WindowManager.exists('log-window')) {
            ReactDOM.render(
                <LogWindow logs={logs} onClear={() => setLogs([])} topology={topology} />,
                container
            );
        }
    }, [logs, topology]);

    // Re-render Expression Pad when devices change
    useEffect(() => {
        const container = windowContainersRef.current['expression-pad'];
        if (container && WindowManager.exists('expression-pad')) {
            ReactDOM.render(
                <ExpressionPadWindow
                    devices={devices}
                    deviceApisRef={deviceApisRef}
                    synthPortName={synthPortName}
                    deviceRegistry={deviceRegistryRef.current}
                    midiState={midiStateRef.current}
                    addLog={addLog}
                />,
                container
            );
        }
    }, [synthPortName, devices, addLog]);

    // Re-render Sync window when devices or sync logs change
    useEffect(() => {
        const container = windowContainersRef.current['sync-window'];
        if (container && WindowManager.exists('sync-window')) {
            ReactDOM.render(
                <SyncWindow
                    devices={devices}
                    isLinked={isLinked}
                    onSync={triggerExchange}
                    syncLogs={syncLogs}
                />,
                container
            );
        }
    }, [devices, syncLogs, isLinked]);

    //------------------------------------------------------------------
    // WINDOW OPENERS
    //------------------------------------------------------------------

    const openDeviceApp = async (portName) => {
        const windowId = `device-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.focus(windowId);
            return;
        }

        const device = devices[portName];
        if (!device) return;
        const capabilities = device.capabilities || [];
        const deviceName = device.deviceInfo?.name || portName;
        const hasPatch = capabilities.includes(CAPABILITIES.PATCHES);
        const isController = capabilities.includes(CAPABILITIES.CONTROLLER);
        const theme = isController ? 'controller' : 'synth';

        // Ensure config is loaded
        const api = deviceApisRef.current[portName];
        if (capabilities.includes(CAPABILITIES.CONFIG) && !configByDevice[portName] && api) {
            try {
                const result = await api.getConfig();
                if (result.config) {
                    setConfigByDevice(prev => ({ ...prev, [portName]: result.config }));
                }
            } catch (err) {
                addLog(`Failed to load config: ${err.message}`, 'error');
            }
        }

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current[windowId] = container;

        const saved = WorkspacePersistence.getWindowState(windowId);

        WindowManager.create({
            id: windowId,
            title: deviceName,
            x: saved?.x ?? 100,
            y: saved?.y ?? 30,
            width: saved?.width ?? (hasPatch ? 1280 : 500),
            height: saved?.height ?? (hasPatch ? 800 : 450),
            content: container,
            theme,
            onClose: () => {
                delete windowContainersRef.current[windowId];
            }
        });

        WorkspacePersistence.setWasOpen(windowId, true);

        const cConfig = controllerPortName ? configByDevice[controllerPortName] : null;
        ReactDOM.render(
            <DeviceAppWindow
                portName={portName}
                device={device}
                topology={topology}
                patchList={patchList}
                currentPatchIndex={currentPatchIndex}
                currentPatch={currentPatch}
                onSelectPatch={selectPatch}
                onCreatePatch={createPatch}
                onDeletePatch={deletePatch}
                onRenamePatch={renamePatch}
                onMovePatch={movePatch}
                onToggleModule={toggleModule}
                onUpdateParam={updateParam}
                onToggleModulation={toggleModulation}
                onUpdateModAmount={updateModulationAmount}
                addLog={addLog}
                midiState={midiStateRef.current}
                controllerConfig={cConfig}
                config={configByDevice[portName]}
                onConfigChange={(cfg) => updateConfig(portName, cfg)}
                onSave={() => saveDevice(portName)}
                api={deviceApisRef.current[portName]}
                defaultTab={hasPatch ? 'patches' : 'config'}
            />,
            container
        );

        // Load initial patch if needed
        if (hasPatch && currentPatch === null && patchList.length > 0) {
            const initialIndex = currentPatchIndex >= 0 ? currentPatchIndex : 0;
            loadPatch(initialIndex);
        }
    };

    const openExpressionPad = () => {
        if (WindowManager.exists('expression-pad')) {
            WindowManager.focus('expression-pad');
            return;
        }

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current['expression-pad'] = container;

        const saved = WorkspacePersistence.getWindowState('expression-pad');

        WindowManager.create({
            id: 'expression-pad',
            title: 'Expression Pad',
            x: saved?.x ?? 150,
            y: saved?.y ?? 80,
            width: saved?.width ?? 320,
            height: saved?.height ?? 420,
            content: container,
            theme: 'tool',
            onClose: () => {
                delete windowContainersRef.current['expression-pad'];
            }
        });

        WorkspacePersistence.setWasOpen('expression-pad', true);

        ReactDOM.render(
            <ExpressionPadWindow
                devices={devices}
                deviceApisRef={deviceApisRef}
                synthPortName={synthPortName}
                deviceRegistry={deviceRegistryRef.current}
                midiState={midiStateRef.current}
                addLog={addLog}
            />,
            container
        );
    };

    const openLogWindow = () => {
        if (WindowManager.exists('log-window')) {
            WindowManager.focus('log-window');
            return;
        }

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current['log-window'] = container;

        const saved = WorkspacePersistence.getWindowState('log-window');

        WindowManager.create({
            id: 'log-window',
            title: 'Console Log',
            x: saved?.x ?? 400,
            y: saved?.y ?? 100,
            width: saved?.width ?? 450,
            height: saved?.height ?? 350,
            content: container,
            theme: 'tool',
            onClose: () => {
                delete windowContainersRef.current['log-window'];
            }
        });

        WorkspacePersistence.setWasOpen('log-window', true);

        ReactDOM.render(
            <LogWindow logs={logs} onClear={() => setLogs([])} topology={topology} />,
            container
        );
    };

    const openSyncWindow = () => {
        if (WindowManager.exists('sync-window')) {
            WindowManager.focus('sync-window');
            return;
        }

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current['sync-window'] = container;

        const saved = WorkspacePersistence.getWindowState('sync-window');

        WindowManager.create({
            id: 'sync-window',
            title: 'Sync',
            x: saved?.x ?? 300,
            y: saved?.y ?? 80,
            width: saved?.width ?? 380,
            height: saved?.height ?? 350,
            content: container,
            theme: 'tool',
            onClose: () => {
                delete windowContainersRef.current['sync-window'];
            }
        });

        WorkspacePersistence.setWasOpen('sync-window', true);

        ReactDOM.render(
            <SyncWindow
                devices={devices}
                isLinked={isLinked}
                onSync={triggerExchange}
                syncLogs={syncLogs}
            />,
            container
        );
    };

    //------------------------------------------------------------------
    // RENDER
    //------------------------------------------------------------------

    return (
        <div className="ap-container">
            <MenuBar
                devices={devices}
                isLinked={isLinked}
                focusedApp={focusedApp}
                onLogClick={() => openLogWindow()}
                onSyncClick={() => openSyncWindow()}
            />
            <Desktop
                devices={devices}
                onDeviceOpen={handleDeviceOpen}
                onToolOpen={handleToolOpen}
            />
        </div>
    );
}

//======================================================================
// FIRMWARE WINDOW
//======================================================================

function FirmwareWindow({ device, deviceInfo, api, onClose, addLog }) {
    const [step, setStep] = useState('select');
    const [progress, setProgress] = useState({ phase: '', percent: 0 });
    const [selectedFile, setSelectedFile] = useState(null);
    const [error, setError] = useState(null);
    const fileInputRef = useRef(null);

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (file) {
            setSelectedFile(file);
            setError(null);
        }
    };

    const handleUpload = async () => {
        if (!selectedFile || !api) return;

        setStep('uploading');
        setProgress({ phase: 'reading', percent: 0 });
        setError(null);

        try {
            const arrayBuffer = await selectedFile.arrayBuffer();
            const firmwareBin = new Uint8Array(arrayBuffer);

            addLog(`Starting firmware upload: ${firmwareBin.length} bytes`, 'info');

            await api.uploadFirmware(firmwareBin, (prog) => {
                setProgress(prog);
                addLog(`Firmware: ${prog.phase} ${prog.percent}%`, 'info');
            });

            setStep('complete');
            addLog('Firmware upload complete', 'success');
        } catch (err) {
            setStep('error');
            setError(err.message);
            addLog(`Firmware upload failed: ${err.message}`, 'error');
        }
    };

    const handleRestart = async () => {
        if (!api) return;

        try {
            addLog('Restarting device...', 'info');
            await api.restartDevice();
            onClose();
        } catch (err) {
            addLog(`Restart failed: ${err.message}`, 'error');
        }
    };

    const getProgressText = () => {
        switch (progress.phase) {
            case 'reading': return 'Reading file...';
            case 'erasing': return `Erasing flash... ${progress.percent}%`;
            case 'transferring': return `Transferring... ${progress.percent}%`;
            case 'flashing': return `Flashing... ${progress.percent}%`;
            case 'validated': return 'Firmware validated!';
            case 'complete': return 'Upload complete!';
            default: return 'Preparing...';
        }
    };

    const deviceName = deviceInfo?.name || device;

    return (
        <div className="ap-firmware-window">
            <div className="ap-firmware-device">
                <span className="ap-firmware-device-name">{deviceName.toUpperCase()}</span>
                {deviceInfo && (
                    <span className="ap-firmware-version">v{deviceInfo.version}</span>
                )}
            </div>

            {step === 'select' && (
                <div className="ap-firmware-select">
                    <input
                        type="file"
                        ref={fileInputRef}
                        accept=".bin"
                        onChange={handleFileSelect}
                        style={{ display: 'none' }}
                    />
                    <button
                        className="ap-btn"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        SELECT .BIN FILE
                    </button>

                    {selectedFile && (
                        <div className="ap-firmware-file-info">
                            <span className="ap-firmware-filename">{selectedFile.name}</span>
                            <span className="ap-firmware-filesize">
                                {(selectedFile.size / 1024).toFixed(1)} KB
                            </span>
                        </div>
                    )}

                    {error && (
                        <p className="ap-text-danger ap-mt-sm">{error}</p>
                    )}

                    <div className="ap-firmware-actions">
                        <button
                            className="ap-btn ap-btn-primary"
                            onClick={handleUpload}
                            disabled={!selectedFile || !api}
                        >
                            START UPDATE
                        </button>
                        <button className="ap-btn" onClick={onClose}>
                            CANCEL
                        </button>
                    </div>
                </div>
            )}

            {step === 'uploading' && (
                <div className="ap-firmware-progress">
                    <p className="ap-firmware-status">{getProgressText()}</p>
                    <div className="ap-progress-bar">
                        <div
                            className="ap-progress-fill"
                            style={{ width: `${progress.percent}%` }}
                        />
                    </div>
                    <p className="ap-text-muted ap-mt-sm">
                        Do not disconnect the device!
                    </p>
                </div>
            )}

            {step === 'complete' && (
                <div className="ap-firmware-complete">
                    <p className="ap-text-success">Firmware upload complete!</p>
                    <p className="ap-text-muted ap-mt-sm">
                        Restart the device to apply the update.
                    </p>
                    <div className="ap-firmware-actions">
                        <button
                            className="ap-btn ap-btn-success"
                            onClick={handleRestart}
                        >
                            RESTART DEVICE
                        </button>
                        <button className="ap-btn" onClick={onClose}>
                            CLOSE
                        </button>
                    </div>
                </div>
            )}

            {step === 'error' && (
                <div className="ap-firmware-error">
                    <p className="ap-text-danger">Update Failed</p>
                    <p className="ap-text-muted ap-mt-sm">{error}</p>
                    <div className="ap-firmware-actions">
                        <button
                            className="ap-btn"
                            onClick={() => {
                                setStep('select');
                                setError(null);
                            }}
                        >
                            TRY AGAIN
                        </button>
                        <button className="ap-btn" onClick={onClose}>
                            CLOSE
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

//======================================================================
// LANGUAGE WINDOW
//======================================================================

const AVAILABLE_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'jp', name: '日本語' }
];

function LanguageWindow({ device, api, deviceInfo, onClose, addLog }) {
    const [selectedLang, setSelectedLang] = useState('en');
    const [applying, setApplying] = useState(false);

    const currentLang = deviceInfo?.language || 'en';

    useEffect(() => {
        setSelectedLang(currentLang);
    }, [currentLang]);

    const handleApply = async () => {
        if (!api || selectedLang === currentLang) return;

        setApplying(true);
        addLog(`Setting language to ${selectedLang}...`, 'info');

        try {
            addLog('Language API not yet implemented', 'warning');
            setTimeout(() => {
                setApplying(false);
                onClose();
            }, 1000);
        } catch (err) {
            addLog(`Language change failed: ${err.message}`, 'error');
            setApplying(false);
        }
    };

    const deviceName = deviceInfo?.name || device;

    return (
        <div className="ap-language-window">
            <div className="ap-language-device">
                <span className="ap-language-device-name">{deviceName.toUpperCase()}</span>
            </div>

            <div className="ap-language-list">
                {AVAILABLE_LANGUAGES.map(lang => (
                    <label
                        key={lang.code}
                        className={`ap-language-option ${selectedLang === lang.code ? 'selected' : ''}`}
                    >
                        <input
                            type="radio"
                            name="language"
                            value={lang.code}
                            checked={selectedLang === lang.code}
                            onChange={(e) => setSelectedLang(e.target.value)}
                            disabled={applying}
                        />
                        <span className="ap-language-name">{lang.name}</span>
                        {lang.code === currentLang && (
                            <span className="ap-language-current">(current)</span>
                        )}
                    </label>
                ))}
            </div>

            <p className="ap-text-muted ap-language-note">
                Device will restart after language change.
            </p>

            <div className="ap-language-actions">
                <button
                    className="ap-btn ap-btn-primary"
                    onClick={handleApply}
                    disabled={applying || selectedLang === currentLang}
                >
                    {applying ? 'APPLYING...' : 'APPLY'}
                </button>
                <button className="ap-btn" onClick={onClose} disabled={applying}>
                    CANCEL
                </button>
            </div>
        </div>
    );
}

// Melody sequence for expression pad
const MELODY = [
    60, 64, 67, 72,
    71, 67, 64, 60,
    62, 65, 69, 74,
    72, 69, 65, 62,
];

// Color palette for polyphonic note display
const NOTE_COLORS = [
    '#ffb000',
    '#00ff88',
    '#ff4488',
    '#44aaff',
    '#ff8844',
    '#aa44ff',
];

function ExpressionPadWindow({ devices, deviceApisRef, synthPortName, deviceRegistry, midiState, addLog }) {
    const canvasRef = useRef(null);
    const [velocity, setVelocity] = useState(0.8);
    const [activeNotes, setActiveNotes] = useState(new Map());
    const [hideCursor, setHideCursor] = useState(false);
    const colorIndexRef = useRef(0);
    const melodyIndexRef = useRef(0);
    const playingRef = useRef(false);

    const [mpeEnabled, setMpeEnabled] = useState(true);
    const mpeAllocatorRef = useRef(new MpeChannelAllocator());
    const currentChannelRef = useRef(0);
    const mouseNoteRef = useRef(null);
    const mpeSentRef = useRef(false);

    const lastSendTimeRef = useRef(0);
    const lastBendRef = useRef(0);
    const lastPressureRef = useRef(0.5);
    const THROTTLE_INTERVAL_MS = 50;
    const CHANGE_THRESHOLD = 0.02;

    // Output target selection (which device receives pad output)
    const [selectedOutput, setSelectedOutput] = useState(null);

    // MIDI monitor — recent incoming events from all devices
    const [midiMonitor, setMidiMonitor] = useState([]);
    const monitorScrollRef = useRef(null);

    // Resolve output API — prefer selected, fallback to synth
    const outputPort = selectedOutput || synthPortName;
    const outputApi = outputPort ? deviceApisRef.current[outputPort] : null;
    const isConnected = outputApi && devices[outputPort]?.status === 'connected';

    // Build list of connected devices for output selector
    const connectedDevices = Object.entries(devices)
        .filter(([_, d]) => d.status === 'connected')
        .map(([portName, d]) => ({ portName, name: d.deviceInfo?.name || portName }));

    const PAD_SIZE = 200;
    const CENTER = PAD_SIZE / 2;
    const NEUTRAL_RADIUS = 30;

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const getNoteName = useCallback((note) => {
        const octave = Math.floor(note / 12) - 1;
        return `${noteNames[note % 12]}${octave}`;
    }, []);

    const getNextNote = useCallback(() => {
        const note = MELODY[melodyIndexRef.current];
        melodyIndexRef.current = (melodyIndexRef.current + 1) % MELODY.length;
        return note;
    }, []);

    const positionToValues = useCallback((x, y) => {
        const dx = x - CENTER;
        const dy = y - CENTER;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy);

        if (distFromCenter <= NEUTRAL_RADIUS) {
            return { bend: 0, pressure: 0.5 };
        }

        const bend = ((x / PAD_SIZE) * 2) - 1;
        const pressure = y / PAD_SIZE;
        return {
            bend: Math.max(-1, Math.min(1, bend)),
            pressure: Math.max(0, Math.min(1, pressure))
        };
    }, [PAD_SIZE, CENTER, NEUTRAL_RADIUS]);

    const valuesToPosition = useCallback((bend, pressure) => {
        const x = ((bend + 1) / 2) * PAD_SIZE;
        const y = pressure * PAD_SIZE;
        return { x, y };
    }, [PAD_SIZE]);

    const drawPad = useCallback((notes = []) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, PAD_SIZE, PAD_SIZE);

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(CENTER, 0);
        ctx.lineTo(CENTER, PAD_SIZE);
        ctx.moveTo(0, CENTER);
        ctx.lineTo(PAD_SIZE, CENTER);
        ctx.stroke();

        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, NEUTRAL_RADIUS, 0, Math.PI * 2);
        ctx.stroke();

        notes.forEach(({ note, bend, pressure, colorIndex }) => {
            const { x, y } = valuesToPosition(bend, pressure);
            const color = NOTE_COLORS[colorIndex % NOTE_COLORS.length];
            const noteName = getNoteName(note);

            ctx.shadowColor = color;
            ctx.shadowBlur = 15;
            ctx.fillStyle = color;
            ctx.font = 'bold 16px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(noteName, x, y);
            ctx.shadowBlur = 0;
        });
    }, [PAD_SIZE, CENTER, NEUTRAL_RADIUS, valuesToPosition, getNoteName]);

    useEffect(() => {
        drawPad();
    }, [drawPad]);

    useEffect(() => {
        drawPad(Array.from(activeNotes.values()));
    }, [activeNotes, drawPad]);

    // Send MPE config when output connects
    useEffect(() => {
        if (isConnected && outputApi?.isConnected() && mpeEnabled && !mpeSentRef.current) {
            const msg = new Uint8Array([0xB0, 0x7F, 15]);
            outputApi.sendRaw(msg);
            addLog('TX: MPE Config [B0 7F 0F] - 15 member channels');
            mpeSentRef.current = true;
        }
        if (!isConnected) {
            mpeSentRef.current = false;
        }
    }, [isConnected, outputApi, mpeEnabled, addLog]);

    // Subscribe to all-input MIDI events for the monitor
    useEffect(() => {
        if (!midiState) return;

        const unsubscribe = midiState.subscribe((eventType, data) => {
            // Handle routed notes (from controller->synth through) for pad display
            if (eventType === 'noteOn') {
                setActiveNotes(prev => {
                    const next = new Map(prev);
                    const colorIndex = colorIndexRef.current++;
                    next.set(data.channel, {
                        note: data.note,
                        velocity: data.velocity,
                        bend: 0,
                        pressure: 0.5,
                        colorIndex
                    });
                    return next;
                });
            } else if (eventType === 'noteOff') {
                setActiveNotes(prev => {
                    const next = new Map(prev);
                    next.delete(data.channel);
                    return next;
                });
            } else if (eventType === 'bend') {
                setActiveNotes(prev => {
                    const existing = prev.get(data.channel);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(data.channel, { ...existing, bend: data.bend });
                    return next;
                });
            } else if (eventType === 'pressure') {
                setActiveNotes(prev => {
                    const existing = prev.get(data.channel);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(data.channel, { ...existing, pressure: data.pressure });
                    return next;
                });
            } else if (eventType === 'reset') {
                setActiveNotes(new Map());
            }

            // All-input events for MIDI monitor
            if (eventType.startsWith('all')) {
                const time = new Date().toLocaleTimeString([], { hour12: false });
                let desc = '';
                if (eventType === 'allNoteOn') {
                    desc = `NoteOn ${data.note} vel=${Math.round(data.velocity * 127)} ch${data.channel}`;
                } else if (eventType === 'allNoteOff') {
                    desc = `NoteOff ${data.note} ch${data.channel}`;
                } else if (eventType === 'allBend') {
                    desc = `Bend ${data.bend.toFixed(2)} ch${data.channel}`;
                } else if (eventType === 'allPressure') {
                    desc = `Pres ${Math.round(data.pressure * 127)} ch${data.channel}`;
                } else if (eventType === 'allCC') {
                    desc = `CC${data.cc}=${data.value} ch${data.channel}`;
                }
                if (desc) {
                    setMidiMonitor(prev => [...prev.slice(-29), {
                        time,
                        source: data.source,
                        desc
                    }]);
                }
            }
        });

        return unsubscribe;
    }, [midiState]);

    // Auto-scroll monitor
    useEffect(() => {
        if (monitorScrollRef.current) {
            monitorScrollRef.current.scrollTop = monitorScrollRef.current.scrollHeight;
        }
    }, [midiMonitor]);

    const handleMouseDown = useCallback((e) => {
        if (!isConnected || !outputApi) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { bend, pressure } = positionToValues(x, y);
        const note = getNextNote();

        const channel = mpeEnabled ? mpeAllocatorRef.current.allocate(note) : 0;
        currentChannelRef.current = channel;
        mouseNoteRef.current = note;
        playingRef.current = true;

        setActiveNotes(prev => {
            const next = new Map(prev);
            const colorIndex = colorIndexRef.current++;
            next.set(channel, { note, bend, pressure, colorIndex });
            return next;
        });

        setHideCursor(true);
        lastSendTimeRef.current = performance.now();
        lastBendRef.current = bend;
        lastPressureRef.current = pressure;

        outputApi.sendPitchBend(channel, bend);
        outputApi.sendChannelPressure(channel, pressure);
        outputApi.sendNoteOn(channel, note, velocity);

        const vel7 = Math.round(velocity * 127);
        const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
        addLog(`TX: Note On note=${note} vel=${vel7}${mpeInfo}`);
    }, [isConnected, outputApi, velocity, positionToValues, getNextNote, mpeEnabled, addLog]);

    const handleMouseMove = useCallback((e) => {
        if (!playingRef.current || !outputApi) return;

        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { bend, pressure } = positionToValues(x, y);
        const channel = currentChannelRef.current;

        setActiveNotes(prev => {
            const existing = prev.get(channel);
            if (!existing) return prev;
            const next = new Map(prev);
            next.set(channel, { ...existing, bend, pressure });
            return next;
        });

        const now = performance.now();
        const elapsed = now - lastSendTimeRef.current;
        const bendDelta = Math.abs(bend - lastBendRef.current);
        const pressureDelta = Math.abs(pressure - lastPressureRef.current);

        const shouldSend = elapsed >= THROTTLE_INTERVAL_MS &&
                          (bendDelta >= CHANGE_THRESHOLD || pressureDelta >= CHANGE_THRESHOLD);

        if (shouldSend) {
            outputApi.sendPitchBend(channel, bend);
            outputApi.sendChannelPressure(channel, pressure);
            lastSendTimeRef.current = now;
            lastBendRef.current = bend;
            lastPressureRef.current = pressure;
        }
    }, [outputApi, positionToValues]);

    const handleMouseUp = useCallback(() => {
        if (!playingRef.current || !outputApi) return;

        const channel = currentChannelRef.current;
        const note = mouseNoteRef.current;

        outputApi.sendNoteOff(channel, note, 0);

        if (mpeEnabled) {
            mpeAllocatorRef.current.release(note);
        }

        setActiveNotes(prev => {
            const next = new Map(prev);
            next.delete(channel);
            return next;
        });

        setHideCursor(false);

        const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
        addLog(`TX: Note Off note=${note}${mpeInfo}`);

        playingRef.current = false;
        mouseNoteRef.current = null;
    }, [outputApi, mpeEnabled, addLog]);

    useEffect(() => {
        const handleGlobalMouseUp = () => {
            if (playingRef.current) {
                handleMouseUp();
            }
        };
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, [handleMouseUp]);

    const currentNote = Array.from(activeNotes.values())[0];

    // Source colors for MIDI monitor
    const sourceColors = {};
    let colorIdx = 0;
    const MONITOR_COLORS = ['#d4a574', '#b8a0d2', '#92cc41', '#209cee', '#f7d51d', '#e76e55'];

    return (
        <div className="ap-expression-pad">
            {/* Output target selector */}
            {connectedDevices.length > 1 && (
                <div className="ap-pad-output-select">
                    <span className="ap-pad-output-label">Output:</span>
                    {connectedDevices.map(d => (
                        <button
                            key={d.portName}
                            className={`ap-pad-output-btn ${(outputPort === d.portName) ? 'active' : ''}`}
                            onClick={() => {
                                setSelectedOutput(d.portName);
                                mpeSentRef.current = false;
                            }}
                        >
                            {d.name}
                        </button>
                    ))}
                </div>
            )}

            <div className="ap-pad-controls">
                <div className="ap-velocity-control">
                    <span>Velocity</span>
                    <input
                        type="range"
                        className="ap-slider"
                        min="0"
                        max="1"
                        step="0.01"
                        value={velocity}
                        onChange={(e) => setVelocity(parseFloat(e.target.value))}
                        disabled={!isConnected}
                    />
                    <span className="ap-velocity-value">{Math.round(velocity * 127)}</span>
                </div>
                <label className="ap-mpe-toggle">
                    <input
                        type="checkbox"
                        checked={mpeEnabled}
                        onChange={(e) => {
                            const enabled = e.target.checked;
                            setMpeEnabled(enabled);
                            mpeAllocatorRef.current.reset();
                            if (outputApi?.isConnected()) {
                                const value = enabled ? 15 : 0;
                                const msg = new Uint8Array([0xB0, 0x7F, value]);
                                outputApi.sendRaw(msg);
                                addLog(`TX: MPE Config - ${enabled ? 'enabled' : 'disabled'}`);
                            }
                        }}
                        disabled={!isConnected}
                    />
                    <span>MPE</span>
                </label>
            </div>

            <div className="ap-pad-canvas-container">
                <canvas
                    ref={canvasRef}
                    width={PAD_SIZE}
                    height={PAD_SIZE}
                    className="ap-pad-canvas"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    style={{ cursor: hideCursor ? 'none' : (isConnected ? 'crosshair' : 'not-allowed') }}
                />
            </div>

            <div className="ap-pad-labels">
                <span>Vel: {Math.round((currentNote?.velocity ?? 0) * 127)}</span>
                <span>Bend: {(currentNote?.bend ?? 0).toFixed(2)}</span>
                <span>Pres: {Math.round((currentNote?.pressure ?? 0.5) * 100)}%</span>
            </div>

            <div className="ap-pad-note">
                {activeNotes.size > 0 ? (
                    <span className="ap-note-playing">
                        {Array.from(activeNotes.values()).map(n => getNoteName(n.note)).join(' ')}
                    </span>
                ) : (
                    <span className="ap-note-waiting">{isConnected ? 'Click pad' : 'Not connected'}</span>
                )}
            </div>

            {/* MIDI Monitor */}
            <div className="ap-pad-monitor" ref={monitorScrollRef}>
                {midiMonitor.length === 0 ? (
                    <span className="ap-text-muted">MIDI monitor</span>
                ) : (
                    midiMonitor.map((entry, i) => {
                        if (!sourceColors[entry.source]) {
                            sourceColors[entry.source] = MONITOR_COLORS[colorIdx++ % MONITOR_COLORS.length];
                        }
                        return (
                            <div key={i} className="ap-monitor-entry">
                                <span className="ap-monitor-source" style={{ color: sourceColors[entry.source] }}>
                                    {entry.source.split(' ')[0]}
                                </span>
                                {' '}
                                <span className="ap-monitor-desc">{entry.desc}</span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

//======================================================================
// SYNC WINDOW
//======================================================================

function SyncWindow({ devices, isLinked, onSync, syncLogs }) {
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [syncLogs]);

    const deviceEntries = Object.entries(devices).filter(([_, d]) => d.status === 'connected');

    const getRole = (device) => {
        if (device.capabilities?.includes('CONTROLLER')) return 'Controller';
        if (device.capabilities?.includes('SYNTH')) return 'Synth';
        return 'Device';
    };

    return (
        <div className="ap-sync-window">
            <div className="ap-sync-devices">
                {deviceEntries.length === 0 ? (
                    <div className="ap-sync-no-devices">No devices connected</div>
                ) : (
                    deviceEntries.map(([portName, device]) => (
                        <div key={portName} className="ap-sync-device-row">
                            <span className="ap-sync-device-led connected"></span>
                            <span className="ap-sync-device-name">
                                {device.deviceInfo?.name || portName}
                            </span>
                            <span className="ap-sync-device-role">{getRole(device)}</span>
                        </div>
                    ))
                )}
            </div>
            <button
                className="ap-btn ap-sync-btn"
                onClick={onSync}
                disabled={!isLinked}
            >
                {isLinked ? 'SYNC DEVICES' : 'LINK REQUIRED'}
            </button>
            <div className="ap-sync-output" ref={scrollRef}>
                {syncLogs.length === 0 ? (
                    <span className="ap-text-muted">Sync output will appear here</span>
                ) : (
                    syncLogs.map((log, i) => (
                        <div key={i} className={`ap-sync-log-entry ap-sync-log-${log.type}`}>
                            <span className="ap-sync-log-time">[{log.timestamp}]</span>
                            {' '}
                            <span>{log.message}</span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

//======================================================================
// LOG WINDOW
//======================================================================

function LogWindow({ logs, onClear, topology }) {
    const [activeView, setActiveView] = useState('log');
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current && activeView === 'log') {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, activeView]);

    const logText = logs.map(log => {
        const typeTag = log.type === 'info' ? '' : `[${log.type.toUpperCase()}] `;
        return `[${log.timestamp}] ${typeTag}${log.message}`;
    }).join('\n');

    const topoText = topology
        ? JSON.stringify(topology, null, 2)
        : 'No topology loaded (connect a synth device)';

    return (
        <div className="ap-log-window">
            <div className="ap-log-toolbar">
                <div className="ap-tabs" style={{ background: 'transparent', padding: 0 }}>
                    <button
                        className={`ap-tab ${activeView === 'log' ? 'active' : ''}`}
                        onClick={() => setActiveView('log')}
                    >
                        LOG
                    </button>
                    <button
                        className={`ap-tab ${activeView === 'topo' ? 'active' : ''}`}
                        onClick={() => setActiveView('topo')}
                    >
                        TOPO
                    </button>
                </div>
                {activeView === 'log' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="ap-log-count">{logs.length} entries</span>
                        <button className="ap-btn ap-btn-small" onClick={onClear}>
                            CLEAR
                        </button>
                    </div>
                )}
            </div>
            <pre className="ap-log-text" ref={scrollRef}>
                {activeView === 'log'
                    ? (logs.length === 0 ? 'No log entries' : logText)
                    : topoText}
            </pre>
        </div>
    );
}

//======================================================================
// MOUNT
//======================================================================

ReactDOM.render(<App />, document.getElementById('root'));
