/**
 * Attach Part Console - Main Application (New UI)
 *
 * Architecture:
 * - Device Sidebar (left rail): shows devices + tools
 * - Workspace (main area): where windows open
 * - Status Bar (bottom): connection status
 *
 * Backend layer (unchanged):
 * - CandideAPI, BartlebyAPI
 * - DeviceRegistry
 * - Transport layers
 */

const { useState, useEffect, useCallback, useRef, useMemo } = React;

//======================================================================
// MAIN APP COMPONENT
//======================================================================

function App() {
    // Device connection state
    const [deviceStates, setDeviceStates] = useState({
        bartleby: { connected: false, name: null },
        candide: { connected: false, name: null }
    });

    // API instances
    const candideApiRef = useRef(null);
    const bartlebyApiRef = useRef(null);
    const deviceRegistryRef = useRef(null);

    // Candide state
    const [candideStatus, setCandideStatus] = useState('disconnected');
    const [candideDeviceInfo, setCandideDeviceInfo] = useState(null);
    const [canideSaveStatus, setCanideSaveStatus] = useState('saved');
    const [patchList, setPatchList] = useState([]);
    const [currentPatchIndex, setCurrentPatchIndex] = useState(-1);
    const [currentPatch, setCurrentPatch] = useState(null);

    // Bartleby state
    const [bartlebyConfig, setBartlebyConfig] = useState(null);
    const [bartlebySaveStatus, setBartlebySaveStatus] = useState('saved');
    const [bartlebyDeviceInfo, setBartlebyDeviceInfo] = useState(null);

    // Logs
    const [logs, setLogs] = useState([]);

    const addLog = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${type}] ${message}`);  // Also log to console for debugging
        setLogs(prev => [...prev.slice(-99), { message, type, timestamp }]);
    }, []);

    //------------------------------------------------------------------
    // DEVICE REGISTRY SETUP
    //------------------------------------------------------------------

    // Update device states from registry
    const updateDeviceStates = useCallback(() => {
        const registry = deviceRegistryRef.current;
        if (!registry) return;

        const bartlebyStatus = registry.getDeviceStatus('bartleby');
        const candideStatus = registry.getDeviceStatus('candide');

        setDeviceStates({
            bartleby: bartlebyStatus,
            candide: candideStatus
        });
    }, []);

    useEffect(() => {
        const registry = new DeviceRegistry();
        deviceRegistryRef.current = registry;

        registry.onDeviceChange(() => {
            updateDeviceStates();
        });

        registry.onBartlebyConnected(() => {
            addLog('Bartleby connected', 'success');
            updateDeviceStates();
            initBartleby();
        });

        registry.onBartlebyDisconnected(() => {
            addLog('Bartleby disconnected', 'warning');
            cleanupBartleby();
            updateDeviceStates();
        });

        registry.onCandideConnected(() => {
            addLog('Candide connected', 'success');
            updateDeviceStates();
            initCandide();
        });

        registry.onCandideDisconnected(() => {
            addLog('Candide disconnected', 'warning');
            cleanupCandide();
            updateDeviceStates();
        });

        registry.init().then(() => {
            addLog('Device registry initialized', 'info');

            // Check device status after init
            const bartStatus = registry.getDeviceStatus('bartleby');
            const candiStatus = registry.getDeviceStatus('candide');
            addLog(`Devices: Bart=${bartStatus.connected}, Candi=${candiStatus.connected}`, 'info');

            setDeviceStates({
                bartleby: bartStatus,
                candide: candiStatus
            });

            // Initialize connected devices
            if (candiStatus.connected) {
                initCandide();
            }
            if (bartStatus.connected) {
                initBartleby();
            }
        }).catch(err => {
            console.error('Registry init failed:', err);
            addLog(`Registry init failed: ${err.message}`, 'error');
        });

        return () => {
            // Cleanup on unmount
        };
    }, []);

    //------------------------------------------------------------------
    // CANDIDE INITIALIZATION
    //------------------------------------------------------------------

    const initCandide = async () => {
        // Already initialized - prevent duplicate init
        if (candideApiRef.current !== null) {
            return;
        }

        const registry = deviceRegistryRef.current;
        if (!registry) return;

        const input = registry.getCandideInput();
        const output = registry.getCandideOutput();
        if (!input || !output) return;

        setCandideStatus('connecting');
        addLog('Connecting to Candide...', 'info');

        try {
            const api = new CandideAPI();
            candideApiRef.current = api;

            api.onSaveStatusChanged((status) => {
                setCanideSaveStatus(status);
            });

            api.onExternalPatchChange((index) => {
                addLog(`External patch change to ${index}`, 'info');
                loadPatch(index);
            });

            await api.connectToDevice({ input, output });
            await api.init();

            const info = await api.getDeviceInfo();
            setCandideDeviceInfo(info);

            const patches = await api.listPatches();
            console.log('Patches response:', patches);
            const patchNames = patches.patches || [];
            addLog(`Loaded ${patchNames.length} patches`, 'info');
            setPatchList(patchNames);

            setCandideStatus('connected');
            addLog('Candide connected and initialized', 'success');
        } catch (err) {
            addLog(`Candide connection failed: ${err.message}`, 'error');
            setCandideStatus('error');
        }
    };

    const cleanupCandide = () => {
        candideApiRef.current = null;
        setCandideStatus('disconnected');
        setCandideDeviceInfo(null);
        setPatchList([]);
        setCurrentPatchIndex(-1);
        setCurrentPatch(null);
    };

    //------------------------------------------------------------------
    // BARTLEBY INITIALIZATION
    //------------------------------------------------------------------

    const initBartleby = async () => {
        // Already initialized - prevent duplicate init
        if (bartlebyApiRef.current !== null) {
            return;
        }

        const registry = deviceRegistryRef.current;
        if (!registry) return;

        const input = registry.getBartlebyInput();
        const output = registry.getBartlebyOutput();
        if (!input || !output) return;

        addLog('Initializing Bartleby...', 'info');

        try {
            const api = new BartlebyAPI();
            bartlebyApiRef.current = api;

            // Let registry route SysEx to Bartleby
            registry.setBartlebyApi(api);

            api.onSaveStatusChanged((status) => {
                setBartlebySaveStatus(status);
            });

            await api.connectToDevice(input, output);
            const result = await api.init();

            if (result.config) {
                setBartlebyConfig(result.config);
            }

            const info = await api.getDeviceInfo();
            setBartlebyDeviceInfo(info);

            addLog('Bartleby initialized', 'success');
        } catch (err) {
            addLog(`Bartleby init failed: ${err.message}`, 'error');
        }
    };

    const cleanupBartleby = () => {
        const registry = deviceRegistryRef.current;
        if (registry) {
            registry.setBartlebyApi(null);
        }
        bartlebyApiRef.current = null;
        setBartlebyConfig(null);
        setBartlebyDeviceInfo(null);
        setBartlebySaveStatus('saved');
    };

    //------------------------------------------------------------------
    // PATCH OPERATIONS
    //------------------------------------------------------------------

    const loadPatch = async (index) => {
        const api = candideApiRef.current;
        if (!api || index < 0) return null;

        try {
            const patch = await api.getPatch(index);
            setCurrentPatch(patch);
            setCurrentPatchIndex(index);
            return patch;  // Return for immediate use by window openers
        } catch (err) {
            addLog(`Failed to load patch: ${err.message}`, 'error');
            return null;
        }
    };

    const selectPatch = async (index) => {
        const api = candideApiRef.current;
        if (!api) return;

        try {
            await api.selectPatch(index);
            await loadPatch(index);
        } catch (err) {
            addLog(`Failed to select patch: ${err.message}`, 'error');
        }
    };

    const createPatch = async () => {
        const api = candideApiRef.current;
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
        const api = candideApiRef.current;
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
        const api = candideApiRef.current;
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
        const api = candideApiRef.current;
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
        addLog(`toggleModule: ${moduleName} → ${enabled}`, 'info');
        const api = candideApiRef.current;
        if (!api) {
            addLog(`toggleModule failed: no API connection`, 'error');
            return;
        }
        if (currentPatchIndex < 0) {
            addLog(`toggleModule failed: no patch selected (index=${currentPatchIndex})`, 'error');
            return;
        }

        try {
            await api.toggleModule(currentPatchIndex, moduleName, enabled);
            addLog(`toggleModule success: ${moduleName}`, 'success');
            await loadPatch(currentPatchIndex);
        } catch (err) {
            addLog(`Failed to toggle module: ${err.message}`, 'error');
        }
    };

    const updateParam = async (paramKey, value) => {
        addLog(`updateParam: ${paramKey} → ${value}`, 'info');
        const api = candideApiRef.current;
        if (!api) {
            addLog(`updateParam failed: no API connection`, 'error');
            return;
        }
        if (currentPatchIndex < 0) {
            addLog(`updateParam failed: no patch selected (index=${currentPatchIndex})`, 'error');
            return;
        }

        try {
            await api.updateParam(currentPatchIndex, paramKey, value);
            addLog(`updateParam success: ${paramKey}`, 'success');
            await loadPatch(currentPatchIndex);
        } catch (err) {
            addLog(`Failed to update param: ${err.message}`, 'error');
        }
    };

    const toggleModulation = async (targetParam, sourceModule, enabled) => {
        addLog(`toggleModulation: ${sourceModule} → ${targetParam} = ${enabled}`, 'info');
        const api = candideApiRef.current;
        if (!api) {
            addLog(`toggleModulation failed: no API connection`, 'error');
            return;
        }
        if (currentPatchIndex < 0) {
            addLog(`toggleModulation failed: no patch selected (index=${currentPatchIndex})`, 'error');
            return;
        }

        try {
            await api.toggleModulation(currentPatchIndex, targetParam, sourceModule, enabled);
            addLog(`toggleModulation success`, 'success');
            await loadPatch(currentPatchIndex);
        } catch (err) {
            addLog(`Failed to toggle modulation: ${err.message}`, 'error');
        }
    };

    const updateModulationAmount = async (targetParam, sourceModule, amount) => {
        const amountParam = `${targetParam}_${sourceModule}_AMOUNT`;
        addLog(`updateModulationAmount: ${amountParam} → ${amount}`, 'info');
        const api = candideApiRef.current;
        if (!api) {
            addLog(`updateModulationAmount failed: no API connection`, 'error');
            return;
        }
        if (currentPatchIndex < 0) {
            addLog(`updateModulationAmount failed: no patch selected (index=${currentPatchIndex})`, 'error');
            return;
        }

        try {
            await api.updateModulationAmount(currentPatchIndex, amountParam, amount);
            addLog(`updateModulationAmount success`, 'success');
            await loadPatch(currentPatchIndex);
        } catch (err) {
            addLog(`Failed to update mod amount: ${err.message}`, 'error');
        }
    };

    //------------------------------------------------------------------
    // BARTLEBY CONFIG OPERATIONS
    //------------------------------------------------------------------

    const updateBartlebyConfig = async (partialConfig) => {
        const api = bartlebyApiRef.current;
        if (!api) return;

        try {
            const result = await api.setConfig(partialConfig);
            if (result.config) {
                setBartlebyConfig(result.config);
            }
        } catch (err) {
            addLog(`Failed to update Bartleby config: ${err.message}`, 'error');
        }
    };

    const saveBartleby = async () => {
        const api = bartlebyApiRef.current;
        if (!api) return;

        try {
            await api.save();
        } catch (err) {
            addLog(`Failed to save Bartleby config: ${err.message}`, 'error');
        }
    };

    //------------------------------------------------------------------
    // DEVICE ACTION HANDLERS
    //------------------------------------------------------------------

    const handleDeviceAction = (device, action) => {
        addLog(`Action: ${device} → ${action}`, 'info');

        if (device === 'bartleby') {
            if (action === 'config') {
                openBartlebyConfig();
            } else if (action === 'firmware') {
                openFirmwareWindow('bartleby');
            } else if (action === 'language') {
                openLanguageWindow('bartleby');
            }
        } else if (device === 'candide') {
            if (action === 'patches') {
                openPatchEditor();
            } else if (action === 'firmware') {
                openFirmwareWindow('candide');
            } else if (action === 'language') {
                openLanguageWindow('candide');
            }
        }
    };

    const handleToolClick = (tool) => {
        addLog(`Tool: ${tool}`, 'info');

        if (tool === 'expression') {
            openExpressionPad();
        } else if (tool === 'log') {
            openLogWindow();
        }
    };

    //------------------------------------------------------------------
    // WINDOW CONTAINERS (for re-rendering)
    //------------------------------------------------------------------

    const windowContainersRef = useRef({});

    // Re-render Bartleby config window when state changes
    useEffect(() => {
        const container = windowContainersRef.current['bartleby-config'];
        if (container && WindowManager.exists('bartleby-config')) {
            ReactDOM.render(
                <BartlebyConfigWindow
                    config={bartlebyConfig}
                    saveStatus={bartlebySaveStatus}
                    deviceInfo={bartlebyDeviceInfo}
                    onConfigChange={updateBartlebyConfig}
                    onSave={saveBartleby}
                />,
                container
            );
        }
    }, [bartlebyConfig, bartlebySaveStatus, bartlebyDeviceInfo]);

    // Re-render Patch editor window when state changes
    useEffect(() => {
        const container = windowContainersRef.current['patch-editor'];
        if (container && WindowManager.exists('patch-editor')) {
            ReactDOM.render(
                <PatchEditorWindow
                    patchList={patchList}
                    currentIndex={currentPatchIndex}
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
                    isConnected={candideStatus === 'connected'}
                    addLog={addLog}
                />,
                container
            );
        }
    }, [patchList, currentPatchIndex, currentPatch, candideStatus, addLog]);

    // Re-render Log window when logs change
    useEffect(() => {
        const container = windowContainersRef.current['log-window'];
        if (container && WindowManager.exists('log-window')) {
            ReactDOM.render(
                <LogWindow logs={logs} onClear={() => setLogs([])} />,
                container
            );
        }
    }, [logs]);

    // Re-render Expression Pad when connection or API changes
    useEffect(() => {
        const container = windowContainersRef.current['expression-pad'];
        if (container && WindowManager.exists('expression-pad')) {
            ReactDOM.render(
                <ExpressionPadWindow
                    candideApi={candideApiRef.current}
                    isConnected={candideStatus === 'connected'}
                    deviceRegistry={deviceRegistryRef.current}
                    addLog={addLog}
                />,
                container
            );
        }
    }, [candideStatus, addLog]);

    //------------------------------------------------------------------
    // WINDOW OPENERS
    //------------------------------------------------------------------

    const openBartlebyConfig = async () => {
        if (WindowManager.exists('bartleby-config')) {
            WindowManager.focus('bartleby-config');
            return;
        }

        // STANDARDIZED PATTERN: Ensure data is ready before creating window
        let initialConfig = bartlebyConfig;

        if (initialConfig === null && bartlebyApiRef.current) {
            // Config not loaded yet - fetch it
            addLog('Loading Bartleby config...', 'info');
            try {
                const result = await bartlebyApiRef.current.getConfig();
                if (result.config) {
                    initialConfig = result.config;
                    setBartlebyConfig(result.config);
                }
            } catch (err) {
                addLog(`Failed to load config: ${err.message}`, 'error');
            }
        }

        const container = document.createElement('div');
        windowContainersRef.current['bartleby-config'] = container;

        WindowManager.create({
            id: 'bartleby-config',
            title: 'Bartleby Config',
            x: 100,
            y: 50,
            width: 450,
            height: 400,
            content: container,
            onClose: () => {
                delete windowContainersRef.current['bartleby-config'];
            }
        });

        // Render with loaded data (not stale closure values)
        ReactDOM.render(
            <BartlebyConfigWindow
                config={initialConfig}
                saveStatus={bartlebySaveStatus}
                deviceInfo={bartlebyDeviceInfo}
                onConfigChange={updateBartlebyConfig}
                onSave={saveBartleby}
            />,
            container
        );
    };

    const openPatchEditor = async () => {
        if (WindowManager.exists('patch-editor')) {
            WindowManager.focus('patch-editor');
            return;
        }

        // STANDARDIZED PATTERN: Ensure data is ready before creating window
        // This guarantees the window has valid data on first render
        let initialPatch = currentPatch;
        let initialIndex = currentPatchIndex;

        if (initialPatch === null && patchList.length > 0) {
            // No patch loaded yet - load the first one
            const firstIndex = typeof patchList[0] === 'object' ? patchList[0].index : 0;
            addLog(`Loading patch ${firstIndex}...`, 'info');
            initialPatch = await loadPatch(firstIndex);
            initialIndex = firstIndex;
        }

        const container = document.createElement('div');
        container.style.height = '100%';
        windowContainersRef.current['patch-editor'] = container;

        WindowManager.create({
            id: 'patch-editor',
            title: 'Candide Patches',
            x: 120,
            y: 70,
            width: 1280,
            height: 800,
            content: container,
            onClose: () => {
                delete windowContainersRef.current['patch-editor'];
            }
        });

        // Render with loaded data (not stale closure values)
        ReactDOM.render(
            <PatchEditorWindow
                patchList={patchList}
                currentIndex={initialIndex}
                currentPatch={initialPatch}
                onSelectPatch={selectPatch}
                onCreatePatch={createPatch}
                onDeletePatch={deletePatch}
                onRenamePatch={renamePatch}
                onMovePatch={movePatch}
                onToggleModule={toggleModule}
                onUpdateParam={updateParam}
                onToggleModulation={toggleModulation}
                onUpdateModAmount={updateModulationAmount}
                isConnected={candideStatus === 'connected'}
                addLog={addLog}
            />,
            container
        );
    };

    const openFirmwareWindow = (device) => {
        const id = `firmware-${device}`;
        if (WindowManager.exists(id)) {
            WindowManager.focus(id);
            return;
        }

        const container = document.createElement('div');
        WindowManager.create({
            id,
            title: `${device} Firmware`,
            x: 200,
            y: 100,
            width: 350,
            height: 300,
            content: container,
            onClose: () => {}
        });

        ReactDOM.render(
            <FirmwareWindow
                device={device}
                deviceInfo={device === 'bartleby' ? bartlebyDeviceInfo : candideDeviceInfo}
                api={device === 'bartleby' ? bartlebyApiRef.current : candideApiRef.current}
                onClose={() => WindowManager.close(id)}
                addLog={addLog}
            />,
            container
        );
    };

    const openLanguageWindow = (device) => {
        const id = `language-${device}`;
        if (WindowManager.exists(id)) {
            WindowManager.focus(id);
            return;
        }

        const container = document.createElement('div');
        WindowManager.create({
            id,
            title: `${device} Language`,
            x: 250,
            y: 150,
            width: 300,
            height: 250,
            content: container,
            onClose: () => {}
        });

        ReactDOM.render(
            <LanguageWindow
                device={device}
                api={device === 'bartleby' ? bartlebyApiRef.current : candideApiRef.current}
                deviceInfo={device === 'bartleby' ? bartlebyDeviceInfo : candideDeviceInfo}
                onClose={() => WindowManager.close(id)}
                addLog={addLog}
            />,
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

        WindowManager.create({
            id: 'expression-pad',
            title: 'Expression Pad',
            x: 150,
            y: 80,
            width: 320,
            height: 420,
            content: container,
            onClose: () => {
                delete windowContainersRef.current['expression-pad'];
            }
        });

        ReactDOM.render(
            <ExpressionPadWindow
                candideApi={candideApiRef.current}
                isConnected={candideStatus === 'connected'}
                deviceRegistry={deviceRegistryRef.current}
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

        WindowManager.create({
            id: 'log-window',
            title: 'Console Log',
            x: 400,
            y: 100,
            width: 450,
            height: 350,
            content: container,
            onClose: () => {
                delete windowContainersRef.current['log-window'];
            }
        });

        ReactDOM.render(
            <LogWindow logs={logs} onClear={() => setLogs([])} />,
            container
        );
    };

    //------------------------------------------------------------------
    // RENDER
    //------------------------------------------------------------------

    const isLinked = deviceStates.bartleby.connected && deviceStates.candide.connected;

    return (
        <div className="ap-container">
            <DeviceSidebar
                deviceStates={deviceStates}
                onDeviceAction={handleDeviceAction}
                onToolClick={handleToolClick}
            />

            <div id="workspace">
                {/* Windows are rendered here by WindowManager */}
            </div>

            <StatusBar
                bartlebyConnected={deviceStates.bartleby.connected}
                candideConnected={deviceStates.candide.connected}
                isLinked={isLinked}
            />
        </div>
    );
}

//======================================================================
// STATUS BAR
//======================================================================

function StatusBar({ bartlebyConnected, candideConnected, isLinked }) {
    return (
        <div className="ap-status-bar">
            <div className="ap-status-item">
                <span className={`ap-status-led ${bartlebyConnected ? 'connected' : ''}`}></span>
                <span>BARTLEBY</span>
            </div>
            <div className="ap-status-item">
                <span className={`ap-status-led ${candideConnected ? 'connected' : ''}`}></span>
                <span>CANDIDE</span>
            </div>
            {isLinked && (
                <span className="ap-status-linked">LINKED</span>
            )}
        </div>
    );
}

//======================================================================
// FIRMWARE WINDOW
//======================================================================

// BartlebyConfigWindow is now in bartleby-config-window.js
// PatchEditorWindow is now in patch-editor.js

function FirmwareWindow({ device, deviceInfo, api, onClose, addLog }) {
    const [step, setStep] = useState('select'); // select, uploading, complete, error
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
            // Read file as ArrayBuffer
            const arrayBuffer = await selectedFile.arrayBuffer();
            const firmwareBin = new Uint8Array(arrayBuffer);

            addLog(`Starting firmware upload: ${firmwareBin.length} bytes`, 'info');

            // Upload with progress callback
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

    return (
        <div className="ap-firmware-window">
            <div className="ap-firmware-device">
                <span className="ap-firmware-device-name">
                    {device === 'bartleby' ? 'BARTLEBY' : 'CANDIDE'}
                </span>
                {deviceInfo && (
                    <span className="ap-firmware-version">
                        v{deviceInfo.version}
                    </span>
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

    // Get current language from device info (if available)
    const currentLang = deviceInfo?.language || 'en';

    useEffect(() => {
        setSelectedLang(currentLang);
    }, [currentLang]);

    const handleApply = async () => {
        if (!api || selectedLang === currentLang) return;

        setApplying(true);
        addLog(`Setting language to ${selectedLang}...`, 'info');

        try {
            // Note: Language API not yet implemented
            // When available: await api.setLanguage(selectedLang);
            addLog('Language API not yet implemented', 'warning');

            // For now, just close
            setTimeout(() => {
                setApplying(false);
                onClose();
            }, 1000);
        } catch (err) {
            addLog(`Language change failed: ${err.message}`, 'error');
            setApplying(false);
        }
    };

    return (
        <div className="ap-language-window">
            <div className="ap-language-device">
                <span className="ap-language-device-name">
                    {device === 'bartleby' ? 'BARTLEBY' : 'CANDIDE'}
                </span>
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
    60, 64, 67, 72,  // C major arpeggio up
    71, 67, 64, 60,  // Down with leading tone
    62, 65, 69, 74,  // D minor arpeggio up
    72, 69, 65, 62,  // Down
];

// Color palette for polyphonic note display
const NOTE_COLORS = [
    '#ffb000',  // amber
    '#00ff88',  // green
    '#ff4488',  // pink
    '#44aaff',  // blue
    '#ff8844',  // orange
    '#aa44ff',  // purple
];

function ExpressionPadWindow({ candideApi, isConnected, deviceRegistry, addLog }) {
    const canvasRef = useRef(null);
    const [velocity, setVelocity] = useState(0.8);
    const [activeNotes, setActiveNotes] = useState(new Map());
    const [hideCursor, setHideCursor] = useState(false);
    const colorIndexRef = useRef(0);
    const melodyIndexRef = useRef(0);
    const playingRef = useRef(false);

    // MPE mode
    const [mpeEnabled, setMpeEnabled] = useState(true);
    const mpeAllocatorRef = useRef(new MpeChannelAllocator());
    const currentChannelRef = useRef(0);
    const mouseNoteRef = useRef(null);
    const mpeSentRef = useRef(false);

    // Throttling
    const lastSendTimeRef = useRef(0);
    const lastBendRef = useRef(0);
    const lastPressureRef = useRef(0.5);
    const THROTTLE_INTERVAL_MS = 50;
    const CHANGE_THRESHOLD = 0.02;

    // Canvas dimensions
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

        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, PAD_SIZE, PAD_SIZE);

        // Crosshairs
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(CENTER, 0);
        ctx.lineTo(CENTER, PAD_SIZE);
        ctx.moveTo(0, CENTER);
        ctx.lineTo(PAD_SIZE, CENTER);
        ctx.stroke();

        // Neutral circle
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(CENTER, CENTER, NEUTRAL_RADIUS, 0, Math.PI * 2);
        ctx.stroke();

        // Draw active notes
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

    // Initialize canvas
    useEffect(() => {
        drawPad();
    }, [drawPad]);

    // Redraw when notes change
    useEffect(() => {
        drawPad(Array.from(activeNotes.values()));
    }, [activeNotes, drawPad]);

    // Send MPE config when connected
    useEffect(() => {
        if (isConnected && candideApi?.midiOutput && mpeEnabled && !mpeSentRef.current) {
            const msg = new Uint8Array([0xB0, 0x7F, 15]);
            candideApi.midiOutput.send(msg);
            addLog('TX: MPE Config [B0 7F 0F] - 15 member channels');
            mpeSentRef.current = true;
        }
        if (!isConnected) {
            mpeSentRef.current = false;
        }
    }, [isConnected, candideApi, mpeEnabled, addLog]);

    // Subscribe to incoming MIDI from Bartleby
    useEffect(() => {
        if (!deviceRegistry) return;

        const handleIncomingMidi = (data) => {
            const status = data[0] & 0xF0;
            const channel = data[0] & 0x0F;

            if (status === 0x90 && data[2] > 0) {
                setActiveNotes(prev => {
                    const next = new Map(prev);
                    const colorIndex = colorIndexRef.current++;
                    next.set(channel, { note: data[1], bend: 0, pressure: 0.5, colorIndex });
                    return next;
                });
            } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
                setActiveNotes(prev => {
                    const next = new Map(prev);
                    next.delete(channel);
                    return next;
                });
            } else if (status === 0xE0) {
                const raw = data[1] | (data[2] << 7);
                const bend = (raw - 8192) / 8192;
                setActiveNotes(prev => {
                    const existing = prev.get(channel);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(channel, { ...existing, bend });
                    return next;
                });
            } else if (status === 0xD0) {
                const pressure = data[1] / 127;
                setActiveNotes(prev => {
                    const existing = prev.get(channel);
                    if (!existing) return prev;
                    const next = new Map(prev);
                    next.set(channel, { ...existing, pressure });
                    return next;
                });
            }
        };

        deviceRegistry.onMidiThrough(handleIncomingMidi);
        return () => deviceRegistry.onMidiThrough(null);
    }, [deviceRegistry]);

    const handleMouseDown = useCallback((e) => {
        if (!isConnected || !candideApi) return;

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

        candideApi.sendPitchBend(channel, bend);
        candideApi.sendChannelPressure(channel, pressure);
        candideApi.sendNoteOn(channel, note, velocity);

        const vel7 = Math.round(velocity * 127);
        const mpeInfo = mpeEnabled ? ` [MPE ch${channel}]` : '';
        addLog(`TX: Note On note=${note} vel=${vel7}${mpeInfo}`);
    }, [isConnected, candideApi, velocity, positionToValues, getNextNote, mpeEnabled, addLog]);

    const handleMouseMove = useCallback((e) => {
        if (!playingRef.current || !candideApi) return;

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
            candideApi.sendPitchBend(channel, bend);
            candideApi.sendChannelPressure(channel, pressure);
            lastSendTimeRef.current = now;
            lastBendRef.current = bend;
            lastPressureRef.current = pressure;
        }
    }, [candideApi, positionToValues]);

    const handleMouseUp = useCallback(() => {
        if (!playingRef.current || !candideApi) return;

        const channel = currentChannelRef.current;
        const note = mouseNoteRef.current;

        candideApi.sendNoteOff(channel, note, 0);

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
    }, [candideApi, mpeEnabled, addLog]);

    // Global mouseup listener
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

    return (
        <div className="ap-expression-pad">
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
                            if (candideApi?.midiOutput) {
                                const value = enabled ? 15 : 0;
                                const msg = new Uint8Array([0xB0, 0x7F, value]);
                                candideApi.midiOutput.send(msg);
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
        </div>
    );
}

//======================================================================
// LOG WINDOW
//======================================================================

function LogWindow({ logs, onClear }) {
    const scrollRef = useRef(null);

    // Auto-scroll to bottom when new logs arrive
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    const getLogClass = (type) => {
        switch (type) {
            case 'success': return 'ap-log-success';
            case 'error': return 'ap-log-error';
            case 'warning': return 'ap-log-warning';
            default: return 'ap-log-info';
        }
    };

    return (
        <div className="ap-log-window">
            <div className="ap-log-toolbar">
                <span className="ap-log-count">{logs.length} entries</span>
                <button className="ap-btn ap-btn-small" onClick={onClear}>
                    CLEAR
                </button>
            </div>
            <div className="ap-log-scroll" ref={scrollRef}>
                {logs.length === 0 ? (
                    <div className="ap-log-empty">No log entries</div>
                ) : (
                    logs.map((log, i) => (
                        <div key={i} className={`ap-log-entry ${getLogClass(log.type)}`}>
                            <span className="ap-log-time">{log.time}</span>
                            <span className="ap-log-message">{log.message}</span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

//======================================================================
// MOUNT
//======================================================================

ReactDOM.render(<App />, document.getElementById('root'));
