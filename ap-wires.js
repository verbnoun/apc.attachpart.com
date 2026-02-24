// APWires — Shared wire primitives for patch editor + routing panel.
// Provides: Bézier path math, port position tracking, wiring state machine,
// wire group component, and preview wire component.

const { useState, useRef, useCallback, useEffect, useLayoutEffect } = React;

// --- Bézier Path ---
// Horizontal-stub cubic Bézier from (x1,y1) to (x2,y2).
// Exits right, enters left. Offset scales with distance.
function apBezierPath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const offset = Math.max(40, Math.min(200, dx / 3 + dy / 2));
    return `M ${x1} ${y1} C ${x1 + offset} ${y1}, ${x2 - offset} ${y2}, ${x2} ${y2}`;
}

// --- usePortPositions ---
// Tracks port element centers relative to a container.
// Returns { positions, setRef, update }.
//   setRef(key) → callback ref for port elements
//   positions   → { [key]: { x, y } }
//   update()    → force recalculate (call after layout changes)
//
// Automatically recalculates on container resize and when deps change.
function usePortPositions(containerRef, deps) {
    const refsMap = useRef({});
    const [positions, setPositions] = useState({});

    const update = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        const pos = {};
        for (const [key, el] of Object.entries(refsMap.current)) {
            if (!el) continue;
            const r = el.getBoundingClientRect();
            pos[key] = {
                x: r.left + r.width / 2 - containerRect.left,
                y: r.top + r.height / 2 - containerRect.top
            };
        }
        setPositions(pos);
    }, [containerRef]);

    // Recalculate when deps change
    useLayoutEffect(update, deps || []);

    // Recalculate on container resize
    useEffect(() => {
        const ro = new ResizeObserver(update);
        if (containerRef.current) ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, [containerRef, update]);

    const setRef = useCallback((key) => (el) => {
        refsMap.current[key] = el;
    }, []);

    return { positions, setRef, update };
}

// --- useWiring ---
// Generic wiring state machine: start, track mouse, complete/cancel.
// Returns { wiring, mousePos, startWire, cancelWire, handlers }.
//   wiring    → null | metadata object (whatever you passed to startWire)
//   mousePos  → { x, y } relative to container (updated during active wiring)
//   startWire(metadata) → begin wiring
//   cancelWire()        → cancel active wiring
//   handlers  → { onMouseDown, onMouseUp, onClick } for port elements
//               (caller wraps these with their own validation)
//
// Automatically:
//   - Tracks mouse position relative to containerRef during wiring
//   - Cancels on Escape
//   - Cancels on mouseup outside of .ap-port-row and .ap-port elements
function useWiring(containerRef) {
    const [wiring, setWiring] = useState(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    useEffect(() => {
        if (!wiring) return;
        const container = containerRef.current;
        if (!container) return;
        const onMove = (e) => {
            const r = container.getBoundingClientRect();
            setMousePos({ x: e.clientX - r.left, y: e.clientY - r.top });
        };
        const onKey = (e) => { if (e.key === 'Escape') setWiring(null); };
        const onUp = (e) => {
            // If mouseup is on a port or port row, let the element's own handler complete
            if (e.target.closest('.ap-port-row') || e.target.closest('.ap-port')) return;
            setWiring(null);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('keydown', onKey);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mouseup', onUp);
        };
    }, [wiring, containerRef]);

    const startWire = useCallback((metadata) => setWiring(metadata), []);
    const cancelWire = useCallback(() => setWiring(null), []);

    return { wiring, mousePos, startWire, cancelWire };
}

// --- APWireGroup ---
// Dual-path SVG wire: invisible fat hit target + visible thin wire.
// Props:
//   path       — SVG path string (from apBezierPath)
//   color      — stroke color (CSS variable or hex)
//   onClick    — click handler (for removing wires)
//   strokeWidth — visible wire width (default 2)
//   dash       — strokeDasharray (default none = solid)
//   hitWidth   — invisible hit target width (default 16)
//   selected   — show selection glow (default false)
//   className  — additional class on <g> (default '')
function APWireGroup({ path, color, onClick, strokeWidth, dash, hitWidth, selected, className }) {
    const sw = strokeWidth || 2;
    const hw = hitWidth || 16;
    const children = [
        // Invisible hit target
        React.createElement('path', {
            key: 'hit',
            d: path,
            stroke: 'transparent',
            strokeWidth: hw,
            fill: 'none',
            style: { cursor: 'pointer' },
            onClick: onClick
        }),
        // Visible wire
        React.createElement('path', {
            key: 'wire',
            d: path,
            stroke: color,
            strokeWidth: sw,
            fill: 'none',
            strokeDasharray: dash || 'none',
            style: { pointerEvents: 'none' }
        })
    ];
    // Selection glow
    if (selected) {
        children.push(React.createElement('path', {
            key: 'glow',
            d: path,
            stroke: color,
            strokeWidth: sw * 3,
            fill: 'none',
            strokeDasharray: dash || 'none',
            opacity: 0.3,
            style: { pointerEvents: 'none' }
        }));
    }
    return React.createElement('g', {
        className: 'ap-wire-group' + (className ? ' ' + className : '')
    }, ...children);
}

// --- APPreviewWire ---
// Animated dashed wire that follows the mouse during wiring.
// Props:
//   fromPos — { x, y } source port position
//   toPos   — { x, y } target position (usually mouse cursor)
//   color   — stroke color
//   reverse — if true, swap from/to for Bézier direction (default false)
function APPreviewWire({ fromPos, toPos, color, reverse }) {
    if (!fromPos || !toPos) return null;
    const d = reverse
        ? apBezierPath(toPos.x, toPos.y, fromPos.x, fromPos.y)
        : apBezierPath(fromPos.x, fromPos.y, toPos.x, toPos.y);
    return React.createElement('path', {
        d: d,
        stroke: color,
        strokeWidth: 2,
        fill: 'none',
        strokeDasharray: '4,2',
        opacity: 0.7,
        className: 'ap-wire-drag'
    });
}
