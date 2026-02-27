/**
 * Node Wires - Wire components for the patch editor workspace
 *
 * ModWire — Modulation wire (dashed, clickable for selection)
 * DraggingWire — Preview wire while creating new connection
 * Wire — Audio chain wire (solid, non-interactive)
 *
 * Depends on: React, ap-wires.js (apBezierPath, APPreviewWire)
 */

function ModWire({ connection, wireKey, portPositions, isSelected, onSelect, moduleState }) {
    const { from, toModule, toParam, amount, fixed } = connection;

    const fromPort = portPositions[`${from}:out`];
    const toPort = portPositions[`${toModule}:${toParam}:in`];
    if (!fromPort || !toPort) return null;

    const { x: x1, y: y1 } = fromPort;
    const { x: x2, y: y2 } = toPort;
    const color = moduleState?.allModules?.get(from)?.groupColor || 'var(--ap-wire-mod)';
    const pathD = apBezierPath(x1, y1, x2, y2);

    const handleClick = (e) => {
        e.stopPropagation();
        if (!fixed && onSelect) onSelect();
    };

    return (
        <g className={`ap-wire-group ap-mod-wire ${isSelected ? 'selected' : ''} ${fixed ? 'fixed' : ''}`}>
            {!fixed && (
                <path d={pathD} stroke="transparent" strokeWidth={24} fill="none"
                      style={{ cursor: 'pointer' }} onClick={handleClick} />
            )}
            <path d={pathD} stroke={color} strokeWidth={isSelected ? 3 : 2} fill="none"
                  strokeDasharray="4,2" opacity={fixed ? 0.6 : 1}
                  style={{ pointerEvents: 'none' }} />
            {isSelected && (
                <path d={pathD} stroke={color} strokeWidth={6} fill="none"
                      strokeDasharray="4,2" opacity={0.3} style={{ pointerEvents: 'none' }} />
            )}
            {!fixed && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} fill={color} fontSize="8"
                      textAnchor="middle" style={{ fontFamily: 'var(--ap-font-family)', pointerEvents: 'none' }}>
                    {amount}
                </text>
            )}
        </g>
    );
}

function DraggingWire({ fromModule, mousePos, portPositions, moduleState }) {
    const fromPort = portPositions[`${fromModule}:out`];
    if (!fromPort) return null;
    const color = moduleState?.allModules?.get(fromModule)?.groupColor || 'var(--ap-wire-mod)';
    return <APPreviewWire fromPos={fromPort} toPos={mousePos} color={color} />;
}

function Wire({ from, to, color, portPositions }) {
    const fromPort = portPositions[`${from}:out`];
    const toPort = portPositions[`${to}:in`];
    if (!fromPort || !toPort) return null;

    return (
        <path d={apBezierPath(fromPort.x, fromPort.y, toPort.x, toPort.y)}
              stroke={color || '#888'} strokeWidth={3}
              fill="none" className="ap-wire" />
    );
}
