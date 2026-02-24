/**
 * Style Guide - Visual catalog of APC design tokens and components
 *
 * Uses only system classes and documented vars.
 * Every text style here must be a combination of tokens
 * already cataloged in the style guide itself.
 */

function StyleGuide() {
    // Layout helpers — flex structure, documented spacing vars only
    const section = {
        marginBottom: 'var(--ap-spacing-lg)',
        borderBottom: '2px solid var(--ap-window-border)',
        paddingBottom: 'var(--ap-spacing-md)',
    };
    const sectionLast = { ...section, borderBottom: 'none' };
    const sectionTitle = {
        fontSize: 'var(--ap-font-size-lg)',
        fontWeight: 'bold',
        marginBottom: 'var(--ap-spacing-sm)',
    };
    const subsection = { marginBottom: 'var(--ap-spacing-sm)' };
    const label = {
        fontSize: 'var(--ap-font-size-sm)',
        color: 'var(--ap-text-secondary)',
        marginBottom: 'var(--ap-spacing-xs)',
    };
    const row = {
        display: 'flex',
        alignItems: 'baseline',
        gap: 'var(--ap-spacing-md)',
        padding: 'var(--ap-spacing-xs) 0',
    };
    const token = {
        fontSize: 'var(--ap-font-size-xs)',
        color: 'var(--ap-text-muted)',
        whiteSpace: 'nowrap',
        minWidth: 160,
        textAlign: 'right',
    };
    const swatchRow = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ap-spacing-sm)' };
    const swatch = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--ap-spacing-xs)',
        minWidth: 72,
    };
    const swatchBox = {
        width: 48,
        height: 32,
        border: '2px solid var(--ap-window-border)',
    };
    const swatchName = {
        fontSize: 'var(--ap-font-size-xs)',
        fontWeight: 'bold',
    };
    const swatchDetail = {
        fontSize: 'var(--ap-font-size-xs)',
        color: 'var(--ap-text-muted)',
    };
    const widgetRow = {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--ap-spacing-md)',
        alignItems: 'flex-start',
    };
    const widget = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--ap-spacing-xs)',
    };

    return (
        <div className="ap-style-guide">

            {/* ============ TYPOGRAPHY ============ */}
            <section style={section}>
                <div style={sectionTitle}>Typography</div>

                <div style={subsection}>
                    <div style={label}>Chrome (pixel-precise, coupled to window graphics)</div>
                    {[
                        { name: 'Window Title', var: '--ap-chrome-title-size', desc: 'Window titles', bold: true },
                        { name: 'Chrome', var: '--ap-chrome-font-size', desc: 'Menubar, tabs, info bar' },
                    ].map(s => (
                        <div key={s.var} style={{ marginBottom: 'var(--ap-spacing-sm)' }}>
                            <div style={{ fontSize: `var(${s.var})`, fontWeight: s.bold ? 'bold' : 'normal' }}>
                                {s.name} — {s.desc}
                            </div>
                            <div style={token}>{s.var}</div>
                        </div>
                    ))}
                </div>

                <div style={subsection}>
                    <div style={label}>Content (freely sizable)</div>
                    {[
                        { name: 'LG', var: '--ap-font-size-lg', desc: 'Emphasis, buttons' },
                        { name: 'MD', var: '--ap-font-size-md', desc: 'Body text, default' },
                        { name: 'SM', var: '--ap-font-size-sm', desc: 'Captions, secondary text' },
                        { name: 'XS', var: '--ap-font-size-xs', desc: 'Fine detail, badges, node body' },
                    ].map(s => (
                        <div key={s.var} style={{ marginBottom: 'var(--ap-spacing-sm)' }}>
                            <div style={{ fontSize: `var(${s.var})` }}>
                                {s.name} — {s.desc}
                            </div>
                            <div style={token}>{s.var}</div>
                        </div>
                    ))}
                </div>

                <div style={subsection}>
                    <div style={label}>Font Families</div>
                    <div style={{ marginBottom: 'var(--ap-spacing-sm)' }}>
                        <div style={{ fontFamily: 'var(--ap-font-family)' }}>
                            Chicago_12 — The quick brown fox jumps over the lazy dog. 0123456789
                        </div>
                        <div style={token}>--ap-font-family</div>
                    </div>
                    <div style={{ marginBottom: 'var(--ap-spacing-sm)' }}>
                        <div style={{ fontFamily: 'var(--ap-font-mono)' }}>
                            Monaco — The quick brown fox jumps over the lazy dog. 0123456789
                        </div>
                        <div style={token}>--ap-font-mono</div>
                    </div>
                </div>
            </section>

            {/* ============ COLORS ============ */}
            <section style={section}>
                <div style={sectionTitle}>Colors</div>

                <div style={subsection}>
                    <div style={label}>Grey Scale</div>
                    <div style={swatchRow}>
                        {[
                            { name: 'Black', var: '--ap-text-primary', hex: '#000000' },
                            { name: 'Dark', var: '--ap-text-secondary', hex: '#555555' },
                            { name: 'Muted', var: '--ap-text-muted', hex: '#808080' },
                            { name: 'Chrome', var: '--ap-bg-tertiary', hex: '#c0c0c0' },
                            { name: 'Light', var: '--ap-bg-secondary', hex: '#eeeeee' },
                            { name: 'White', var: '--ap-bg-primary', hex: '#ffffff' },
                        ].map(c => (
                            <div key={c.hex} style={swatch}>
                                <div style={{ ...swatchBox, background: c.hex }} />
                                <div style={swatchName}>{c.name}</div>
                                <div style={swatchDetail}>{c.hex}</div>
                                <div style={swatchDetail}>{c.var}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Accent Colors (Signal Types)</div>
                    <div style={swatchRow}>
                        {[
                            { name: 'Blue / LFO', var: '--ap-accent-blue', hex: '#209cee' },
                            { name: 'Green / Audio', var: '--ap-accent-green', hex: '#92cc41' },
                            { name: 'Yellow / Mod', var: '--ap-accent-yellow', hex: '#f7d51d' },
                            { name: 'Red / Env', var: '--ap-accent-red', hex: '#e76e55' },
                            { name: 'Purple / Ctrl', var: '--ap-accent-purple', hex: '#92869b' },
                        ].map(c => (
                            <div key={c.hex} style={swatch}>
                                <div style={{ ...swatchBox, background: c.hex }} />
                                <div style={swatchName}>{c.name}</div>
                                <div style={swatchDetail}>{c.hex}</div>
                                <div style={swatchDetail}>{c.var}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Ahab Display Palette</div>
                    <div style={swatchRow}>
                        {[
                            { name: 'BG', var: '--ap-ahab-bg', hex: '#1a2a1a' },
                            { name: 'Text', var: '--ap-ahab-text', hex: '#60d060' },
                            { name: 'Dim', var: '--ap-ahab-text-dim', hex: '#40a040' },
                            { name: 'Border', var: '--ap-ahab-border', hex: '#2a4a2a' },
                            { name: 'Control', var: '--ap-ahab-control-bg', hex: '#0a1a0a' },
                            { name: 'Accent', var: '--ap-ahab-accent', hex: '#e8a030' },
                        ].map(c => (
                            <div key={c.var} style={swatch}>
                                <div style={{ ...swatchBox, background: c.hex }} />
                                <div style={swatchName}>{c.name}</div>
                                <div style={swatchDetail}>{c.var}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>App Themes</div>
                    <div style={swatchRow}>
                        {[
                            { name: 'Controller', accent: '#d4a574', bar: '#e8d5c0' },
                            { name: 'Synth', accent: '#b8a0d2', bar: '#d0c5e0' },
                            { name: 'Tool', accent: '#808080', bar: '#c0c0c0' },
                        ].map(t => (
                            <div key={t.name} style={swatch}>
                                <div style={{ ...swatchBox, background: t.accent }} />
                                <div style={swatchName}>{t.name}</div>
                                <div style={swatchDetail}>accent: {t.accent}</div>
                                <div style={swatchDetail}>bar: {t.bar}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ============ BUTTONS ============ */}
            <section style={section}>
                <div style={sectionTitle}>Buttons</div>

                <div style={subsection}>
                    <div style={label}>Standard Buttons</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <button className="ap-btn">Default</button>
                            <div style={token}>.ap-btn</div>
                        </div>
                        <div style={widget}>
                            <button className="ap-btn ap-btn-small">Small</button>
                            <div style={token}>.ap-btn-small</div>
                        </div>
                        <div style={widget}>
                            <button className="ap-btn" disabled>Disabled</button>
                            <div style={token}>disabled</div>
                        </div>
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Semantic Buttons</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <button className="ap-btn ap-btn-primary">Primary</button>
                            <div style={token}>.ap-btn-primary</div>
                        </div>
                        <div style={widget}>
                            <button className="ap-btn ap-btn-success">Success</button>
                            <div style={token}>.ap-btn-success</div>
                        </div>
                        <div style={widget}>
                            <button className="ap-btn ap-btn-warning">Warning</button>
                            <div style={token}>.ap-btn-warning</div>
                        </div>
                        <div style={widget}>
                            <button className="ap-btn ap-btn-danger">Danger</button>
                            <div style={token}>.ap-btn-danger</div>
                        </div>
                        <div style={widget}>
                            <button className="ap-btn ap-btn-secondary">Secondary</button>
                            <div style={token}>.ap-btn-secondary</div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ============ FORM CONTROLS ============ */}
            <section style={section}>
                <div style={sectionTitle}>Form Controls</div>

                <div style={subsection}>
                    <div style={label}>Inputs</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <input className="ap-input" type="text" defaultValue="Text input" />
                            <div style={token}>.ap-input</div>
                        </div>
                        <div style={widget}>
                            <input className="ap-input" type="number" defaultValue={120} style={{ width: 64 }} />
                            <div style={token}>type=number</div>
                        </div>
                        <div style={widget}>
                            <input className="ap-input" type="text" defaultValue="Disabled" disabled />
                            <div style={token}>disabled</div>
                        </div>
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Selects</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <APSelect
                                value="Option A"
                                options={['Option A', 'Option B', 'Option C']}
                                onChange={() => {}}
                            />
                            <div style={token}>APSelect (default)</div>
                        </div>
                        <div style={widget}>
                            <APSelect
                                className="ap-infobar-select"
                                value="Info Bar Select"
                                options={['Info Bar Select', 'Option B']}
                                onChange={() => {}}
                            />
                            <div style={token}>.ap-infobar-select</div>
                        </div>
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Checkboxes &amp; Radios (system.css)</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <div className="field-row">
                                <input type="checkbox" id="sg-check1" defaultChecked />
                                <label htmlFor="sg-check1">Checked</label>
                            </div>
                            <div style={token}>.field-row + checkbox</div>
                        </div>
                        <div style={widget}>
                            <div className="field-row">
                                <input type="checkbox" id="sg-check2" />
                                <label htmlFor="sg-check2">Unchecked</label>
                            </div>
                        </div>
                        <div style={widget}>
                            <div className="field-row">
                                <input type="radio" name="sg-radio" id="sg-radio1" defaultChecked />
                                <label htmlFor="sg-radio1">Selected</label>
                            </div>
                            <div style={token}>.field-row + radio</div>
                        </div>
                        <div style={widget}>
                            <div className="field-row">
                                <input type="radio" name="sg-radio" id="sg-radio2" />
                                <label htmlFor="sg-radio2">Unselected</label>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ============ TABS ============ */}
            <section style={section}>
                <div style={sectionTitle}>Tabs</div>
                <div style={widgetRow}>
                    <div style={widget}>
                        <div style={{ display: 'flex', gap: 0 }}>
                            <div className="ap-tab active">Active</div>
                            <div className="ap-tab">Inactive</div>
                            <div className="ap-tab">Tab 3</div>
                        </div>
                        <div style={token}>.ap-tab / .ap-tab.active</div>
                    </div>
                </div>
            </section>

            {/* ============ TEXT UTILITIES ============ */}
            <section style={section}>
                <div style={sectionTitle}>Text Utility Classes</div>
                <div style={subsection}>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <span className="ap-text-muted">Muted text</span>
                            <div style={token}>.ap-text-muted</div>
                        </div>
                        <div style={widget}>
                            <span className="ap-text-success">Success text</span>
                            <div style={token}>.ap-text-success</div>
                        </div>
                        <div style={widget}>
                            <span className="ap-text-warning">Warning text</span>
                            <div style={token}>.ap-text-warning</div>
                        </div>
                        <div style={widget}>
                            <span className="ap-text-danger">Danger text</span>
                            <div style={token}>.ap-text-danger</div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ============ SPACING ============ */}
            <section style={section}>
                <div style={sectionTitle}>Spacing Scale</div>
                <div style={subsection}>
                    {[
                        { name: 'XS', var: '--ap-spacing-xs', px: '4px' },
                        { name: 'SM', var: '--ap-spacing-sm', px: '8px' },
                        { name: 'MD', var: '--ap-spacing-md', px: '16px' },
                        { name: 'LG', var: '--ap-spacing-lg', px: '24px' },
                    ].map(s => (
                        <div key={s.name} style={row}>
                            <div style={{
                                height: 12,
                                background: 'var(--ap-accent-blue)',
                                border: '1px solid var(--ap-window-border)',
                                flexShrink: 0,
                                width: s.px,
                            }} />
                            <div style={token}>{s.name} ({s.px}) — {s.var}</div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ============ SCROLLBARS ============ */}
            <section style={section}>
                <div style={sectionTitle}>Scrollbars (system.css native)</div>
                <div style={subsection}>
                    <div style={label}>22px wide, dithered checkerboard track, SVG arrows</div>
                    <div style={{
                        width: 240,
                        height: 100,
                        overflow: 'auto',
                        border: '2px solid var(--ap-window-border)',
                        background: 'var(--ap-bg-primary)',
                    }}>
                        <div style={{
                            padding: 'var(--ap-spacing-xs) var(--ap-spacing-sm)',
                            fontSize: 'var(--ap-font-size-xs)',
                            width: 300,
                        }}>
                            {Array.from({ length: 20 }, (_, i) => (
                                <div key={i}>Scrollable content line {i + 1}</div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* ============ PROGRESS BAR ============ */}
            <section style={section}>
                <div style={sectionTitle}>Progress Bar</div>
                <div style={subsection}>
                    <div style={widgetRow}>
                        <div style={{ ...widget, width: '100%' }}>
                            <div className="ap-progress-bar">
                                <div className="ap-progress-fill" style={{ width: '65%' }}></div>
                            </div>
                            <div style={token}>.ap-progress-bar + .ap-progress-fill</div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ============ PATCH EDITOR NODES ============ */}
            <section style={section}>
                <div style={sectionTitle}>Patch Editor — Node Colors</div>
                <div style={subsection}>
                    <div style={swatchRow}>
                        {[
                            { name: 'Audio (Green)', hex: '#92cc41', type: 'oscillator/filter' },
                            { name: 'Mod (Yellow)', hex: '#f7d51d', type: 'LFO/modulation' },
                            { name: 'Envelope (Red)', hex: '#e76e55', type: 'amp env/mod env' },
                            { name: 'Control (Purple)', hex: '#92869b', type: 'CC/control' },
                            { name: 'Output (Grey)', hex: '#c0c0c0', type: 'master out' },
                        ].map(n => (
                            <div key={n.name} style={swatch}>
                                <div style={{ ...swatchBox, background: n.hex }} />
                                <div style={swatchName}>{n.name}</div>
                                <div style={swatchDetail}>{n.type}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ============ PORTS & WIRES ============ */}
            <section style={section}>
                <div style={sectionTitle}>Ports & Wires</div>

                <div style={subsection}>
                    <div style={label}>Port Variants (.ap-port)</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <div style={{ display: 'flex', gap: 'var(--ap-spacing-sm)', alignItems: 'center' }}>
                                <div className="ap-port" style={{ width: 10, height: 10, border: '2px solid var(--ap-window-border)' }} />
                                <div className="ap-port midi" />
                                <div className="ap-port config" />
                            </div>
                            <div style={token}>base / .midi / .config</div>
                        </div>
                        <div style={widget}>
                            <div style={{ display: 'flex', gap: 'var(--ap-spacing-sm)', alignItems: 'center' }}>
                                <div className="ap-port ap-node-port" />
                                <div className="ap-port-sm ap-node-port-param-in" />
                            </div>
                            <div style={token}>node filled / param-in</div>
                        </div>
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Wire Colors</div>
                    <div style={swatchRow}>
                        {[
                            { name: 'Audio / MIDI', var: '--ap-wire-audio', hex: '#92cc41', style: 'solid' },
                            { name: 'Mod', var: '--ap-wire-mod', hex: '#f7d51d', style: 'dashed' },
                            { name: 'Envelope', var: '--ap-wire-env', hex: '#e76e55', style: 'dashed' },
                            { name: 'LFO', var: '--ap-wire-lfo', hex: '#209cee', style: 'dashed' },
                            { name: 'Control / Config', var: '--ap-wire-control', hex: '#92869b', style: 'dashed' },
                        ].map(w => (
                            <div key={w.var} style={swatch}>
                                <div style={{
                                    width: 48, height: 4, background: w.hex,
                                    borderTop: w.style === 'dashed' ? `2px dashed ${w.hex}` : 'none',
                                    backgroundColor: w.style === 'dashed' ? 'transparent' : w.hex,
                                }} />
                                <div style={swatchName}>{w.name}</div>
                                <div style={swatchDetail}>{w.var}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>Device Box (.ap-device-box)</div>
                    <div style={widgetRow}>
                        <div style={widget}>
                            <div className="ap-device-box">
                                <div className="ap-port midi" />
                                <div className="ap-port config" />
                                Device Name
                            </div>
                            <div style={token}>.ap-device-box + .ap-port</div>
                        </div>
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>CSS Classes</div>
                    <div style={{ fontSize: 'var(--ap-font-size-xs)', color: 'var(--ap-text-secondary)', lineHeight: 1.6 }}>
                        <div><strong>.ap-port</strong> — 10px square port (base size + shape)</div>
                        <div><strong>.ap-port-sm</strong> — 6px small port variant</div>
                        <div><strong>.ap-port.midi / .config</strong> — colored hollow port with hover fill</div>
                        <div><strong>.ap-node-port</strong> — filled black port (patch editor override)</div>
                        <div><strong>.ap-wire-layer</strong> — SVG overlay (absolute, pointer-events: none)</div>
                        <div><strong>.ap-wire-group</strong> — clickable wire &lt;g&gt; with hover thicken</div>
                        <div><strong>.ap-wire-drag</strong> — animated preview wire (dash flow)</div>
                        <div><strong>.ap-device-box</strong> — bordered container for named devices</div>
                        <div><strong>.drop-target</strong> — row highlight during wiring</div>
                    </div>
                </div>

                <div style={subsection}>
                    <div style={label}>JS Primitives (ap-wires.js)</div>
                    <div style={{ fontSize: 'var(--ap-font-size-xs)', color: 'var(--ap-text-secondary)', lineHeight: 1.6 }}>
                        <div><strong>apBezierPath(x1, y1, x2, y2)</strong> — horizontal-stub cubic Bézier path string</div>
                        <div><strong>usePortPositions(containerRef, deps)</strong> — track port centers relative to container</div>
                        <div><strong>useWiring(containerRef)</strong> — wiring state machine (start/cancel, mouse tracking, Escape)</div>
                        <div><strong>&lt;APWireGroup&gt;</strong> — dual-path SVG wire (hit target + visible line)</div>
                        <div><strong>&lt;APPreviewWire&gt;</strong> — animated dashed wire following mouse</div>
                    </div>
                </div>
            </section>

            {/* ============ WINDOW THEMES ============ */}
            <section style={sectionLast}>
                <div style={sectionTitle}>Window Themes (data-theme)</div>
                <div style={subsection}>
                    <div style={label}>Title bar stripe colors per theme</div>
                    <div style={{ display: 'flex', gap: 'var(--ap-spacing-md)' }}>
                        {[
                            { name: 'controller', stripe: '#8a6d4d', bg: '#e8d5c0' },
                            { name: 'synth', stripe: '#6b4d8a', bg: '#d0c5e0' },
                            { name: 'tool (default)', stripe: '#000', bg: '#c0c0c0' },
                        ].map(t => (
                            <div key={t.name} style={swatch}>
                                <div style={{
                                    width: 120,
                                    height: 20,
                                    border: '2px solid var(--ap-window-border)',
                                    background: `repeating-linear-gradient(transparent 0px, transparent 1px, ${t.stripe} 1px, ${t.stripe} 2px)`,
                                    backgroundColor: t.bg,
                                }} />
                                <div style={token}>{t.name}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

        </div>
    );
}

window.StyleGuide = StyleGuide;
