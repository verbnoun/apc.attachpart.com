/**
 * Device App Window - Direct content view for a single device
 *
 * Candide (PATCHES): shows PatchEditorWindow directly
 * Bartleby (CONFIG): handled by separate ConfigSectionWindow instances
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
    controllerConfig
}) {
    const capabilities = device?.capabilities || [];
    const hasPatch = capabilities.includes(CAPABILITIES.PATCHES);

    return (
        <div className="ap-device-app">
            <div className="ap-device-app-content">
                {hasPatch && (
                    <PatchEditorWindow
                        deviceKey={portName}
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
            </div>
        </div>
    );
}
