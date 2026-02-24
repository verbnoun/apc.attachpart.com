// APSelect — Custom dropdown replacing native <select>
// Matches menubar dropdown styling (black border, white bg, inverted hover).
// Provides both a React component and a DOM factory for imperative usage.

// --- React Component ---
// Props:
//   value       — current selected value
//   options     — [{ value, label }] or ['string', ...]
//   onChange    — callback(newValue)
//   className   — for theming (ap-infobar-select, ap-ahab-screen-select, etc.)
//   disabled    — disables the select

function APSelect({ value, options, onChange, className, disabled }) {
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef(null);
    const [minWidth, setMinWidth] = React.useState(0);
    const measureRef = React.useRef(null);

    // Normalize options to { value, label } objects
    const normalized = React.useMemo(() =>
        options.map(o => typeof o === 'string' ? { value: o, label: o } : o),
        [options]
    );

    // Current label
    const currentLabel = normalized.find(o => String(o.value) === String(value))?.label || value;

    // Measure widest option (hidden sizer rendered off-screen)
    React.useEffect(() => {
        const el = measureRef.current;
        if (!el) return;
        let max = 0;
        const items = el.children;
        for (let i = 0; i < items.length; i++) {
            if (items[i].scrollWidth > max) max = items[i].scrollWidth;
        }
        if (max > 0) setMinWidth(max);
    }, [normalized]);

    // Close on outside click (same pattern as menubar)
    React.useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    // Escape key closes
    React.useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    const handleTrigger = (e) => {
        e.stopPropagation();
        if (!disabled) setOpen(prev => !prev);
    };

    const handleItem = (val, e) => {
        e.stopPropagation();
        setOpen(false);
        if (onChange) onChange(val);
    };

    const widthStyle = minWidth > 0 ? { minWidth: minWidth + 'px' } : undefined;

    return React.createElement('div', {
        className: 'ap-select' + (className ? ' ' + className : '') + (disabled ? ' disabled' : ''),
        ref,
        onMouseDown: (e) => e.stopPropagation()
    },
        // Hidden sizer — renders all items off-screen to measure widest
        React.createElement('div', {
            ref: measureRef,
            className: 'ap-select-dropdown ap-select-sizer',
            'aria-hidden': 'true'
        },
            normalized.map(o =>
                React.createElement('div', {
                    key: o.value,
                    className: 'ap-select-item selected'
                }, o.label)
            )
        ),
        React.createElement('button', {
            className: 'ap-select-trigger',
            onMouseDown: handleTrigger,
            style: widthStyle,
            type: 'button'
        }, currentLabel),
        open && React.createElement('div', {
            className: 'ap-select-dropdown',
            style: widthStyle
        },
            normalized.map(o =>
                React.createElement('div', {
                    key: o.value,
                    className: 'ap-select-item' + (String(o.value) === String(value) ? ' selected' : ''),
                    onMouseDown: (e) => handleItem(o.value, e)
                }, o.label)
            )
        )
    );
}

// --- DOM Factory (for imperative infoBar usage) ---
// Returns a container element that renders an APSelect via React.
// APSelect.create({ value, options, onChange, className })
// Returns { element, update(props) } — call update() to change value/options.

APSelect.create = function({ value, options, onChange, className }) {
    const container = document.createElement('div');
    container.style.display = 'inline-block';
    let currentProps = { value, options, onChange, className };

    function render() {
        ReactDOM.render(
            React.createElement(APSelect, currentProps),
            container
        );
    }

    render();

    return {
        element: container,
        update(newProps) {
            Object.assign(currentProps, newProps);
            render();
        }
    };
};
