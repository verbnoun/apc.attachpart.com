/**
 * Menu Bar - Classic Mac OS menu bar
 *
 * Left: App name (bold), dropdown menus (Tools)
 * Right: per-device status LEDs + names, LINKED badge
 *
 * Dropdown behavior: click to open, click item to act, click elsewhere to dismiss.
 */

function MenuBar({ devices, isLinked, focusedApp, onLogClick, onSyncClick, onExpressionPadClick, onPreferencesClick }) {
    const [openMenu, setOpenMenu] = React.useState(null);

    // Close menu on any outside click
    React.useEffect(() => {
        if (!openMenu) return;
        const close = () => setOpenMenu(null);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [openMenu]);

    const handleMenuClick = (menuName, e) => {
        e.stopPropagation();
        // Mac behavior: click toggles, or if a different menu is open, switch to it
        setOpenMenu(prev => prev === menuName ? null : menuName);
    };

    const handleItemClick = (action, e) => {
        e.stopPropagation();
        setOpenMenu(null);
        action();
    };

    // Mac behavior: hover to switch between open menus
    const handleMenuHover = (menuName) => {
        if (openMenu && openMenu !== menuName) {
            setOpenMenu(menuName);
        }
    };

    return (
        <div className="ap-menubar">
            <div className="ap-menubar-left">
                <span
                    className="ap-menubar-app-name"
                    onMouseDown={(e) => handleMenuClick('app', e)}
                    onMouseEnter={() => handleMenuHover('app')}
                >
                    {focusedApp || 'APConsole'}
                </span>

                <div className="ap-menubar-menu" onMouseDown={(e) => e.stopPropagation()}>
                    <button
                        className={`ap-menubar-btn${openMenu === 'tools' ? ' active' : ''}`}
                        onMouseDown={(e) => handleMenuClick('tools', e)}
                        onMouseEnter={() => handleMenuHover('tools')}
                    >
                        Tools
                    </button>
                    {openMenu === 'tools' && (
                        <div className="ap-menubar-dropdown">
                            <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(onLogClick, e)}>
                                Console Log
                            </button>
                            <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(onSyncClick, e)}>
                                Sync
                            </button>
                            <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(onExpressionPadClick, e)}>
                                Expression Pad
                            </button>
                            <div className="ap-menubar-dropdown-separator"></div>
                            <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(onPreferencesClick, e)}>
                                Preferences…
                            </button>
                        </div>
                    )}
                </div>
            </div>
            <div className="ap-menubar-right">
                {Object.entries(devices).map(([portName, device]) => (
                    <div key={portName} className="ap-menubar-device">
                        <span className={`ap-menubar-led ${device.status === 'connected' ? 'connected' : ''}`}></span>
                        <span className="ap-menubar-device-name">{device.deviceInfo?.name || portName}</span>
                    </div>
                ))}
                {Object.keys(devices).length === 0 && (
                    <div className="ap-menubar-device">
                        <span className="ap-menubar-led"></span>
                        <span className="ap-menubar-device-name">No devices</span>
                    </div>
                )}
                {isLinked && (
                    <span className="ap-menubar-linked">LINKED</span>
                )}
            </div>
        </div>
    );
}
