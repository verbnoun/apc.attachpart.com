/**
 * Menu Bar - System 7-inspired top menu bar
 *
 * Left: App name (focused window), LOG button, SYNC button
 * Right: per-device status LEDs + names, LINKED badge
 */

function MenuBar({ devices, isLinked, focusedApp, onLogClick, onSyncClick }) {
    return (
        <div className="ap-menubar">
            <div className="ap-menubar-left">
                <span className="ap-menubar-app-name">{focusedApp || 'Finder'}</span>
                <button className="ap-menubar-btn" onClick={onLogClick}>
                    Log
                </button>
                <button
                    className="ap-menubar-btn"
                    onClick={onSyncClick}
                    disabled={!isLinked}
                >
                    Sync
                </button>
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
