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
// MAIN APP COMPONENT
//======================================================================

function App() {
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
    // { 'AP Aach': { patchList, currentPatchIndex, currentPatch, topology }, ... }
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
    // { id, type: 'apconsole'|'bartleby'|'candide'|'abbott', portName, title }
    const [focusedWindow, setFocusedWindow] = useState({ id: null, type: 'apconsole', portName: null, title: null });

    // Logs
    const [logs, setLogs] = useState([]);
    const [logActiveView, setLogActiveView] = useState('log');
    const logCountRef = useRef(null);
    const logClearRef = useRef(null);

    const addLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs(prev => [...prev.slice(-99), { message, type, timestamp }]);
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
                const vSynth = new Aach(pm);
                const abbott = new Abbott(pm);
                vSynth.start();
                abbott.start();
                virtualDevicesRef.current[abbott._portName] = abbott;
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
            const toolWindows = ['log-window', 'expression-pad', 'routing-window', 'preferences'];
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
            } else if (windowId.startsWith('abbott-')) {
                const portName = windowId.replace('abbott-', '');
                const device = devicesRef.current[portName];
                const deviceName = device?.deviceInfo?.name || portName;
                setFocusedWindow({ id: windowId, type: 'abbott', portName, title: deviceName });
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
                loadPatch(portName, index);
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
                if (config.modules && config.mod_targets) {
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
                updateSynthState(portName, { patchList: patchNames, currentPatchIndex: deviceCurrentIndex });
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

            // Auto-reopen windows if they were previously open
            if (capabilities.includes(CAPABILITIES.CONTROLLER)) {
                const project = deviceInfo?.project;
                if (project === 'Abbott') {
                    // Abbott opens its own sequencer window
                    const abbottWid = `abbott-${portName}`;
                    const abbottState = WorkspacePersistence.getWindowState(abbottWid);
                    if (abbottState?.wasOpen) {
                        setTimeout(() => openAbbottWindow(portName), 0);
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

        // Close all config section windows for this device
        for (const section of ['curves', 'dials', 'pedal', 'screen']) {
            const configWid = `config-${section}-${portName}`;
            if (WindowManager.exists(configWid)) {
                WindowManager.close(configWid);
                delete windowContainersRef.current[configWid];
            }
        }

        // Close Abbott window if open
        const abbottWid = `abbott-${portName}`;
        if (WindowManager.exists(abbottWid)) {
            WindowManager.close(abbottWid);
            delete windowContainersRef.current[abbottWid];
        }

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
            return patch;
        } catch (err) {
            addLog(`Failed to load patch: ${err.message}`, 'error');
            return null;
        }
    };

    const selectPatch = async (portName, index) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        try {
            await api.selectPatch(index);
            await loadPatch(portName, index);
        } catch (err) {
            addLog(`Failed to select patch: ${err.message}`, 'error');
        }
    };

    const createPatch = async (portName) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        const ss = synthStateRef.current[portName] || {};
        try {
            const name = `New Patch ${(ss.patchList || []).length + 1}`;
            await api.createPatch(name);
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [] });
            await selectPatch(portName, patches.patches.length - 1);
        } catch (err) {
            addLog(`Failed to create patch: ${err.message}`, 'error');
        }
    };

    const deletePatch = async (portName, index) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        try {
            await api.deletePatch(index);
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [], currentPatchIndex: -1, currentPatch: null });
        } catch (err) {
            addLog(`Failed to delete patch: ${err.message}`, 'error');
        }
    };

    const renamePatch = async (portName, index, newName) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        try {
            await api.renamePatch(index, newName);
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [] });
        } catch (err) {
            addLog(`Failed to rename patch: ${err.message}`, 'error');
        }
    };

    const movePatch = async (portName, from, to) => {
        const api = deviceApisRef.current[portName];
        if (!api) return;

        try {
            await api.movePatch(from, to);
            const patches = await api.listPatches();
            updateSynthState(portName, { patchList: patches.patches || [], currentPatchIndex: to });
        } catch (err) {
            addLog(`Failed to move patch: ${err.message}`, 'error');
        }
    };

    //------------------------------------------------------------------
    // MODULE OPERATIONS
    //------------------------------------------------------------------

    const toggleModule = async (portName, moduleName, enabled) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return null;

        try {
            const result = await api.toggleModule(ss.currentPatchIndex, moduleName, enabled);
            await loadPatch(portName, ss.currentPatchIndex);
            return result;
        } catch (err) {
            addLog(`Failed to toggle module: ${err.message}`, 'error');
            return null;
        }
    };

    const updateParam = async (portName, paramKey, options) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return;

        try {
            await api.updateParam(ss.currentPatchIndex, paramKey, options);
            await loadPatch(portName, ss.currentPatchIndex);
        } catch (err) {
            addLog(`Failed to update param: ${err.message}`, 'error');
        }
    };

    const toggleModulation = async (portName, targetParam, sourceModule, enabled) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return null;

        try {
            const result = await api.toggleModulation(ss.currentPatchIndex, targetParam, sourceModule, enabled);
            await loadPatch(portName, ss.currentPatchIndex);
            return result;
        } catch (err) {
            addLog(`Failed to toggle modulation: ${err.message}`, 'error');
            return null;
        }
    };

    const updateModulationAmount = async (portName, targetParam, sourceModule, amount) => {
        const api = deviceApisRef.current[portName];
        const ss = synthStateRef.current[portName] || {};
        if (!api || (ss.currentPatchIndex ?? -1) < 0) return;

        const amountParam = `${targetParam}_${sourceModule}_AMOUNT`;
        try {
            await api.updateModulationAmount(ss.currentPatchIndex, amountParam, amount);
            await loadPatch(portName, ss.currentPatchIndex);
        } catch (err) {
            addLog(`Failed to update mod amount: ${err.message}`, 'error');
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
        }
    };

    /**
     * Trigger exchange between a specific synth and controller pair
     * @param {string} controllerPort
     * @param {string} synthPort
     */
    const triggerExchange = async (controllerPort, synthPort) => {
        const controllerDevice = devices[controllerPort];
        const synthDevice = devices[synthPort];
        const synthApi = deviceApisRef.current[synthPort];

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

        addLog(`Triggering exchange: ${synthDevice.deviceInfo?.name || synthPort} → ${controllerDevice.deviceInfo?.name || controllerPort}`, 'info');
        addRoutingLog(`Syncing: ${synthDevice.deviceInfo?.name || synthPort} → ${controllerDevice.deviceInfo?.name || controllerPort}`, 'info');

        const registry = deviceRegistryRef.current;
        if (registry) {
            registry.enableExchangeRelay(synthPort, controllerPort);
        }

        try {
            const controllerInfo = {
                device: controllerDevice.deviceInfo?.name || 'Controller',
                port: controllerPort
            };
            await synthApi.sendControllerAvailable(controllerInfo);
            addLog('Exchange initiated', 'success');
            addRoutingLog('Exchange initiated', 'success');
        } catch (err) {
            addLog(`Exchange failed: ${err.message}`, 'error');
            addRoutingLog(`Exchange failed: ${err.message}`, 'error');
            if (registry) {
                registry.disableExchangeRelay();
            }
        }
    };

    //------------------------------------------------------------------
    // WINDOW CONTAINERS (for re-rendering)
    //------------------------------------------------------------------

    const windowContainersRef = useRef({});

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

                ReactDOM.render(
                    <DeviceAppWindow
                        portName={portName}
                        device={device}
                        topology={ss.topology}
                        patchList={ss.patchList || []}
                        currentPatchIndex={ss.currentPatchIndex ?? -1}
                        currentPatch={ss.currentPatch}
                        onSelectPatch={(idx) => selectPatch(portName, idx)}
                        onCreatePatch={() => createPatch(portName)}
                        onDeletePatch={(idx) => deletePatch(portName, idx)}
                        onRenamePatch={(idx, name) => renamePatch(portName, idx, name)}
                        onMovePatch={(from, to) => movePatch(portName, from, to)}
                        onToggleModule={(mod, en) => toggleModule(portName, mod, en)}
                        onUpdateParam={(key, opts) => updateParam(portName, key, opts)}
                        onToggleModulation={(t, s, en) => toggleModulation(portName, t, s, en)}
                        onUpdateModAmount={(t, s, a) => updateModulationAmount(portName, t, s, a)}
                        addLog={addLog}
                        midiState={midiStateRef.current}
                        controllerConfig={cConfig}
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
        curves:  { width: 500, height: 620, maxHeight: 700, vScroll: true },
        dials:   { width: 1400, height: 220, hScroll: true },
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
        if (!sizes.vScroll) container.style.height = '100%';
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
            hScroll: sizes.hScroll || false,
            vScroll: sizes.vScroll || false,
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
            if (project === 'Abbott') {
                openAbbottWindow(portName);
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

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current[windowId] = container;

        const saved = WorkspacePersistence.getWindowState(windowId);
        const ss = synthState[portName] || {};
        const pairedController = Object.entries(configPairs).find(([_, synth]) => synth === portName)?.[0];
        const cConfig = pairedController ? configByDevice[pairedController] : null;

        WindowManager.create({
            id: windowId,
            title: deviceName,
            x: saved?.x ?? 100,
            y: saved?.y ?? 30,
            width: saved?.width ?? (hasPatch ? 1280 : 500),
            height: saved?.height ?? (hasPatch ? 800 : 450),
            content: container,
            theme: 'synth',
            padding: false,
            resizable: true,
            onClose: () => {
                delete windowContainersRef.current[windowId];
            }
        });

        WorkspacePersistence.setWasOpen(windowId, true);

        ReactDOM.render(
            <DeviceAppWindow
                portName={portName}
                device={device}
                topology={ss.topology}
                patchList={ss.patchList || []}
                currentPatchIndex={ss.currentPatchIndex ?? -1}
                currentPatch={ss.currentPatch}
                onSelectPatch={(idx) => selectPatch(portName, idx)}
                onCreatePatch={() => createPatch(portName)}
                onDeletePatch={(idx) => deletePatch(portName, idx)}
                onRenamePatch={(idx, name) => renamePatch(portName, idx, name)}
                onMovePatch={(from, to) => movePatch(portName, from, to)}
                onToggleModule={(mod, en) => toggleModule(portName, mod, en)}
                onUpdateParam={(key, opts) => updateParam(portName, key, opts)}
                onToggleModulation={(t, s, en) => toggleModulation(portName, t, s, en)}
                onUpdateModAmount={(t, s, a) => updateModulationAmount(portName, t, s, a)}
                addLog={addLog}
                midiState={midiStateRef.current}
                controllerConfig={cConfig}
            />,
            container
        );

        // Load initial patch if needed
        if (hasPatch && ss.currentPatch == null && (ss.patchList || []).length > 0) {
            const initialIndex = (ss.currentPatchIndex ?? -1) >= 0 ? ss.currentPatchIndex : 0;
            loadPatch(portName, initialIndex);
        }
    };

    const openAbbottWindow = (portName) => {
        const windowId = `abbott-${portName}`;
        if (WindowManager.exists(windowId)) {
            WindowManager.focus(windowId);
            return;
        }

        const device = devices[portName];
        if (!device) return;
        const deviceName = device.deviceInfo?.name || 'Abbott';
        const abbottDevice = virtualDevicesRef.current[portName];
        if (!abbottDevice) {
            addLog(`Abbott device instance not found for ${portName}`, 'error');
            return;
        }

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current[windowId] = container;

        const saved = WorkspacePersistence.getWindowState(windowId);

        WindowManager.create({
            id: windowId,
            title: deviceName,
            x: saved?.x ?? 80,
            y: saved?.y ?? 30,
            width: saved?.width ?? 700,
            height: saved?.height ?? 600,
            content: container,
            theme: 'controller',
            hScroll: true,
            vScroll: true,
            padding: false,
            onClose: () => {
                delete windowContainersRef.current[windowId];
            }
        });

        WorkspacePersistence.setWasOpen(windowId, true);

        ReactDOM.render(
            <AbbottWindow device={abbottDevice} />,
            container
        );
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

        // Info bar left: view selector dropdown
        const viewSelect = document.createElement('select');
        viewSelect.className = 'ap-infobar-select';
        const optLog = document.createElement('option');
        optLog.value = 'log'; optLog.textContent = 'Log';
        const optTopo = document.createElement('option');
        optTopo.value = 'topo'; optTopo.textContent = 'Topology';
        viewSelect.appendChild(optLog);
        viewSelect.appendChild(optTopo);
        viewSelect.value = logActiveView;
        viewSelect.addEventListener('change', () => setLogActiveView(viewSelect.value));

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
            vScroll: true,
            padding: false,
            infoBar: { left: viewSelect, right: rightContainer },
            onClose: () => {
                delete windowContainersRef.current['log-window'];
                logCountRef.current = null;
                logClearRef.current = null;
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
        container.style.height = '100%';
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
        container.style.height = '100%';
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
        container.style.height = '100%';
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
    // RENDER
    //------------------------------------------------------------------

    return (
        <div className="ap-container">
            <MenuBar
                focusedWindow={focusedWindow}
                onOpenConfigWindow={(section) => {
                    const portName = focusedWindow.portName;
                    if (portName) openConfigWindow(portName, section);
                }}
                onLogClick={() => openLogWindow()}
                onSyncClick={() => openRoutingWindow()}
                onExpressionPadClick={() => openExpressionPad()}
                onPreferencesClick={() => openPreferencesWindow()}
                onOpenDeviceTool={openDeviceToolWindow}
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

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, PAD_SIZE, PAD_SIZE);

        ctx.strokeStyle = '#c0c0c0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(CENTER, 0);
        ctx.lineTo(CENTER, PAD_SIZE);
        ctx.moveTo(0, CENTER);
        ctx.lineTo(PAD_SIZE, CENTER);
        ctx.stroke();

        ctx.strokeStyle = '#808080';
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
// ROUTING WINDOW
//======================================================================

function RoutingWindow({ devices, routes, configPairs, onAddRoute, onRemoveRoute, onSetConfigPair, routingLogs }) {
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [routingLogs]);

    const connectedDevices = Object.entries(devices).filter(([_, d]) => d.status === 'connected');
    const controllers = connectedDevices.filter(([_, d]) => d.capabilities?.includes('CONTROLLER'));
    const synths = connectedDevices.filter(([_, d]) => d.capabilities?.includes('SYNTH'));

    const getName = (portName) => devices[portName]?.deviceInfo?.name || portName;

    if (controllers.length === 0 && synths.length === 0) {
        return (
            <div className="ap-routing-window">
                <div className="ap-routing-empty">No devices connected</div>
                <div className="ap-routing-log" ref={scrollRef}>
                    {routingLogs.length === 0 ? (
                        <span className="ap-text-muted">Routing log</span>
                    ) : routingLogs.map((log, i) => (
                        <div key={i} className={`ap-routing-log-entry ap-routing-log-${log.type}`}>
                            <span className="ap-routing-log-time">[{log.timestamp}]</span>
                            {' '}<span>{log.message}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="ap-routing-window">
            {/* Matrix: controllers as rows, synths as columns */}
            <div className="ap-routing-matrix">
                {/* Header row */}
                <div className="ap-routing-header-row">
                    <div className="ap-routing-corner"></div>
                    {synths.map(([port]) => (
                        <div key={port} className="ap-routing-col-header">{getName(port)}</div>
                    ))}
                    {synths.length > 0 && <div className="ap-routing-col-header ap-routing-config-header">Config</div>}
                </div>

                {/* Controller rows */}
                {controllers.map(([ctrlPort]) => {
                    const wiredSynths = routes.filter(r => r.from === ctrlPort).map(r => r.to);
                    const currentPair = configPairs[ctrlPort] || null;

                    return (
                        <div key={ctrlPort} className="ap-routing-row">
                            <div className="ap-routing-row-label">{getName(ctrlPort)}</div>
                            {synths.map(([synthPort]) => {
                                const isWired = wiredSynths.includes(synthPort);
                                return (
                                    <div key={synthPort} className="ap-routing-cell">
                                        <button
                                            className={`ap-routing-toggle ${isWired ? 'on' : ''}`}
                                            onClick={() => isWired ? onRemoveRoute(ctrlPort, synthPort) : onAddRoute(ctrlPort, synthPort)}
                                            title={isWired ? 'Remove MIDI route' : 'Add MIDI route'}
                                        >
                                            {isWired ? '\u25CF' : '\u25CB'}
                                        </button>
                                    </div>
                                );
                            })}
                            {synths.length > 0 && (
                                <div className="ap-routing-cell ap-routing-config-cell">
                                    <select
                                        className="ap-routing-config-select"
                                        value={currentPair || ''}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            if (val) onSetConfigPair(ctrlPort, val);
                                        }}
                                    >
                                        <option value="">—</option>
                                        {wiredSynths.map(sp => (
                                            <option key={sp} value={sp}>{getName(sp)}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Routing log */}
            <div className="ap-routing-log" ref={scrollRef}>
                {routingLogs.length === 0 ? (
                    <span className="ap-text-muted">Routing log</span>
                ) : routingLogs.map((log, i) => (
                    <div key={i} className={`ap-routing-log-entry ap-routing-log-${log.type}`}>
                        <span className="ap-routing-log-time">[{log.timestamp}]</span>
                        {' '}<span>{log.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

//======================================================================
// LOG WINDOW
//======================================================================

function LogWindow({ logs, topology, activeView }) {
    const logText = logs.map(log => {
        const typeTag = log.type === 'info' ? '' : `[${log.type.toUpperCase()}] `;
        return `[${log.timestamp}] ${typeTag}${log.message}`;
    }).join('\n');

    const topoText = topology
        ? JSON.stringify(topology, null, 2)
        : 'No topology loaded (connect a synth device)';

    return (
        <pre className="ap-log-text">
            {activeView === 'log'
                ? (logs.length === 0 ? 'No log entries' : logText)
                : topoText}
        </pre>
    );
}

//======================================================================
// MOUNT
//======================================================================

ReactDOM.render(<App />, document.getElementById('root'));
