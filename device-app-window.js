/**
 * Device App Window - Direct content view for a single device
 *
 * No tabs — Firmware/Language moved to Tools menu,
 * config sections driven by menu bar Config dropdown.
 *
 * Bartleby (CONFIG): shows BartlebyConfigWindow directly
 * Candide (PATCHES): shows PatchEditorWindow directly
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
    // View control
    defaultTab,
    configSection
}) {
    const capabilities = device?.capabilities || [];
    const hasPatch = capabilities.includes(CAPABILITIES.PATCHES);
    const hasConfig = capabilities.includes(CAPABILITIES.CONFIG);

    return (
        <div className="ap-device-app">
            <div className="ap-device-app-content">
                {hasPatch && (
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
                {hasConfig && (
                    <BartlebyConfigWindow
                        config={config}
                        saveStatus={device?.saveStatus || 'saved'}
                        deviceInfo={device?.deviceInfo}
                        onConfigChange={onConfigChange}
                        onSave={onSave}
                        midiState={midiState}
                        activeSection={configSection}
                    />
                )}
            </div>
        </div>
    );
}
