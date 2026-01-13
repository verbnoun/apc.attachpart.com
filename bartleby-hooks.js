/**
 * Bartleby React Hooks - State Management Layer
 *
 * PURE LOGIC - No display/UI code
 *
 * Patterns:
 *   - Hooks return { state, operations }
 *   - Device is authority (thin client)
 *   - Busy/lock pattern prevents concurrent operations
 *   - Connection managed by DeviceRegistry, not these hooks
 */

const { useState, useCallback, useEffect, useRef } = React;

//======================================================================
// useBartlebySession - Editor mode, config, save status (device-driven)
//======================================================================

/**
 * Manage Bartleby EDITOR session state
 *
 * @param {BartlebyAPI} api - API instance (must be connected)
 * @param {Object} callbacks
 *   addLog: (message, type) => void - Log callback
 *
 * @returns {Object}
 *   config: Object - Current config from device
 *   saveStatus: 'saved'|'saving'|'unsaved' - Device-driven save state
 *   busy: boolean - True if operation in progress
 *   sessionActive: boolean - True if EDITOR mode active
 *   initSession: () => Promise<Object|null> - Start EDITOR session
 *   updateConfig: (partial) => Promise - Update config on device
 *   save: () => Promise - Trigger manual save
 *   eject: () => Promise - Exit EDITOR mode
 *   reset: () => void - Clear state (call on disconnect)
 */
function useBartlebySession(api, { addLog }) {
    const [config, setConfig] = useState(null);
    const [saveStatus, setSaveStatus] = useState('saved');
    const [busy, setBusy] = useState(false);
    const [sessionActive, setSessionActive] = useState(false);

    // Register save status callback once
    const registeredRef = useRef(false);
    useEffect(() => {
        if (api && !registeredRef.current) {
            api.onSaveStatusChanged((status) => {
                setSaveStatus(status);
            });
            registeredRef.current = true;
        }
    }, [api]);

    /**
     * Initialize EDITOR session (call when device connects)
     * This puts Bartleby in EDITOR mode, which also forces MPE mode
     */
    const initSession = useCallback(async () => {
        if (busy || !api || !api.isConnected()) return null;
        setBusy(true);

        try {
            addLog?.('Initializing Bartleby session...', 'info');
            const response = await api.init();

            if (response.status === 'editor-active') {
                setConfig(response.config);
                setSaveStatus('saved');
                setSessionActive(true);
                addLog?.('Bartleby EDITOR session started (MPE mode active)', 'info');
                setBusy(false);
                return response.config;
            } else if (response.status === 'error') {
                addLog?.(`Bartleby init failed: ${response.message}`, 'error');
            }
        } catch (e) {
            addLog?.(`Bartleby init failed: ${e.message}`, 'error');
        }

        setBusy(false);
        return null;
    }, [api, busy, addLog]);

    /**
     * Update config - sends to device, device will mark dirty and auto-save
     */
    const updateConfig = useCallback(async (partialConfig) => {
        if (busy || !config || !api) return;
        setBusy(true);

        try {
            const response = await api.setConfig(partialConfig);
            if (response.status === 'config') {
                setConfig(response.config);
                // saveStatus is driven by device broadcasts
            } else if (response.status === 'error') {
                addLog?.(`Bartleby config update failed: ${response.message}`, 'error');
            }
        } catch (e) {
            addLog?.(`Bartleby config update failed: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, config, busy, addLog]);

    /**
     * Manual save - triggers immediate save to flash
     */
    const save = useCallback(async () => {
        if (busy || saveStatus === 'saving' || !api) return;
        setBusy(true);

        try {
            await api.save();
            addLog?.('Bartleby manual save triggered', 'info');
        } catch (e) {
            addLog?.(`Bartleby save failed: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, busy, saveStatus, addLog]);

    /**
     * Exit EDITOR mode
     */
    const eject = useCallback(async () => {
        if (busy || !api) return;
        setBusy(true);

        try {
            await api.eject();
            setSessionActive(false);
            addLog?.('Bartleby EDITOR session ended', 'info');
        } catch (e) {
            addLog?.(`Bartleby eject failed: ${e.message}`, 'error');
        }

        setBusy(false);
    }, [api, busy, addLog]);

    /**
     * Reset state (call on disconnect)
     */
    const reset = useCallback(() => {
        setConfig(null);
        setSaveStatus('saved');
        setSessionActive(false);
        registeredRef.current = false;
    }, []);

    return {
        config,
        saveStatus,
        busy,
        sessionActive,
        initSession,
        updateConfig,
        save,
        eject,
        reset,
    };
}

//======================================================================
// useBartlebyDeviceInfo - Device info (project, version)
//======================================================================

/**
 * Fetch and store Bartleby device info
 *
 * @param {BartlebyAPI} api - API instance
 * @param {Object} callbacks
 *   addLog: (message, type) => void
 *
 * @returns {Object}
 *   deviceInfo: { project, version, versionNumber } | null
 *   fetchDeviceInfo: () => Promise<Object|null>
 *   reset: () => void
 */
function useBartlebyDeviceInfo(api, { addLog }) {
    const [deviceInfo, setDeviceInfo] = useState(null);

    const fetchDeviceInfo = useCallback(async () => {
        if (!api || !api.isConnected()) return null;

        try {
            const info = await api.getDeviceInfo();
            if (info.status === 'device-info') {
                setDeviceInfo(info);
                addLog?.(`Bartleby: ${info.project} v${info.version}`, 'info');
                return info;
            } else if (info.status === 'error') {
                addLog?.(`Bartleby device info failed: ${info.message}`, 'warn');
            }
        } catch (e) {
            addLog?.(`Bartleby device info failed: ${e.message}`, 'warn');
        }
        return null;
    }, [api, addLog]);

    const reset = useCallback(() => {
        setDeviceInfo(null);
    }, []);

    return {
        deviceInfo,
        fetchDeviceInfo,
        reset,
    };
}
