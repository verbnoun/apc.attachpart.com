/**
 * Attach Part Console - Main Application (Unified Protocol)
 *
 * Architecture:
 * - Menu Bar (top): app name, log/routing buttons, device status
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
// SPLASH SCREEN
//======================================================================

const SPLASH_LINES = [
    'Initializing flux capacitors...',
    'Loading 4 8 15 16 23 42...',
    'Reticulating splines...',
    'Calibrating temporal field...',
    'Engaging MIDI wormhole...',
    'Aligning oscillator crystals...',
    'Parsing the numbers...',
    'Buffering pixel dust...',
    'Indexing harmonic series...',
    'Compiling patch matrices...',
    'Warming up the tubes...',
    'Tuning subharmonic resonators...',
    'Mapping velocity curves...',
    'Bartleby says hello...',
    'Candide is warming up...',
    'Synchronizing clock domains...',
    'Polishing the chrome...',
];

function SplashScreen({ onDone }) {
    const [lines, setLines] = useState([]);
    const [progress, setProgress] = useState(0);
    const [done, setDone] = useState(false);
    const logRef = useRef(null);

    useEffect(() => {
        let i = 0;
        const total = SPLASH_LINES.length;
        const interval = setInterval(() => {
            if (i < total) {
                setLines(prev => [...prev, SPLASH_LINES[i]]);
                setProgress(Math.round(((i + 1) / total) * 100));
                i++;
            } else {
                clearInterval(interval);
                setDone(true);
            }
        }, 120);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [lines]);

    return (
        <div className="ap-splash">
            <div className="ap-splash-box">
                <div className="ap-splash-title">ATTACH PART CONSOLE</div>
                <div className="ap-splash-subtitle">
                    Research Preview : <a href="mailto:help@attachpart.com?subject=HELP!">help@attachpart.com</a>
                </div>
                <div className="ap-splash-log" ref={logRef}>
                    {lines.map((line, i) => <div key={i}>{line}</div>)}
                </div>
                <div className="ap-splash-progress">
                    <div className="ap-splash-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                {done && (
                    <button className="ap-btn ap-splash-start" onClick={onDone}>
                        Start
                    </button>
                )}
            </div>
        </div>
    );
}

//======================================================================
// MAIN APP COMPONENT
//======================================================================

function App() {
    // Splash screen
    const [showSplash, setShowSplash] = useState(true);

    // Device state - indexed by port name
    // { 'Candide MPE': { status, deviceInfo, api, ... }, ... }
    const [devices, setDevices] = useState({});
    const devicesRef = useRef(devices);
    devicesRef.current = devices;

    // Device APIs - indexed by port name
    const deviceApisRef = useRef({});
    const deviceRegistryRef = useRef(null);
    const midiStateRef = useRef(null);

    // Per-synth state map
    // { 'AP Estragon': { patchList, currentPatchIndex, currentPatch, topology }, ... }
    const [synthState, setSynthState] = useState({});
    const synthStateRef = useRef(synthState);
    synthStateRef.current = synthState;

    // Config state (for devices with CONFIG capability)
    const [configByDevice, setConfigByDevice] = useState({});

    // Routing state (React mirrors of DeviceRegistry route map)
    const [routes, setRoutes] = useState([]);
    const [configPairs, setConfigPairs] = useState({});

    // Virtual device instances (for UI access)
    const virtualDevicesRef = useRef({});

    // Focused window info (for per-app menu bar)
    // { id, type: 'apconsole'|'bartleby'|'candide'|'ahab', portName, title }
    const [focusedWindow, setFocusedWindow] = useState({ id: null, type: 'apconsole', portName: null, title: null });

    // Logs
    const [logs, setLogs] = useState([]);
    const [logActiveView, setLogActiveView] = useState('log');
    const logCountRef = useRef(null);
    const logClearRef = useRef(null);
    const logSelectRef = useRef(null);

    const addLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs(prev => [...prev.slice(-499), { message, type, timestamp }]);
    }, []);

    // Per-window info bar helpers
    const infoBarTimersRef = useRef({});

    const clearInfoBar = useCallback((windowId) => {
        if (infoBarTimersRef.current[windowId]) {
            clearTimeout(infoBarTimersRef.current[windowId]);
            delete infoBarTimersRef.current[windowId];
        }
        WindowManager.setInfoBar(windowId, { left: '' });
    }, []);

    const clearInfoBarDelayed = useCallback((windowId, delay = 2000) => {
        if (infoBarTimersRef.current[windowId]) {
            clearTimeout(infoBarTimersRef.current[windowId]);
        }
        infoBarTimersRef.current[windowId] = setTimeout(() => {
            delete infoBarTimersRef.current[windowId];
            WindowManager.setInfoBar(windowId, { left: '' });
        }, delay);
    }, []);

    const clearInfoBarFull = useCallback((windowId, delay = 2000) => {
        if (infoBarTimersRef.current[windowId]) {
            clearTimeout(infoBarTimersRef.current[windowId]);
        }
        infoBarTimersRef.current[windowId] = setTimeout(() => {
            delete infoBarTimersRef.current[windowId];
            WindowManager.setInfoBar(windowId, { left: '', right: '' });
            WindowManager.setInfoBarClickable(windowId, false);
        }, delay);
    }, []);

    // Helper to update per-synth state
    const updateSynthState = useCallback((portName, updates) => {
        setSynthState(prev => ({
            ...prev,
            [portName]: {
                ...(prev[portName] || { patchList: [], currentPatchIndex: -1, currentPatch: null, topology: null }),
                ...updates
            }
        }));
    }, []);

    // Routing logs (separate from main log)
    const [routingLogs, setRoutingLogs] = useState([]);

    const addRoutingLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setRoutingLogs(prev => [...prev.slice(-49), { message, type, timestamp }]);
    }, []);

    //------------------------------------------------------------------
    // DEVICE REGISTRY SETUP
    //------------------------------------------------------------------

    useEffect(() => {
        const registry = new DeviceRegistry();
        deviceRegistryRef.current = registry;

        const midiState = new MidiState();
        midiStateRef.current = midiState;
        registry.onMidiThrough((data, fromPort) => midiState.handleMidiThrough(data, fromPort));
        registry.onAllMidiInput((portName, data) => midiState.handleAllMidiInput(portName, data));

        // Value feedback observer — synth parameter values passing through relay
        registry.onValueFeedback((feedback) => {
            midiState.handleValueFeedback(feedback);
        });

        // Control surface observer — intercepted set-patch from exchange
        registry.onControlSurface((controls) => {
            midiStateRef.current?.handleControlSurface(controls);
        });

        // Control surface info observer — controller's dial/keyboard capabilities
        registry.onControlSurfaceInfo((info) => {
            const controllerPort = registry._exchangeControllerPort;
            if (!controllerPort || !info.controls) return;
            const dialCount = Object.values(info.controls).reduce((sum, n) => sum + n, 0);
            setConfigByDevice(prev => ({
                ...prev,
                [controllerPort]: { ...prev[controllerPort], dialCount }
            }));
        });

        // Route map change subscription
        registry.onRoutesChanged(() => {
            setRoutes(registry.getRoutes());
            setConfigPairs({ ...registry.getConfigPairs() });
            WorkspacePersistence.saveRoutes(registry.getRoutes());
            WorkspacePersistence.saveConfigPairs(registry.getConfigPairs());
        });

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

            // Start virtual devices (software MIDI devices living in APC)
            const pm = registry.getPortManager();
            if (pm) {
                const vSynth = new Estragon(pm);
                const ahab = new Ahab(pm);
                vSynth.start();
                ahab.start();
                virtualDevicesRef.current[vSynth._portName] = vSynth;
                virtualDevicesRef.current[ahab._portName] = ahab;
                addLog('Virtual devices started', 'info');
            }

            // Restore saved routes and config pairs
            const savedRoutes = WorkspacePersistence.loadRoutes();
            for (const { from, to } of savedRoutes) {
                registry.addRoute(from, to);
            }
            const savedPairs = WorkspacePersistence.loadConfigPairs();
            for (const [ctrl, synth] of Object.entries(savedPairs)) {
                registry.setConfigPair(ctrl, synth);
            }
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
            const toolWindows = ['log-window', 'expression-pad', 'routing-window', 'preferences', 'style-guide'];
            if (!windowId || toolWindows.includes(windowId)) {
                setFocusedWindow({ id: windowId, type: 'apconsole', portName: null, title: null });
            } else if (windowId.startsWith('config-')) {
                // config-{section}-{portName}
                const rest = windowId.replace('config-', '');
                const dashIdx = rest.indexOf('-');
                const portName = rest.substring(dashIdx + 1);
                const device = devicesRef.current[portName];
                const deviceName = device?.deviceInfo?.name || portName;
                setFocusedWindow({ id: windowId, type: 'bartleby', portName, title: deviceName });
            } else if (windowId.startsWith('ahab-')) {
                const portName = windowId.replace('ahab-', '');
                const device = devicesRef.current[portName];
                const deviceName = device?.deviceInfo?.name || portName;
                setFocusedWindow({ id: windowId, type: 'ahab', portName, title: deviceName });
            } else if (windowId.startsWith('device-')) {
                const portName = windowId.replace('device-', '');
                const device = devicesRef.current[portName];
                const caps = device?.capabilities || [];
                const type = caps.includes(CAPABILITIES.CONTROLLER) ? 'bartleby' : 'candide';
                const deviceName = device?.deviceInfo?.name || portName;
                setFocusedWindow({ id: windowId, type, portName, title: deviceName });
            } else {
                setFocusedWindow({ id: windowId, type: 'apconsole', portName: null, title: title || null });
            }
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
                } else if (windowId === 'routing-window') {
                    openRoutingWindow();
                } else if (windowId === 'sync-window') {
                    openRoutingWindow(); // Migration: old sync → new routing
                } else if (windowId === 'style-guide') {
                    openStyleGuide();
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

    const initDevice = async (portName, retryCount = 0) => {
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

            api.onExternalPatchChange((data) => {
                const index = data.current_index ?? data.index ?? data;
                addLog(`External patch change to ${index}`, 'info');
                loadPatch(portName, index).then(() => {
                    refreshControllerConfig(portName);
                });
            });

            // DM notifications (0x20 with "notification" key)
            api.onDmNotification((json) => {
                if (json.notification === 'patch-switched') {
                    addLog(`Patch switched to ${json.index}: ${json.name}`, 'info');
                    // If paired, exchange auto-starts — defer loadPatch to exchange-complete
                    // to avoid transport contention between exchange and get-patch
                    const registry = deviceRegistryRef.current;
                    const pairs = registry?.getConfigPairs() || {};
                    const isPaired = Object.values(pairs).includes(portName);
                    if (isPaired) {
                        updateSynthState(portName, { pendingPatchIndex: json.index });
                    } else {
                        loadPatch(portName, json.index);
                    }
                }
                else if (json.notification === 'exchange-complete') {
                    addLog(`Exchange complete: ${json.controls?.length || 0} controls`, 'success');
                    // Build pot-assigned param Set from controls array (#73)
                    const potParams = new Set((json.controls || []).map(c => c.input));
                    updateSynthState(portName, { potAssignedParams: potParams });
                    // Load patch now that exchange is done and transport is free
                    const ss = synthStateRef.current[portName] || {};
                    const idx = ss.pendingPatchIndex ?? ss.currentPatchIndex ?? 0;
                    loadPatch(portName, idx);
                    updateSynthState(portName, { pendingPatchIndex: undefined });
                }
                else if (json.notification === 'exchange-start') {
                    addLog('Exchange starting...', 'info');
                }
                else if (json.notification === 'exchange-failed') {
                    addLog(`Exchange failed: ${json.reason}`, 'error');
                }
            });

            // DM feedback (0x21 binary value feedback)
            api.onDmFeedback((feedback) => {
                midiStateRef.current?.handleValueFeedback({
                    uid: feedback.uid,
                    displayText: feedback.display,
                    portName
                });
            });

            // Discover capabilities
            const discovered = await api.discover();
            if (!discovered) {
                throw new Error('Device discovery failed');
            }

            const deviceInfo = api.deviceInfo;
            const capabilities = api.capabilities;

            // Load capability-specific data
            if (capabilities.includes(CAPABILITIES.CONFIG)) {
                const config = await api.getConfig();
                // Synth config has modules/mod_targets (used by patch editor)
                if (config.groups && config.mod_targets) {
                    updateSynthState(portName, { topology: config });
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
                updateSynthState(portName, { patchList: patchNames, initialPatchIndex: deviceCurrentIndex });
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

            // Connect virtual device if applicable
            const virtualDevice = virtualDevicesRef.current[portName];
            if (virtualDevice && virtualDevice.connect) {
                virtualDevice.connect();
            }

            // Auto-reopen windows if they were previously open
            if (capabilities.includes(CAPABILITIES.CONTROLLER)) {
                const project = deviceInfo?.project;
                if (project === 'Ahab') {
                    // Ahab opens its own sequencer window
                    const ahabWid = `ahab-${portName}`;
                    const ahabState = WorkspacePersistence.getWindowState(ahabWid);
                    if (ahabState?.wasOpen) {
                        setTimeout(() => openAhabWindow(portName), 0);
                    }
                } else {
                    // Bartleby and other controllers open config section windows
                    setTimeout(() => {
                        const sections = WorkspacePersistence.getOpenConfigWindows(portName);
                        if (sections.length > 0) {
                            for (const section of sections) {
                                openConfigWindow(portName, section);
                            }
                        } else if (WorkspacePersistence.wasDeviceWindowOpen(portName)) {
                            // Migration: old device window was open, open curves as default
                            openConfigWindow(portName, 'curves');
                        }
                    }, 0);
                }
            } else if (WorkspacePersistence.wasDeviceWindowOpen(portName)) {
                setTimeout(() => openDeviceApp(portName), 0);
            }
        } catch (err) {
            if (retryCount < 2) {
                addLog(`${portName} init failed, retrying... (${err.message})`, 'warning');
                setTimeout(() => initDevice(portName, retryCount + 1), 500);
            } else {
                addLog(`${portName} init failed: ${err.message}`, 'error');
                setDevices(prev => ({
                    ...prev,
                    [portName]: { ...prev[portName], status: 'error' }
                }));
            }
        }
    };

    const cleanupDevice = (portName) => {
        // Disconnect virtual device if applicable
        const virtualDevice = virtualDevicesRef.current[portName];
        if (virtualDevice && virtualDevice.disconnect) {
            virtualDevice.disconnect();
        }

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
            delete portalColumnsRef.current[windowId];
        }

        // Close all config section windows for this device
        for (const section of ['curves', 'dials', 'pedal', 'screen']) {
            const configWid = `config-${section}-${portName}`;
            if (WindowManager.exists(configWid)) {
                WindowManager.close(configWid);
                delete windowContainersRef.current[configWid];
            }
        }

        // Close Ahab window if open
        const ahabWid = `ahab-${portName}`;
        if (WindowManager.exists(ahabWid)) {
            WindowManager.close(ahabWid);
            delete windowContainersRef.current[ahabWid];
        }

        // Clear value feedback (synth may have been providing it)
        const ms = midiStateRef.current;
        if (ms) ms.clearValueFeedback(portName);

        // Clear per-synth state
        setSynthState(prev => {
            const next = { ...prev };
            delete next[portName];
            return next;
        });

        // Routes are cleaned up by registry disconnect handler

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

    const loadPatch = async (portName, index) => {
        const api = deviceApisRef.current[portName];
        if (!api || index < 0) return null;

        try {
            const patch = await api.getPatch(index);
            updateSynthState(portName, { currentPatch: patch, currentPatchIndex: index });

            // Seed MidiState with uid/display from get-patch response
            const ms = midiStateRef.current;
            if (ms && patch) {
                ms.clearValueFeedback(portName);
                for (const modKey of Object.keys(patch)) {
                    if (modKey === 'name' || modKey === 'index' || modKey === 'version') continue;
                    const mod = patch[modKey];
                    if (!mod || typeof mod !== 'object') continue;
                    for (const param of Object.values(mod)) {
                        if (param && typeof param === 'object' && param.uid !== undefined && param.display) {
                            ms.handleValueFeedback({ uid: param.uid, displayText: param.display, portName });
                        }
                    }
                }
            }

            return patch;
        } catch (err) {
            addLog(`Failed to load patch: ${err.message}`, 'error');
            return null;
        }
    };

    const selectPatch = async (portName, index) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;
        const wid = `device-${portName}`;

        if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `Loading patch ${index}…` });
        api.selectPatch(index);  // fire-and-forget

        // If paired, select-patch triggers auto-exchange on synth.
        // Defer loadPatch to exchange-complete handler — sending get-patch
        // during exchange causes transport contention (exchange chunks
        // get consumed by API transport instead of get-patch response).
        const registry = deviceRegistryRef.current;
        const pairs = registry?.getConfigPairs() || {};
        const isPaired = Object.values(pairs).includes(portName);

        if (isPaired) {
            updateSynthState(portName, { pendingPatchIndex: index });
            refreshControllerConfig(portName);
        } else {
            try {
                await loadPatch(portName, index);
            } catch (err) {
                addLog(`Failed to load patch: ${err.message}`, 'error');
            }
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '' });
            }
        }
    };

    const createPatch = async (portName) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;
        const wid = `device-${portName}`;

        const ss = synthStateRef.current[portName] || {};
        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: 'Creating patch…', right: 'Saving…' });
            const name = `New Patch ${(ss.patchList || []).length + 1}`;
            api.createPatch(name);  // fire-and-forget (serial MIDI guarantees ordering)
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [] });
            await selectPatch(portName, patches.patches.length - 1);
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to create patch: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message, right: 'Error' });
                clearInfoBarFull(wid, 3000);
            }
        }
    };

    const deletePatch = async (portName, index) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `Deleting patch ${index}…`, right: 'Saving…' });
            api.deletePatch(index);  // fire-and-forget
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [], currentPatchIndex: -1, currentPatch: null });
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to delete patch: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message, right: 'Error' });
                clearInfoBarFull(wid, 3000);
            }
        }
    };

    const renamePatch = async (portName, index, newName) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `Renaming…`, right: 'Saving…' });
            api.renamePatch(index, newName);  // fire-and-forget
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [] });
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to rename patch: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message, right: 'Error' });
                clearInfoBarFull(wid, 3000);
            }
        }
    };

    const movePatch = async (portName, from, to) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: 'Moving…', right: 'Saving…' });
            api.movePatch(from, to);  // fire-and-forget
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [], currentPatchIndex: to });
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to move patch: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message, right: 'Error' });
                clearInfoBarFull(wid, 3000);
            }
        }
    };

    //------------------------------------------------------------------
    // MODULE OPERATIONS
    //------------------------------------------------------------------

    const toggleModule = async (portName, moduleName, enabled) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return null;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `${enabled ? 'Adding' : 'Removing'} ${moduleName}…` });
            api.toggleModule(ss.currentPatchIndex, moduleName, enabled);  // fire-and-forget
            await loadPatch(portName, ss.currentPatchIndex);
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to toggle module: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message });
                clearInfoBarDelayed(wid, 3000);
            }
            return null;
        }
    };

    const liveParamChange = (portName, cc, normalizedValue) => {
        const api = deviceApisRef.current[portName];
        if (api && cc >= 0) api.sendCC(0, cc, normalizedValue);
    };

    const updateParam = async (portName, paramKey, options) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `${paramKey}…` });
            api.updateParam(ss.currentPatchIndex, paramKey, options);  // fire-and-forget
            const _p = await loadPatch(portName, ss.currentPatchIndex);
            if (_p) { const _m = _p[Object.keys(_p).find(k => _p[k]?.[paramKey])]; if (_m?.[paramKey]) addLog(`[DBG] ${paramKey} → v=${_m[paramKey].initial} d=${_m[paramKey].display} p=${_m[paramKey].priority}`, 'info'); }
            else addLog('[DBG] loadPatch returned null', 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to update param: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message });
                clearInfoBarDelayed(wid, 3000);
            }
        }
    };

    const updateRange = async (portName, paramKey, min, max) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `${paramKey} range…` });
            api.updateRange(ss.currentPatchIndex, paramKey, min, max);  // fire-and-forget
            await loadPatch(portName, ss.currentPatchIndex);
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to update range: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message });
                clearInfoBarDelayed(wid, 3000);
            }
        }
    };

    const toggleModulation = async (portName, targetParam, sourceModule, enabled) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return null;
        const wid = `device-${portName}`;

        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `${enabled ? 'Adding' : 'Removing'} ${sourceModule} → ${targetParam}…` });
            api.toggleModulation(ss.currentPatchIndex, targetParam, sourceModule, enabled);  // fire-and-forget
            await loadPatch(portName, ss.currentPatchIndex);
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to toggle modulation: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message });
                clearInfoBarDelayed(wid, 3000);
            }
            return null;
        }
    };

    const updateModulationAmount = async (portName, targetParam, sourceModule, amount) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return;
        const wid = `device-${portName}`;

        const amountParam = `${targetParam}_${sourceModule}_AMOUNT`;
        try {
            if (WindowManager.exists(wid)) WindowManager.setInfoBar(wid, { left: `${amountParam}…` });
            api.updateModulationAmount(ss.currentPatchIndex, amountParam, amount);  // fire-and-forget
            await loadPatch(portName, ss.currentPatchIndex);
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: '', right: 'Saved' });
                clearInfoBarDelayed(wid, 2000);
            }
        } catch (err) {
            addLog(`Failed to update mod amount: ${err.message}`, 'error');
            if (WindowManager.exists(wid)) {
                WindowManager.setInfoBar(wid, { left: err.message });
                clearInfoBarDelayed(wid, 3000);
            }
        }
    };

    //------------------------------------------------------------------
    // CONFIG OPERATIONS
    //------------------------------------------------------------------

    const updateConfig = async (portName, partialConfig, windowId) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        // Cancel any pending info bar clear timer
        if (windowId && infoBarTimersRef.current[windowId]) {
            clearTimeout(infoBarTimersRef.current[windowId]);
            delete infoBarTimersRef.current[windowId];
        }

        // Queue-based log display: each line shown for at least 250ms
        const logQueue = [];
        let logTimer = null;
        let onQueueDrain = null;

        const showNextLog = () => {
            if (logQueue.length === 0) {
                logTimer = null;
                if (onQueueDrain) onQueueDrain();
                return;
            }
            const msg = logQueue.shift();
            WindowManager.setInfoBar(windowId, { left: msg });
            logTimer = setTimeout(showNextLog, 80);
        };

        const origLog = api._logFn;
        if (windowId) {
            WindowManager.setInfoBar(windowId, { left: '', right: 'Sending\u2026' });
            WindowManager.setInfoBarClickable(windowId, false);
            api._logFn = (msg, type) => {
                origLog(msg, type);
                logQueue.push(msg);
                if (!logTimer) showNextLog();
            };
        }

        let configSent = false;
        let clearAfterDrain = false;
        try {
            // Step 1: config-set (writes to RAM, returns full config)
            const result = await api.setConfig(partialConfig);
            configSent = true;
            if (result.config) {
                setConfigByDevice(prev => ({
                    ...prev,
                    [portName]: result.config
                }));
            }

            // Step 2: save (writes RAM to flash)
            if (windowId) {
                WindowManager.setInfoBar(windowId, { right: 'Saving\u2026' });
            }
            await api.save();

            // Full success — "Saved" persists, clear left after queue drains
            setDevices(prev => ({
                ...prev,
                [portName]: { ...prev[portName], saveStatus: 'saved' }
            }));
            if (windowId) {
                WindowManager.setInfoBar(windowId, { right: 'Saved' });
                clearAfterDrain = true;
            }
        } catch (err) {
            addLog(`Config update failed: ${err.message}`, 'error');
            if (windowId) {
                if (configSent) {
                    // Config in RAM, save failed — offer retry
                    setDevices(prev => ({
                        ...prev,
                        [portName]: { ...prev[portName], saveStatus: 'unsaved' }
                    }));
                    WindowManager.setInfoBar(windowId, { right: 'Click To Save' });
                    WindowManager.setInfoBarClickable(windowId, true);
                } else {
                    // Config-set failed — device unchanged, revert to Saved
                    WindowManager.setInfoBar(windowId, { right: 'Saved' });
                    clearAfterDrain = true;
                }
            }
        } finally {
            api._logFn = origLog;
            // Start clear timer after queue drains (so last line gets full screen time)
            if (windowId && clearAfterDrain) {
                onQueueDrain = () => clearInfoBarDelayed(windowId, 250);
                if (!logTimer) clearInfoBarDelayed(windowId, 250);
            }
        }
    };

    // Retry-only save (called from info bar click when save previously failed)
    const saveDevice = async (portName, windowId) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        // Cancel any pending info bar timer
        if (windowId && infoBarTimersRef.current[windowId]) {
            clearTimeout(infoBarTimersRef.current[windowId]);
            delete infoBarTimersRef.current[windowId];
        }

        // Queue-based log display: each line shown for at least 250ms
        const logQueue = [];
        let logTimer = null;
        let onQueueDrain = null;

        const showNextLog = () => {
            if (logQueue.length === 0) {
                logTimer = null;
                if (onQueueDrain) onQueueDrain();
                return;
            }
            const msg = logQueue.shift();
            WindowManager.setInfoBar(windowId, { left: msg });
            logTimer = setTimeout(showNextLog, 80);
        };

        const origLog = api._logFn;
        if (windowId) {
            WindowManager.setInfoBar(windowId, { left: '', right: 'Saving\u2026' });
            WindowManager.setInfoBarClickable(windowId, false);
            api._logFn = (msg, type) => {
                origLog(msg, type);
                logQueue.push(msg);
                if (!logTimer) showNextLog();
            };
        }

        let clearAfterDrain = false;
        try {
            await api.save();
            setDevices(prev => ({
                ...prev,
                [portName]: { ...prev[portName], saveStatus: 'saved' }
            }));
            if (windowId) {
                WindowManager.setInfoBar(windowId, { right: 'Saved' });
                clearAfterDrain = true;
            }
        } catch (err) {
            addLog(`Save failed: ${err.message}`, 'error');
            if (windowId) {
                WindowManager.setInfoBar(windowId, { right: 'Click To Save' });
                WindowManager.setInfoBarClickable(windowId, true);
            }
        } finally {
            api._logFn = origLog;
            if (windowId && clearAfterDrain) {
                onQueueDrain = () => clearInfoBarDelayed(windowId, 250);
                if (!logTimer) clearInfoBarDelayed(windowId, 250);
            }
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
        } else if (tool === 'style-guide') {
            openStyleGuide();
        }
    };

    /**
     * Trigger pair + exchange between a specific synth and controller pair
     * Sends pair command to both devices — synth auto-triggers exchange.
     * @param {string} controllerPort
     * @param {string} synthPort
     */
    const triggerExchange = async (controllerPort, synthPort) => {
        const controllerDevice = devices[controllerPort];
        const synthDevice = devices[synthPort];
        const synthApi = deviceApisRef.current[synthPort];
        const controllerApi = deviceApisRef.current[controllerPort];

        if (!synthDevice || synthDevice.status !== 'connected') {
            addLog('Synth not connected', 'warning');
            addRoutingLog('Synth not connected', 'warning');
            return;
        }
        if (!controllerDevice || controllerDevice.status !== 'connected') {
            addLog('Controller not connected', 'warning');
            addRoutingLog('Controller not connected', 'warning');
            return;
        }
        if (!synthApi) {
            addLog('Synth API not ready', 'error');
            return;
        }

        addLog(`Pairing: ${synthDevice.deviceInfo?.name || synthPort} ⇄ ${controllerDevice.deviceInfo?.name || controllerPort}`, 'info');
        addRoutingLog(`Pairing: ${synthDevice.deviceInfo?.name || synthPort} ⇄ ${controllerDevice.deviceInfo?.name || controllerPort}`, 'info');

        const registry = deviceRegistryRef.current;

        try {
            const synthMuid = synthApi.deviceInfo?.muid || 0;
            const controllerMuid = controllerApi?.deviceInfo?.muid || 0;

            await synthApi.sendPair(controllerMuid);
            if (controllerApi) {
                await controllerApi.sendPair(synthMuid);
            }
            addLog('Pair + exchange initiated', 'success');
            addRoutingLog('Pair + exchange initiated', 'success');
        } catch (err) {
            addLog(`Pair failed: ${err.message}`, 'error');
            addRoutingLog(`Pair failed: ${err.message}`, 'error');
            registry.clearConfigPair(controllerPort);
        }
    };

    //------------------------------------------------------------------
    // WINDOW CONTAINERS (for re-rendering)
    //------------------------------------------------------------------

    const windowContainersRef = useRef({});
    const portalColumnsRef = useRef({}); // { windowId: { modules: el, workspace: el } }

    // Re-render device app windows (synth/Candide) when relevant state changes
    useEffect(() => {
        for (const [portName, device] of Object.entries(devices)) {
            const windowId = `device-${portName}`;
            const container = windowContainersRef.current[windowId];
            if (container && WindowManager.exists(windowId)) {
                const ss = synthState[portName] || {};
                // Find the controller that is config-paired with this synth
                const pairedController = Object.entries(configPairs).find(([_, synth]) => synth === portName)?.[0];
                const cConfig = pairedController ? configByDevice[pairedController] : null;

                // Update info bar center with paired controller name
                const controllerName = pairedController ? (devices[pairedController]?.deviceInfo?.name || pairedController) : '';
                WindowManager.setInfoBar(windowId, { center: controllerName });

                const portals = portalColumnsRef.current[windowId] || {};
                ReactDOM.render(
                    <PatchEditorWindow
                        deviceKey={portName}
                        modulesCol={portals.modules}
                        workspaceCol={portals.workspace}
                        topology={ss.topology}
                        patchList={ss.patchList || []}
                        currentIndex={ss.currentPatchIndex ?? -1}
                        currentPatch={ss.currentPatch}
                        onSelectPatch={(idx) => selectPatch(portName, idx)}
                        onCreatePatch={() => createPatch(portName)}
                        onDeletePatch={(idx) => deletePatch(portName, idx)}
                        onRenamePatch={(idx, name) => renamePatch(portName, idx, name)}
                        onMovePatch={(from, to) => movePatch(portName, from, to)}
                        onToggleModule={(mod, en) => toggleModule(portName, mod, en)}
                        onUpdateParam={(key, opts) => updateParam(portName, key, opts)}
                        onUpdateRange={(key, min, max) => updateRange(portName, key, min, max)}
                        onLiveChange={(cc, normalized) => liveParamChange(portName, cc, normalized)}
                        onToggleModulation={(t, s, en) => toggleModulation(portName, t, s, en)}
                        onUpdateModAmount={(t, s, a) => updateModulationAmount(portName, t, s, a)}
                        isConnected={device?.status === 'connected'}
                        addLog={addLog}
                        midiState={midiStateRef.current}
                        controllerConfig={cConfig}
                        hasController={!!pairedController}
                        potAssignedParams={ss.potAssignedParams}
                    />,
                    container
                );
            }
        }
    }, [devices, synthState, configPairs, configByDevice, addLog]);

    // Re-render config section windows when config state changes
    useEffect(() => {
        for (const [portName, device] of Object.entries(devices)) {
            const capabilities = device.capabilities || [];
            if (!capabilities.includes(CAPABILITIES.CONTROLLER)) continue;

            for (const section of ['curves', 'dials', 'pedal', 'screen']) {
                const windowId = `config-${section}-${portName}`;
                const container = windowContainersRef.current[windowId];
                if (container && WindowManager.exists(windowId)) {
                    // Info bar right slot managed by operations only — not re-render

                    ReactDOM.render(
                        <ConfigSectionWindow
                            config={configByDevice[portName]}
                            onConfigChange={(cfg) => updateConfig(portName, cfg, windowId)}
                            midiState={midiStateRef.current}
                            portName={portName}
                            section={section}
                        />,
                        container
                    );
                }
            }
        }
    }, [devices, configByDevice]);

    // Re-render Log window when logs, synthState, or view changes
    useEffect(() => {
        const container = windowContainersRef.current['log-window'];
        if (container && WindowManager.exists('log-window')) {
            // Show focused synth's topology, or first available
            const focusedSynthTopo = focusedWindow?.portName && synthState[focusedWindow.portName]?.topology;
            const firstTopo = Object.values(synthState).find(s => s.topology)?.topology || null;
            const topoForLog = focusedSynthTopo || firstTopo;

            ReactDOM.render(
                <LogWindow logs={logs} topology={topoForLog} activeView={logActiveView} />,
                container
            );
            // Auto-scroll content area
            const contentArea = WindowManager.getContentArea('log-window');
            if (contentArea && logActiveView === 'log') {
                requestAnimationFrame(() => {
                    contentArea.scrollTop = contentArea.scrollHeight;
                });
            }
            // Update view selector to reflect current value
            if (logSelectRef.current) {
                logSelectRef.current.update({ value: logActiveView });
            }
            // Update count (hide in topology view)
            if (logCountRef.current) {
                logCountRef.current.textContent = logActiveView === 'log'
                    ? `${logs.length} entries` : '';
            }
            if (logClearRef.current) {
                logClearRef.current.style.display = logActiveView === 'log' ? '' : 'none';
            }
        }
    }, [logs, synthState, logActiveView, focusedWindow]);

    // Re-render Expression Pad when devices change
    useEffect(() => {
        const container = windowContainersRef.current['expression-pad'];
        if (container && WindowManager.exists('expression-pad')) {
            // Find first synth port as default output
            const defaultSynthPort = Object.entries(devices)
                .find(([_, d]) => d.status === 'connected' && d.capabilities?.includes('SYNTH'))?.[0] || null;
            ReactDOM.render(
                <ExpressionPadWindow
                    devices={devices}
                    deviceApisRef={deviceApisRef}
                    synthPortName={defaultSynthPort}
                    deviceRegistry={deviceRegistryRef.current}
                    midiState={midiStateRef.current}
                    addLog={addLog}
                />,
                container
            );
        }
    }, [devices, addLog]);

    // Re-render Routing window when routes/config pairs/devices change
    useEffect(() => {
        const container = windowContainersRef.current['routing-window'];
        if (container && WindowManager.exists('routing-window')) {
            ReactDOM.render(
                <RoutingWindow
                    devices={devices}
                    routes={routes}
                    configPairs={configPairs}
                    onAddRoute={(from, to) => deviceRegistryRef.current?.addRoute(from, to)}
                    onRemoveRoute={(from, to) => deviceRegistryRef.current?.removeRoute(from, to)}
                    onSetConfigPair={(ctrl, synth) => {
                        const registry = deviceRegistryRef.current;
                        if (registry) {
                            registry.setConfigPair(ctrl, synth);
                            triggerExchange(ctrl, synth);
                        }
                    }}
                    onClearConfigPair={(ctrl) => deviceRegistryRef.current?.clearConfigPair(ctrl)}
                    routingLogs={routingLogs}
                />,
                container
            );
        }
    }, [devices, routes, configPairs, routingLogs]);

    //------------------------------------------------------------------
    // WINDOW OPENERS
    //------------------------------------------------------------------

    // Per-section window size constraints
    const CONFIG_SECTION_SIZES = {
        curves:  { width: 500, height: 620, maxHeight: 720, columns: [{ flex: 1, scroll: 'v' }], resizable: 'vertical' },
        dials:   { width: 1400, height: 220, columns: [{ flex: 1, scroll: 'h' }], resizable: 'horizontal' },
        pedal:   { width: 360, height: 250 },
        screen:  { width: 360, height: 250 }
    };

    const openConfigWindow = async (portName, section) => {
        const windowId = `config-${section}-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.focus(windowId);
            return;
        }

        const device = devices[portName];
        if (!device) return;
        const deviceName = device.deviceInfo?.name || portName;
        const sectionName = section.charAt(0).toUpperCase() + section.slice(1);

        // Ensure config is loaded
        const api = deviceApisRef.current[portName];
        if (!configByDevice[portName] && api) {
            try {
                const result = await api.getConfig();
                if (result.config) {
                    setConfigByDevice(prev => ({ ...prev, [portName]: result.config }));
                }
            } catch (err) {
                addLog(`Failed to load config: ${err.message}`, 'error');
            }
        }

        const sizes = CONFIG_SECTION_SIZES[section];
        const container = document.createElement('div');
        windowContainersRef.current[windowId] = container;

        const saved = WorkspacePersistence.getWindowState(windowId);

        WindowManager.create({
            id: windowId,
            title: `${deviceName} / ${sectionName}`,
            x: saved?.x ?? (100 + ['curves', 'dials', 'pedal', 'screen'].indexOf(section) * 30),
            y: saved?.y ?? (30 + ['curves', 'dials', 'pedal', 'screen'].indexOf(section) * 30),
            width: saved?.width ?? sizes.width,
            height: saved?.height ?? sizes.height,
            content: container,
            theme: 'controller',
            maxHeight: sizes.maxHeight,
            columns: sizes.columns,
            resizable: sizes.resizable,
            padding: false,
            infoBar: {
                left: '',
                right: 'Saved'
            },
            onInfoBarClick: (slot) => {
                if (slot === 'right' && devicesRef.current[portName]?.saveStatus === 'unsaved') {
                    saveDevice(portName, windowId);
                }
            },
            onClose: () => {
                // Clear any pending info bar timers
                if (infoBarTimersRef.current[windowId]) {
                    clearTimeout(infoBarTimersRef.current[windowId]);
                    delete infoBarTimersRef.current[windowId];
                }
                delete windowContainersRef.current[windowId];
            }
        });

        WorkspacePersistence.setWasOpen(windowId, true);

        ReactDOM.render(
            <ConfigSectionWindow
                config={configByDevice[portName]}
                onConfigChange={(cfg) => updateConfig(portName, cfg, windowId)}
                midiState={midiStateRef.current}
                portName={portName}
                section={section}
            />,
            container
        );
    };

    const openDeviceApp = async (portName) => {
        const device = devices[portName];
        if (!device) return;
        const capabilities = device.capabilities || [];

        // Controllers: dispatch by device project
        if (capabilities.includes(CAPABILITIES.CONTROLLER)) {
            const project = device.deviceInfo?.project;
            if (project === 'Ahab') {
                openAhabWindow(portName);
            } else {
                openConfigWindow(portName, 'curves');
            }
            return;
        }

        const windowId = `device-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.focus(windowId);
            return;
        }

        const deviceName = device.deviceInfo?.name || portName;
        const hasPatch = capabilities.includes(CAPABILITIES.PATCHES);

        const saved = WorkspacePersistence.getWindowState(windowId);
        const ss = synthState[portName] || {};
        const pairedController = Object.entries(configPairs).find(([_, synth]) => synth === portName)?.[0];
        const cConfig = pairedController ? configByDevice[pairedController] : null;

        // 3 proper WindowManager columns: patches (scroll:v), modules (scroll:v), workspace (fixed)
        const result = WindowManager.create({
            id: windowId,
            title: deviceName,
            x: saved?.x ?? 100,
            y: saved?.y ?? 30,
            width: saved?.width ?? (hasPatch ? 1280 : 500),
            height: saved?.height ?? (hasPatch ? 800 : 450),
            minWidth: 950,
            minHeight: 400,
            theme: 'synth',
            padding: false,
            resizable: true,
            columns: [
                { id: 'patches', width: 162, scroll: 'v' },
                { id: 'modules', width: 122, scroll: 'v' },
                { id: 'workspace', flex: 1, fixed: true }
            ],
            infoBar: {
                left: '',
                center: pairedController ? (devices[pairedController]?.deviceInfo?.name || pairedController) : '',
                right: 'Saved'
            },
            onInfoBarClick: (slot) => {
                if (slot === 'right' && devicesRef.current[portName]?.saveStatus === 'unsaved') {
                    saveDevice(portName, windowId);
                }
            },
            onClose: () => {
                if (infoBarTimersRef.current[windowId]) {
                    clearTimeout(infoBarTimersRef.current[windowId]);
                    delete infoBarTimersRef.current[windowId];
                }
                delete windowContainersRef.current[windowId];
                delete portalColumnsRef.current[windowId];
            }
        });

        // React renders into patches column; portals send content to modules & workspace columns
        windowContainersRef.current[windowId] = result.columns['patches'];
        portalColumnsRef.current[windowId] = {
            modules: result.columns['modules'],
            workspace: result.columns['workspace']
        };

        WorkspacePersistence.setWasOpen(windowId, true);

        ReactDOM.render(
            <PatchEditorWindow
                deviceKey={portName}
                modulesCol={result.columns['modules']}
                workspaceCol={result.columns['workspace']}
                topology={ss.topology}
                patchList={ss.patchList || []}
                currentIndex={ss.currentPatchIndex ?? -1}
                currentPatch={ss.currentPatch}
                onSelectPatch={(idx) => selectPatch(portName, idx)}
                onCreatePatch={() => createPatch(portName)}
                onDeletePatch={(idx) => deletePatch(portName, idx)}
                onRenamePatch={(idx, name) => renamePatch(portName, idx, name)}
                onMovePatch={(from, to) => movePatch(portName, from, to)}
                onToggleModule={(mod, en) => toggleModule(portName, mod, en)}
                onUpdateParam={(key, opts) => updateParam(portName, key, opts)}
                onUpdateRange={(key, min, max) => updateRange(portName, key, min, max)}
                onLiveChange={(cc, normalized) => liveParamChange(portName, cc, normalized)}
                onToggleModulation={(t, s, en) => toggleModulation(portName, t, s, en)}
                onUpdateModAmount={(t, s, a) => updateModulationAmount(portName, t, s, a)}
                isConnected={device?.status === 'connected'}
                addLog={addLog}
                midiState={midiStateRef.current}
                controllerConfig={cConfig}
                hasController={!!pairedController}
                potAssignedParams={ss.potAssignedParams}
            />,
            result.columns['patches']
        );

        // Select initial patch — same path as click selection
        if (hasPatch && ss.currentPatch == null && (ss.patchList || []).length > 0) {
            const initialIndex = (ss.initialPatchIndex ?? -1) >= 0 ? ss.initialPatchIndex : 0;
            selectPatch(portName, initialIndex);
        }
    };

    const openAhabWindow = (portName) => {
        const windowId = `ahab-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.focus(windowId);
            return;
        }

        const device = devices[portName];
        if (!device) return;
        const deviceName = device.deviceInfo?.name || 'Ahab';
        const ahabDevice = virtualDevicesRef.current[portName];
        if (!ahabDevice) {
            addLog(`Ahab device instance not found for ${portName}`, 'error');
            return;
        }

        const container = document.createElement('div');
        windowContainersRef.current[windowId] = container;

        const saved = WorkspacePersistence.getWindowState(windowId);

        WindowManager.create({
            id: windowId,
            title: deviceName,
            x: saved?.x ?? 80,
            y: saved?.y ?? 30,
            width: saved?.width ?? 620,
            height: saved?.height ?? 720,
            content: container,
            theme: 'controller',
            resizable: true,
            columns: [{ flex: 1, fixed: true }],
            padding: false,
            onClose: () => {
                delete windowContainersRef.current[windowId];
            }
        });

        WorkspacePersistence.setWasOpen(windowId, true);

        ReactDOM.render(
            <AhabWindow device={ahabDevice} />,
            container
        );
    };

    const openExpressionPad = () => {
        if (WindowManager.exists('expression-pad')) {
            WindowManager.focus('expression-pad');
            return;
        }

        const container = document.createElement('div');
        windowContainersRef.current['expression-pad'] = container;

        const saved = WorkspacePersistence.getWindowState('expression-pad');

        WindowManager.create({
            id: 'expression-pad',
            title: 'Expression Pad',
            x: saved?.x ?? 150,
            y: saved?.y ?? 80,
            width: saved?.width ?? 320,
            height: saved?.height ?? 570,
            content: container,
            theme: 'tool',
            columns: [{ flex: 1, scroll: 'v' }],
            onClose: () => {
                delete windowContainersRef.current['expression-pad'];
            }
        });

        WorkspacePersistence.setWasOpen('expression-pad', true);

        ReactDOM.render(
            <ExpressionPadWindow
                devices={devices}
                deviceApisRef={deviceApisRef}
                deviceRegistry={deviceRegistryRef.current}
                midiState={midiStateRef.current}
                addLog={addLog}
            />,
            container
        );
    };

    const openStyleGuide = () => {
        if (WindowManager.exists('style-guide')) {
            WindowManager.focus('style-guide');
            return;
        }

        const container = document.createElement('div');
        windowContainersRef.current['style-guide'] = container;

        const saved = WorkspacePersistence.getWindowState('style-guide');

        WindowManager.create({
            id: 'style-guide',
            title: 'Style Guide',
            x: saved?.x ?? 60,
            y: saved?.y ?? 20,
            width: saved?.width ?? 580,
            height: saved?.height ?? 700,
            content: container,
            theme: 'tool',
            resizable: true,
            onClose: () => {
                delete windowContainersRef.current['style-guide'];
            }
        });

        WorkspacePersistence.setWasOpen('style-guide', true);

        ReactDOM.render(
            <StyleGuide />,
            container
        );
    };

    const openLogWindow = () => {
        if (WindowManager.exists('log-window')) {
            WindowManager.focus('log-window');
            return;
        }

        const container = document.createElement('div');
        windowContainersRef.current['log-window'] = container;

        const saved = WorkspacePersistence.getWindowState('log-window');

        // Info bar left: view selector dropdown
        const viewSelectHandle = APSelect.create({
            value: logActiveView,
            options: [{ value: 'log', label: 'Log' }, { value: 'topo', label: 'Topology' }],
            onChange: (val) => setLogActiveView(val),
            className: 'ap-infobar-select'
        });
        logSelectRef.current = viewSelectHandle;
        const viewSelect = viewSelectHandle.element;

        // Info bar right: count + clear button
        const rightContainer = document.createElement('span');
        rightContainer.className = 'ap-infobar-actions';
        const countSpan = document.createElement('span');
        countSpan.className = 'ap-infobar-count';
        countSpan.textContent = `${logs.length} entries`;
        const clearBtn = document.createElement('button');
        clearBtn.className = 'ap-infobar-btn';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', () => setLogs([]));
        rightContainer.appendChild(countSpan);
        rightContainer.appendChild(clearBtn);

        logCountRef.current = countSpan;
        logClearRef.current = clearBtn;

        WindowManager.create({
            id: 'log-window',
            title: 'Console Log',
            x: saved?.x ?? 400,
            y: saved?.y ?? 100,
            width: saved?.width ?? 450,
            height: saved?.height ?? 350,
            content: container,
            theme: 'tool',
            columns: [{ flex: 1, scroll: 'v' }],
            resizable: 'vertical',
            padding: false,
            infoBar: { left: viewSelect, right: rightContainer },
            onClose: () => {
                delete windowContainersRef.current['log-window'];
                logCountRef.current = null;
                logClearRef.current = null;
                logSelectRef.current = null;
            }
        });

        WorkspacePersistence.setWasOpen('log-window', true);

        const firstTopo = Object.values(synthState).find(s => s.topology)?.topology || null;
        ReactDOM.render(
            <LogWindow logs={logs} topology={firstTopo} activeView={logActiveView} />,
            container
        );
    };

    const openRoutingWindow = () => {
        if (WindowManager.exists('routing-window')) {
            WindowManager.focus('routing-window');
            return;
        }

        const container = document.createElement('div');
        windowContainersRef.current['routing-window'] = container;

        const saved = WorkspacePersistence.getWindowState('routing-window');

        WindowManager.create({
            id: 'routing-window',
            title: 'Routing',
            x: saved?.x ?? 300,
            y: saved?.y ?? 80,
            width: saved?.width ?? 420,
            height: saved?.height ?? 380,
            content: container,
            theme: 'tool',
            columns: [{ flex: 1, fixed: true }],
            onClose: () => {
                delete windowContainersRef.current['routing-window'];
            }
        });

        WorkspacePersistence.setWasOpen('routing-window', true);

        ReactDOM.render(
            <RoutingWindow
                devices={devices}
                routes={routes}
                configPairs={configPairs}
                onAddRoute={(from, to) => deviceRegistryRef.current?.addRoute(from, to)}
                onRemoveRoute={(from, to) => deviceRegistryRef.current?.removeRoute(from, to)}
                onSetConfigPair={(ctrl, synth) => {
                    const registry = deviceRegistryRef.current;
                    if (registry) {
                        registry.setConfigPair(ctrl, synth);
                        triggerExchange(ctrl, synth);
                    }
                }}
                onClearConfigPair={(ctrl) => deviceRegistryRef.current?.clearConfigPair(ctrl)}
                routingLogs={routingLogs}
            />,
            container
        );
    };

    const openPreferencesWindow = () => {
        if (WindowManager.exists('preferences')) {
            WindowManager.focus('preferences');
            return;
        }

        const container = document.createElement('div');
        windowContainersRef.current['preferences'] = container;

        const saved = WorkspacePersistence.getWindowState('preferences');

        WindowManager.create({
            id: 'preferences',
            title: 'Preferences',
            x: saved?.x ?? 200,
            y: saved?.y ?? 100,
            width: saved?.width ?? 360,
            height: saved?.height ?? 280,
            content: container,
            theme: 'tool',
            columns: [{ flex: 1, fixed: true }],
            onClose: () => {
                delete windowContainersRef.current['preferences'];
            }
        });

        container.innerHTML = '<div style="padding: 24px; font-family: Chicago_12; font-size: 16px; color: #808080; text-align: center; margin-top: 60px;">Preferences coming soon.</div>';
    };

    // Open Firmware or Language as a standalone tool window for the focused device
    const openDeviceToolWindow = (tool) => {
        const portName = focusedWindow.portName;
        if (!portName) return;
        const device = devices[portName];
        if (!device) return;

        const windowId = `${tool}-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.focus(windowId);
            return;
        }

        const deviceName = device.deviceInfo?.name || portName;
        const container = document.createElement('div');
        windowContainersRef.current[windowId] = container;

        const saved = WorkspacePersistence.getWindowState(windowId);

        WindowManager.create({
            id: windowId,
            title: `${deviceName} / ${tool.charAt(0).toUpperCase() + tool.slice(1)}`,
            x: saved?.x ?? 250,
            y: saved?.y ?? 80,
            width: saved?.width ?? 360,
            height: saved?.height ?? (tool === 'firmware' ? 300 : 340),
            content: container,
            theme: 'tool',
            columns: [{ flex: 1, fixed: true }],
            onClose: () => {
                delete windowContainersRef.current[windowId];
            }
        });

        const Component = tool === 'firmware' ? FirmwareWindow : LanguageWindow;
        ReactDOM.render(
            <Component
                device={device}
                deviceInfo={device.deviceInfo}
                api={deviceApisRef.current[portName]}
                onClose={() => WindowManager.close(windowId)}
                addLog={addLog}
            />,
            container
        );
    };

    //------------------------------------------------------------------
    // APP SWITCHER — surface all windows for an app
    //------------------------------------------------------------------

    const surfaceApp = (appId) => {
        if (appId === 'apconsole') {
            const toolIds = ['log-window', 'routing-window', 'expression-pad', 'preferences', 'style-guide'];
            for (const id of toolIds) {
                if (WindowManager.exists(id)) WindowManager.focus(id);
            }
        } else {
            const portName = appId;
            for (const tool of ['firmware', 'language']) {
                const wid = `${tool}-${portName}`;
                if (WindowManager.exists(wid)) WindowManager.focus(wid);
            }
            for (const section of ['curves', 'dials', 'pedal', 'screen']) {
                const wid = `config-${section}-${portName}`;
                if (WindowManager.exists(wid)) WindowManager.focus(wid);
            }
            if (WindowManager.exists(`ahab-${portName}`)) WindowManager.focus(`ahab-${portName}`);
            if (WindowManager.exists(`device-${portName}`)) WindowManager.focus(`device-${portName}`);
        }
    };

    //------------------------------------------------------------------
    // RENDER
    //------------------------------------------------------------------

    // Build list of apps that have at least one open window
    const toolIds = ['log-window', 'routing-window', 'expression-pad', 'preferences', 'style-guide'];
    const hasToolWindow = toolIds.some(id => WindowManager.exists(id));
    const openApps = [];
    if (hasToolWindow) openApps.push({ id: 'apconsole', name: 'APConsole' });
    for (const [portName, device] of Object.entries(devices)) {
        if (device?.status !== 'connected') continue;
        const hasWindow =
            WindowManager.exists(`device-${portName}`) ||
            WindowManager.exists(`ahab-${portName}`) ||
            ['curves', 'dials', 'pedal', 'screen'].some(s => WindowManager.exists(`config-${s}-${portName}`)) ||
            ['firmware', 'language'].some(t => WindowManager.exists(`${t}-${portName}`));
        if (hasWindow) {
            openApps.push({ id: portName, name: device.deviceInfo?.name || portName });
        }
    }

    return (
        <React.Fragment>
            {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
            <div className="ap-container">
                <MenuBar
                    focusedWindow={focusedWindow}
                    openApps={openApps}
                    onSurfaceApp={surfaceApp}
                    onOpenConfigWindow={(section) => {
                        const portName = focusedWindow.portName;
                        if (portName) openConfigWindow(portName, section);
                    }}
                    onLogClick={() => openLogWindow()}
                    onSyncClick={() => openRoutingWindow()}
                    onExpressionPadClick={() => openExpressionPad()}
                    onPreferencesClick={() => openPreferencesWindow()}
                    onOpenDeviceTool={openDeviceToolWindow}
                    onToolOpen={handleToolOpen}
                />
                <Desktop
                    devices={devices}
                    onDeviceOpen={handleDeviceOpen}
                    onToolOpen={handleToolOpen}
                />
            </div>
        </React.Fragment>
    );
}

// Components loaded from separate files:
// - FirmwareWindow (firmware-window.js)
// - LanguageWindow (language-window.js)
// - ExpressionPadWindow (expression-pad-window.js)
// - RoutingPanel, RoutingWindow (routing-window.js)
// - LogWindow (log-window.js)

//======================================================================
// MOUNT
//======================================================================

ReactDOM.render(<App />, document.getElementById('root'));
