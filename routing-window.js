/**
 * Routing Window - MIDI and config routing UI
 *
 * Visual routing panel for connecting controllers to synths.
 * Supports MIDI (many:many) and config (1:1) connections.
 * Depends on: React, ap-wires.js (usePortPositions, useWiring, APWireGroup, APPreviewWire, apBezierPath)
 */

function RoutingPanel({ controllers, synths, routes, configPairs,
                        onAddRoute, onRemoveRoute, onSetConfigPair, onClearConfigPair, getName }) {
    const panelRef = React.useRef(null);

    // Shared primitives from ap-wires.js
    const { positions: portPositions, setRef } = usePortPositions(panelRef, [controllers, synths, routes, configPairs]);
    const { wiring, mousePos, startWire, cancelWire } = useWiring(panelRef);

    // Complete a wire connection (domain-specific: midi many:many, config 1:1)
    const completeWire = (port, type, side) => {
        if (!wiring) return;
        if (wiring.type !== type || wiring.side === side) {
            cancelWire();
            return;
        }
        const ctrlPort = side === 'controller' ? port : wiring.from;
        const synthPort = side === 'synth' ? port : wiring.from;
        if (type === 'midi') {
            onAddRoute(ctrlPort, synthPort);
        } else {
            if (!routes.some(r => r.from === ctrlPort && r.to === synthPort)) {
                onAddRoute(ctrlPort, synthPort);
            }
            onSetConfigPair(ctrlPort, synthPort);
        }
        cancelWire();
    };

    const handlePortDown = (port, type, side, e) => {
        e.preventDefault();
        if (wiring) { completeWire(port, type, side); return; }
        startWire({ from: port, type, side });
    };

    const handlePortUp = (port, type, side) => {
        if (!wiring) return;
        completeWire(port, type, side);
    };

    const handlePortClick = (port, type, side) => {
        if (!wiring) return;
        completeWire(port, type, side);
    };

    const handleWireClick = (type, ctrlPort, synthPort) => {
        if (type === 'midi') onRemoveRoute(ctrlPort, synthPort);
        else onClearConfigPair(ctrlPort);
    };

    const handlePanelClick = (e) => {
        if (wiring && !e.target.closest('.ap-port') && !e.target.closest('.ap-port-row')) cancelWire();
    };

    const isActive = (port, type) => wiring?.from === port && wiring?.type === type;
    const isTarget = (port, type, side) => {
        if (!wiring || wiring.type !== type || wiring.side === side || wiring.from === port) return false;
        if (type === 'config') {
            if (side === 'synth') {
                const existingCtrl = Object.entries(configPairs).find(([_, s]) => s === port)?.[0];
                if (existingCtrl && existingCtrl !== wiring.from) return false;
            } else {
                if (configPairs[port] && configPairs[port] !== wiring.from) return false;
            }
        }
        return true;
    };

    const portRow = (port, type, side) => {
        const target = isTarget(port, type, side);
        const active = isActive(port, type);
        return (
            <div className={`ap-port-row${side === 'synth' ? ' right' : ' left'}${target ? ` drop-target ${type}` : ''}`}
                 onMouseDown={(e) => { e.stopPropagation(); handlePortDown(port, type, side, e); }}
                 onMouseUp={() => handlePortUp(port, type, side)}
                 onClick={(e) => { e.stopPropagation(); handlePortClick(port, type, side); }}>
                {side === 'controller' && <span className="ap-port-label">{type}</span>}
                <div ref={setRef(`${port}:${type}`)}
                     className={`ap-port ${type}${active ? ' active' : ''}${target ? ' target' : ''}`} />
                {side === 'synth' && <span className="ap-port-label">{type}</span>}
            </div>
        );
    };

    return (
        <div className="ap-routing-panel" ref={panelRef} onClick={handlePanelClick}>
            <div className="ap-routing-col synths">
                <div className="ap-routing-col-label">Synths</div>
                {synths.map(([port]) => (
                    <div key={port} className="ap-device-box stacked">
                        <div className="ap-device-box-name">{getName(port)}</div>
                        <div className="ap-device-box-ports">
                            {portRow(port, 'midi', 'synth')}
                            {portRow(port, 'config', 'synth')}
                        </div>
                    </div>
                ))}
            </div>

            <div className="ap-routing-col controllers">
                <div className="ap-routing-col-label">Controllers</div>
                {controllers.map(([port]) => (
                    <div key={port} className="ap-device-box stacked">
                        <div className="ap-device-box-name">{getName(port)}</div>
                        <div className="ap-device-box-ports">
                            {portRow(port, 'midi', 'controller')}
                            {portRow(port, 'config', 'controller')}
                        </div>
                    </div>
                ))}
            </div>

            <svg className="ap-wire-layer">
                {routes.map(({ from: ctrlPort, to: synthPort }) => {
                    const sp = portPositions[`${synthPort}:midi`];
                    const cp = portPositions[`${ctrlPort}:midi`];
                    if (!sp || !cp) return null;
                    return <APWireGroup key={`midi-${ctrlPort}-${synthPort}`}
                        path={apBezierPath(sp.x, sp.y, cp.x, cp.y)}
                        color="var(--ap-wire-audio)"
                        onClick={() => handleWireClick('midi', ctrlPort, synthPort)} />;
                })}

                {Object.entries(configPairs).map(([ctrlPort, synthPort]) => {
                    if (!controllers.some(([p]) => p === ctrlPort)) return null;
                    if (!synths.some(([p]) => p === synthPort)) return null;
                    const sp = portPositions[`${synthPort}:config`];
                    const cp = portPositions[`${ctrlPort}:config`];
                    if (!sp || !cp) return null;
                    return <APWireGroup key={`config-${ctrlPort}`}
                        path={apBezierPath(sp.x, sp.y, cp.x, cp.y)}
                        color="var(--ap-wire-control)" dash="4,2"
                        onClick={() => handleWireClick('config', ctrlPort, synthPort)} />;
                })}

                {wiring && (() => {
                    const fp = portPositions[`${wiring.from}:${wiring.type}`];
                    if (!fp) return null;
                    const color = wiring.type === 'midi' ? 'var(--ap-wire-audio)' : 'var(--ap-wire-control)';
                    return <APPreviewWire fromPos={fp} toPos={mousePos} color={color}
                                          reverse={wiring.side === 'controller'} />;
                })()}
            </svg>
        </div>
    );
}

