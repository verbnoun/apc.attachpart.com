/**
 * Device Sidebar - Shows connected devices and tools
 *
 * Devices: Dynamically rendered from connected devices
 * Tools: Expression Pad, Log (always available)
 *
 * Click device → action menu overlay (capability-driven)
 * Click tool → opens tool window directly
 */

const { useState, useEffect, useCallback } = React;

/**
 * Main sidebar component
 *
 * @param {Object} devices - Device states keyed by port name
 *   { 'Candide MPE': { connected, name, capabilities }, ... }
 * @param {Function} onDeviceAction - Called with (portName, action)
 * @param {Function} onToolClick - Called with (toolId)
 */
function DeviceSidebar({ devices, onDeviceAction, onToolClick }) {
    const [menuOpen, setMenuOpen] = useState(null); // { portName, x, y }

    const handleDeviceClick = (portName, event) => {
        const device = devices[portName];
        if (!device || !device.connected) return;

        const rect = event.currentTarget.getBoundingClientRect();
        setMenuOpen({
            portName,
            x: rect.right + 8,
            y: rect.top
        });
    };

    const handleActionClick = (action) => {
        if (menuOpen && onDeviceAction) {
            onDeviceAction(menuOpen.portName, action);
        }
        setMenuOpen(null);
    };

    const handleToolClick = (tool) => {
        if (onToolClick) {
            onToolClick(tool);
        }
    };

    // Close menu on outside click
    useEffect(() => {
        if (!menuOpen) return;

        const handleClick = (e) => {
            if (!e.target.closest('.ap-action-menu')) {
                setMenuOpen(null);
            }
        };

        document.addEventListener('click', handleClick);
        return () => document.removeEventListener('click', handleClick);
    }, [menuOpen]);

    // Get list of port names for rendering
    const portNames = Object.keys(devices);

    return (
        <div className="ap-sidebar">
            {/* Devices section */}
            <div className="ap-sidebar-section">
                {portNames.map(portName => {
                    const device = devices[portName];
                    const displayName = device.deviceInfo?.name || portName.replace(' MPE', '');
                    // Create short label (first 5 chars uppercase)
                    const label = displayName.substring(0, 5).toUpperCase();
                    // Icon is first character
                    const icon = displayName.charAt(0).toUpperCase();

                    return (
                        <SidebarDevice
                            key={portName}
                            portName={portName}
                            label={label}
                            icon={icon}
                            connected={device.connected}
                            onClick={handleDeviceClick}
                        />
                    );
                })}
                {portNames.length === 0 && (
                    <div className="ap-sidebar-empty">No devices</div>
                )}
            </div>

            <div className="ap-sidebar-divider" />

            {/* Tools section */}
            <div className="ap-sidebar-section">
                <SidebarTool
                    id="expression"
                    label="PAD"
                    icon="~"
                    onClick={handleToolClick}
                />
                <SidebarTool
                    id="patch"
                    label="PATCH"
                    icon="P"
                    onClick={handleToolClick}
                />
                <SidebarTool
                    id="log"
                    label="LOG"
                    icon="#"
                    onClick={handleToolClick}
                />
            </div>

            {/* Action menu overlay */}
            {menuOpen && (
                <ActionMenu
                    portName={menuOpen.portName}
                    capabilities={devices[menuOpen.portName]?.capabilities || []}
                    x={menuOpen.x}
                    y={menuOpen.y}
                    onAction={handleActionClick}
                    onClose={() => setMenuOpen(null)}
                />
            )}
        </div>
    );
}

/**
 * Device item in sidebar
 */
function SidebarDevice({ portName, label, icon, connected, onClick }) {
    const className = `ap-sidebar-item ${connected ? 'connected' : 'disconnected'}`;

    return (
        <div
            className={className}
            onClick={(e) => onClick(portName, e)}
            title={connected ? `${label} - Click for actions` : `${label} - Not connected`}
        >
            <div className="ap-sidebar-icon">{icon}</div>
            <span className="ap-sidebar-label">{label}</span>
            <span className="ap-sidebar-status">
                {connected ? 'ON' : 'OFF'}
            </span>
        </div>
    );
}

/**
 * Tool item in sidebar
 */
function SidebarTool({ id, label, icon, onClick }) {
    return (
        <div
            className="ap-sidebar-item"
            onClick={() => onClick(id)}
            title={label}
        >
            <div className="ap-sidebar-icon">{icon}</div>
            <span className="ap-sidebar-label">{label}</span>
        </div>
    );
}

/**
 * Action menu overlay for devices
 * Actions are determined by device capabilities
 */
function ActionMenu({ portName, capabilities, x, y, onAction, onClose }) {
    const actions = getActionsForCapabilities(capabilities);

    return (
        <div
            className="ap-action-menu"
            style={{ left: x, top: y }}
            onClick={(e) => e.stopPropagation()}
        >
            {actions.map(action => (
                <div
                    key={action.id}
                    className="ap-action-menu-item"
                    onClick={() => onAction(action.id)}
                >
                    {action.label}
                </div>
            ))}
        </div>
    );
}

/**
 * Get available actions based on device capabilities
 * No device-specific logic - purely capability-driven
 */
function getActionsForCapabilities(capabilities) {
    const actions = [];

    // PATCHES capability → Patches action
    if (capabilities.includes(CAPABILITIES.PATCHES)) {
        actions.push({ id: 'patches', label: 'Patches' });
    }

    // CONFIG capability → Config action
    if (capabilities.includes(CAPABILITIES.CONFIG)) {
        actions.push({ id: 'config', label: 'Config' });
    }

    // FIRMWARE capability → Firmware action
    if (capabilities.includes(CAPABILITIES.FIRMWARE)) {
        actions.push({ id: 'firmware', label: 'Firmware' });
    }

    // Always show language (all devices support this locally)
    actions.push({ id: 'language', label: 'Language' });

    return actions;
}
