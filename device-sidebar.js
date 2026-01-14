/**
 * Device Sidebar - Shows connected devices and tools
 *
 * Devices: Bartleby, Candide (show connection status)
 * Tools: Expression Pad, Sequencer (always available)
 *
 * Click device → action menu overlay
 * Click tool → opens tool window directly
 */

const { useState, useEffect, useCallback } = React;

/**
 * Main sidebar component
 */
function DeviceSidebar({ deviceStates, onDeviceAction, onToolClick }) {
    const [menuOpen, setMenuOpen] = useState(null); // { device, x, y }

    const handleDeviceClick = (device, event) => {
        if (!deviceStates[device]?.connected) return;

        const rect = event.currentTarget.getBoundingClientRect();
        setMenuOpen({
            device,
            x: rect.right + 8,
            y: rect.top
        });
    };

    const handleActionClick = (action) => {
        if (menuOpen && onDeviceAction) {
            onDeviceAction(menuOpen.device, action);
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

    return (
        <div className="ap-sidebar">
            {/* Devices section */}
            <div className="ap-sidebar-section">
                <SidebarDevice
                    id="bartleby"
                    label="BART"
                    icon="B"
                    connected={deviceStates.bartleby?.connected}
                    onClick={handleDeviceClick}
                />
                <SidebarDevice
                    id="candide"
                    label="CANDI"
                    icon="C"
                    connected={deviceStates.candide?.connected}
                    onClick={handleDeviceClick}
                />
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
                    id="log"
                    label="LOG"
                    icon="#"
                    onClick={handleToolClick}
                />
            </div>

            {/* Action menu overlay */}
            {menuOpen && (
                <ActionMenu
                    device={menuOpen.device}
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
function SidebarDevice({ id, label, icon, connected, onClick }) {
    const className = `ap-sidebar-item ${connected ? 'connected' : 'disconnected'}`;

    return (
        <div
            className={className}
            onClick={(e) => onClick(id, e)}
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
 */
function ActionMenu({ device, x, y, onAction, onClose }) {
    const actions = getActionsForDevice(device);

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
 * Get available actions for a device
 */
function getActionsForDevice(device) {
    const common = [
        { id: 'firmware', label: 'Firmware' },
        { id: 'language', label: 'Language' }
    ];

    if (device === 'bartleby') {
        return [
            { id: 'config', label: 'Config' },
            ...common
        ];
    }

    if (device === 'candide') {
        return [
            { id: 'patches', label: 'Patches' },
            ...common
        ];
    }

    return common;
}
