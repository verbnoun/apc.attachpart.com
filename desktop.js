/**
 * Desktop - System 7-inspired desktop with device icons
 *
 * Shows connected device icons + static tool icons.
 * Single-click selects, double-click opens, click background deselects.
 * Contains #workspace div for WindowManager.
 */

function Desktop({ devices, onDeviceOpen, onToolOpen }) {
    const [selectedIcon, setSelectedIcon] = React.useState(null);

    const handleBackgroundClick = (e) => {
        if (e.target === e.currentTarget || e.target.id === 'workspace') {
            setSelectedIcon(null);
        }
    };

    // Build icon list: connected devices + Expression Pad (always)
    const icons = [];

    for (const [portName, device] of Object.entries(devices)) {
        if (device.status !== 'connected') continue;
        const name = device.deviceInfo?.name || portName;
        const letter = name.charAt(0).toUpperCase();
        const isController = device.capabilities?.includes(CAPABILITIES.CONTROLLER);
        icons.push({
            id: `device-${portName}`,
            label: name,
            icon: letter,
            type: isController ? 'controller' : 'synth',
            onOpen: () => onDeviceOpen(portName)
        });
    }

    return (
        <div className="ap-desktop" onClick={handleBackgroundClick}>
            <div className="ap-desktop-icons">
                {icons.map(item => (
                    <DesktopIcon
                        key={item.id}
                        icon={item.icon}
                        label={item.label}
                        type={item.type}
                        selected={selectedIcon === item.id}
                        onClick={() => setSelectedIcon(item.id)}
                        onDoubleClick={item.onOpen}
                    />
                ))}
            </div>
            <div id="workspace">
                {/* WindowManager renders windows here */}
            </div>
        </div>
    );
}

function DesktopIcon({ icon, label, type, selected, onClick, onDoubleClick }) {
    return (
        <div
            className={`ap-desktop-icon ${selected ? 'selected' : ''} ap-desktop-icon-${type}`}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(); }}
        >
            <div className="ap-desktop-icon-image">{icon}</div>
            <span className="ap-desktop-icon-label">{label}</span>
        </div>
    );
}