function RoutingWindow({ devices, routes, configPairs, onAddRoute, onRemoveRoute, onSetConfigPair, onClearConfigPair, routingLogs }) {
    const scrollRef = React.useRef(null);

    React.useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [routingLogs]);

    const connectedDevices = Object.entries(devices).filter(([_, d]) => d.status === 'connected');
    const controllers = connectedDevices.filter(([_, d]) => d.capabilities?.includes('CONTROLLER'));
    const synths = connectedDevices.filter(([_, d]) => d.capabilities?.includes('SYNTH'));

    const getName = (portName) => devices[portName]?.deviceInfo?.name || portName;

    if (controllers.length === 0 && synths.length === 0) {
        return (
            <div className="ap-routing-window">
                <div className="ap-routing-empty">No devices connected</div>
                <div className="ap-routing-log" ref={scrollRef}>
                    {routingLogs.length === 0 ? (
                        <span className="ap-text-muted">Routing log</span>
                    ) : routingLogs.map((log, i) => (
                        <div key={i} className={`ap-routing-log-entry ap-routing-log-${log.type}`}>
                            <span className="ap-routing-log-time">[{log.timestamp}]</span>
                            {' '}<span>{log.message}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="ap-routing-window">
            <RoutingPanel
                controllers={controllers}
                synths={synths}
                routes={routes}
                configPairs={configPairs}
                onAddRoute={onAddRoute}
                onRemoveRoute={onRemoveRoute}
                onSetConfigPair={onSetConfigPair}
                onClearConfigPair={onClearConfigPair}
                getName={getName}
            />

            {/* Routing log */}
            <div className="ap-routing-log" ref={scrollRef}>
                {routingLogs.length === 0 ? (
                    <span className="ap-text-muted">Routing log</span>
                ) : routingLogs.map((log, i) => (
                    <div key={i} className={`ap-routing-log-entry ap-routing-log-${log.type}`}>
                        <span className="ap-routing-log-time">[{log.timestamp}]</span>
                        {' '}<span>{log.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
