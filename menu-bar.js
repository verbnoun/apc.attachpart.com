/**
 * Menu Bar - Classic Mac OS menu bar with per-app menus
 *
 * Left: App name (bold), context-sensitive dropdown menus
 *   - APConsole (no device focused): Tools
 *   - Bartleby focused: Config, Tools (includes Firmware/Language)
 *   - Candide focused: Tools (includes Firmware/Language)
 *
 * Dropdown behavior: click to open, click item to act, click elsewhere to dismiss.
 * Hover switches between open menus (Mac behavior).
 */

function MenuBar({ focusedWindow, configSection, onConfigSection, onLogClick, onSyncClick, onExpressionPadClick, onPreferencesClick, onOpenDeviceTool }) {
    const [openMenu, setOpenMenu] = React.useState(null);

    const appType = focusedWindow?.type || 'apconsole';
    const appName = focusedWindow?.title || 'APConsole';

    // Close menu on any outside click
    React.useEffect(() => {
        if (!openMenu) return;
        const close = () => setOpenMenu(null);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [openMenu]);

    const handleMenuClick = (menuName, e) => {
        e.stopPropagation();
        setOpenMenu(prev => prev === menuName ? null : menuName);
    };

    const handleItemClick = (action, e) => {
        e.stopPropagation();
        setOpenMenu(null);
        if (action) action();
    };

    const handleMenuHover = (menuName) => {
        if (openMenu && openMenu !== menuName) {
            setOpenMenu(menuName);
        }
    };

    // Shared tool items (appear in all Tools menus)
    const sharedToolItems = (
        <>
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
        </>
    );

    // Build menus based on app type
    const menus = [];

    if (appType === 'bartleby') {
        // Bartleby: Config menu (section switcher) + Tools (with Firmware/Language)
        menus.push({
            id: 'config',
            label: 'Config',
            items: (
                <>
                    <button className={`ap-menubar-dropdown-item${configSection === 'curves' ? ' checked' : ''}`} onMouseDown={(e) => handleItemClick(() => switchConfigSection('curves'), e)}>
                        Curves
                    </button>
                    <button className={`ap-menubar-dropdown-item${configSection === 'dials' ? ' checked' : ''}`} onMouseDown={(e) => handleItemClick(() => switchConfigSection('dials'), e)}>
                        Dials
                    </button>
                    <button className={`ap-menubar-dropdown-item${configSection === 'pedal' ? ' checked' : ''}`} onMouseDown={(e) => handleItemClick(() => switchConfigSection('pedal'), e)}>
                        Pedal
                    </button>
                    <button className={`ap-menubar-dropdown-item${configSection === 'screen' ? ' checked' : ''}`} onMouseDown={(e) => handleItemClick(() => switchConfigSection('screen'), e)}>
                        Screen
                    </button>
                </>
            )
        });
        menus.push({
            id: 'tools',
            label: 'Tools',
            items: (
                <>
                    <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(() => openDeviceTool('firmware'), e)}>
                        Firmware
                    </button>
                    <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(() => openDeviceTool('language'), e)}>
                        Language
                    </button>
                    <div className="ap-menubar-dropdown-separator"></div>
                    {sharedToolItems}
                </>
            )
        });
    } else if (appType === 'candide') {
        // Candide: Tools (with Firmware/Language)
        menus.push({
            id: 'tools',
            label: 'Tools',
            items: (
                <>
                    <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(() => openDeviceTool('firmware'), e)}>
                        Firmware
                    </button>
                    <button className="ap-menubar-dropdown-item" onMouseDown={(e) => handleItemClick(() => openDeviceTool('language'), e)}>
                        Language
                    </button>
                    <div className="ap-menubar-dropdown-separator"></div>
                    {sharedToolItems}
                </>
            )
        });
    } else {
        // APConsole: just Tools
        menus.push({
            id: 'tools',
            label: 'Tools',
            items: sharedToolItems
        });
    }

    function switchConfigSection(section) {
        if (onConfigSection) onConfigSection(section);
    }

    function openDeviceTool(tool) {
        if (onOpenDeviceTool) onOpenDeviceTool(tool);
    }

    return (
        <div className="ap-menubar">
            <div className="ap-menubar-left">
                <span
                    className="ap-menubar-app-name"
                    onMouseDown={(e) => handleMenuClick('app', e)}
                    onMouseEnter={() => handleMenuHover('app')}
                >
                    {appName}
                </span>

                {menus.map(menu => (
                    <div key={menu.id} className="ap-menubar-menu" onMouseDown={(e) => e.stopPropagation()}>
                        <button
                            className={`ap-menubar-btn${openMenu === menu.id ? ' active' : ''}`}
                            onMouseDown={(e) => handleMenuClick(menu.id, e)}
                            onMouseEnter={() => handleMenuHover(menu.id)}
                        >
                            {menu.label}
                        </button>
                        {openMenu === menu.id && (
                            <div className="ap-menubar-dropdown">
                                {menu.items}
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <div className="ap-menubar-right">
            </div>
        </div>
    );
}
