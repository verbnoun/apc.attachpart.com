/**
 * Device App Window - Tabbed view for a single device
 *
 * Replaces separate config/patches/firmware/language windows.
 * One window per device, tabs determined by capabilities.
 *
 * @param {string} portName - MIDI port name
 * @param {Object} device - Device state { status, deviceInfo, capabilities, saveStatus }
 * @param {Object} props - All props needed by child tab components
 */

function DeviceAppWindow({
    portName,
    device,
    // Patch editor props
    topology,
    patchList,
    currentPatchIndex,
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
    addLog,
    midiState,
    controllerConfig,
    // Config props
    config,
    onConfigChange,
    onSave,
    // Firmware props
    api,
    // Language props (api reused)
    // Tab control
    defaultTab
}) {
    const capabilities = device?.capabilities || [];
    const [activeTab, setActiveTab] = React.useState(defaultTab || null);

    // Build tab list from capabilities
    const tabs = [];
    if (capabilities.includes(CAPABILITIES.PATCHES)) {
        tabs.push({ id: 'patches', label: 'Patches' });
    }
    if (capabilities.includes(CAPABILITIES.CONFIG)) {
        tabs.push({ id: 'config', label: 'Config' });
    }
    if (capabilities.includes(CAPABILITIES.FIRMWARE)) {
        tabs.push({ id: 'firmware', label: 'Firmware' });
    }
    tabs.push({ id: 'language', label: 'Language' });

    // Set default tab if not set
    React.useEffect(() => {
        if (!activeTab && tabs.length > 0) {
            const def = defaultTab || tabs[0].id;
            setActiveTab(def);
        }
    }, [tabs.length]);

    const switchToDefaultTab = () => {
        const def = defaultTab || tabs[0]?.id || 'config';
        setActiveTab(def);
    };

    const deviceName = device?.deviceInfo?.name || portName;

    return (
        <div className="ap-device-app">
            <div className="ap-device-app-tabs">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`ap-device-tab ${activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="ap-device-app-content">
                {activeTab === 'patches' && (
                    <PatchEditorWindow
                        topology={topology}
                        patchList={patchList}
                        currentIndex={currentPatchIndex}
                        currentPatch={currentPatch}
                        onSelectPatch={onSelectPatch}
                        onCreatePatch={onCreatePatch}
                        onDeletePatch={onDeletePatch}
                        onRenamePatch={onRenamePatch}
                        onMovePatch={onMovePatch}
                        onToggleModule={onToggleModule}
                        onUpdateParam={onUpdateParam}
                        onToggleModulation={onToggleModulation}
                        onUpdateModAmount={onUpdateModAmount}
                        isConnected={device?.status === 'connected'}
                        addLog={addLog}
                        midiState={midiState}
                        controllerConfig={controllerConfig}
                    />
                )}
                {activeTab === 'config' && (
                    <BartlebyConfigWindow
                        config={config}
                        saveStatus={device?.saveStatus || 'saved'}
                        deviceInfo={device?.deviceInfo}
                        onConfigChange={onConfigChange}
                        onSave={onSave}
                        midiState={midiState}
                    />
                )}
                {activeTab === 'firmware' && (
                    <FirmwareWindow
                        device={portName}
                        deviceInfo={device?.deviceInfo}
                        api={api}
                        onClose={switchToDefaultTab}
                        addLog={addLog}
                    />
                )}
                {activeTab === 'language' && (
                    <LanguageWindow
                        device={portName}
                        api={api}
                        deviceInfo={device?.deviceInfo}
                        onClose={switchToDefaultTab}
                        addLog={addLog}
                    />
                )}
            </div>
        </div>
    );
}
