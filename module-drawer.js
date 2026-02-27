/**
 * Module Drawer - Available modules sidebar
 *
 * Rendered into the modules WindowManager column.
 * Shows topology-defined module groups; modules can be dragged or clicked to add.
 * Depends on: React (useState), JsonPopover (patch-editor.js)
 */

function ModuleDrawer({ moduleState, enabledModules, onAddModule, currentPatch, pendingModuleId }) {
    const [showJson, setShowJson] = React.useState(false);

    // Renders directly into modules WindowManager column (sticky header + sections)
    return (
        <>
            <div className="ap-drawer-header">
                <span>Modules</span>
                <button
                    className="ap-btn ap-btn-small ap-btn-secondary"
                    onClick={() => setShowJson(true)}
                    disabled={!currentPatch}
                >
                    View JSON
                </button>
            </div>
            <div className="ap-drawer-content">
                {moduleState.groups.filter(g => !g.fixed).map(group => (
                    <DrawerSection
                        key={group.id}
                        title={group.name.toUpperCase()}
                        color={group.color}
                        modules={group.modules}
                        enabledModules={enabledModules}
                        onAddModule={onAddModule}
                        pendingModuleId={pendingModuleId}
                    />
                ))}
            </div>
            {showJson && currentPatch && (
                <JsonPopover
                    patch={currentPatch}
                    onClose={() => setShowJson(false)}
                />
            )}
        </>
    );
}

function DrawerSection({ title, color, modules, enabledModules, onAddModule, pendingModuleId }) {
    // Filter to only show modules NOT in workspace (and not pending)
    const availableModules = modules.filter(m =>
        !enabledModules.has(m.id) && m.id !== pendingModuleId
    );

    if (availableModules.length === 0) return null;

    const handleDragStart = (e, moduleId) => {
        e.dataTransfer.setData('moduleId', moduleId);
        e.dataTransfer.effectAllowed = 'copy';
    };

    const handleClick = (module) => {
        // All modules can be clicked to add at default position
        onAddModule(module.id);
    };

    return (
        <div className="ap-drawer-section">
            <div className="ap-drawer-section-title" style={color ? { color } : undefined}>{title}</div>
            {availableModules.map(module => (
                <div
                    key={module.id}
                    className="ap-drawer-module"
                    draggable
                    onDragStart={(e) => handleDragStart(e, module.id)}
                    onClick={() => handleClick(module)}
                >
                    {module.name}
                </div>
            ))}
        </div>
    );
}
