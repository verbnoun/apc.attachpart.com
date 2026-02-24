/**
 * Window Manager - Creates and manages draggable, resizable windows
 *
 * Window chrome:
 * - Title bar with window name (draggable)
 * - Close button: upper LEFT corner
 * - Resize handle: lower RIGHT corner
 * - Columns with constraint-driven scrolling
 * - NO: minimize, maximize, fullscreen
 *
 * Column model:
 * Every window has one or more columns. Each column is a scroll container.
 * Scroll behavior emerges from constraints — never declared separately.
 * - Fixed column (width/height set, no flex): overflow hidden, no scroll
 * - Flexible column (flex): resizes with window, scroll when content overflows
 */

const WindowManager = {
    windows: new Map(),
    nextZIndex: 100,
    activeWindowId: null,

    // Persistence callbacks
    onGeometryChange: null,  // (windowId, { x, y, width, height }) => void
    onWindowClose: null,     // (windowId) => void
    onWindowFocus: null,     // (windowId, title) => void

    /**
     * Create a new window
     * @param {Object} options
     *   id: string - unique identifier
     *   title: string - window title
     *   x/y/width/height: number - geometry
     *   content: HTMLElement | string - window content (single-column shorthand)
     *   columns: Array<{ id?, width?, flex?, fixed?, scroll? }> - column definitions
     *     - width: fixed pixel width
     *     - flex: flex-grow value (default 1 if no width)
     *     - fixed: true = no scroll at all (overflow hidden)
     *     - scroll: 'v' | 'h' | 'both' | 'none' (default: 'both' for flex columns)
     *   resizable: boolean|string - resize handle: true/'both', 'vertical', 'horizontal', false
     *   padding: boolean - content area has 16px padding (default true)
     *   infoBar: { left, center, right } | null
     *   onInfoBarClick: (slot) => void
     * @returns {{ element: HTMLElement, columns: Object<string, HTMLElement> }}
     */
    create(options) {
        const {
            id,
            title = 'Window',
            x = 100,
            y = 100,
            width = 400,
            height = 300,
            content = null,
            onClose = null,
            theme = null,
            columns: columnsOpt,
            resizable: resizableOpt,
            padding = true,
            minWidth = 250,
            minHeight = 150,
            maxWidth = Infinity,
            maxHeight = Infinity,
            infoBar = null,
            onInfoBarClick = null
        } = options;

        // Don't create duplicate windows
        if (this.windows.has(id)) {
            this.focus(id);
            const existing = this.windows.get(id);
            return { element: existing.element, columns: existing.columnEls };
        }

        // Normalize resizable
        const resizable = resizableOpt !== undefined ? resizableOpt : false;

        // Build column definitions
        // Default: single flex column, scroll both (unless no resizable → no scroll)
        let colDefs;
        if (columnsOpt) {
            colDefs = columnsOpt;
        } else {
            // Single implicit column — scroll based on resizable direction
            const dir = typeof resizable === 'string' ? resizable : resizable ? 'both' : null;
            const scroll = dir === 'both' ? 'both'
                : dir === 'vertical' ? 'v'
                : dir === 'horizontal' ? 'h'
                : 'none';
            colDefs = [{ id: '_default', flex: 1, scroll }];
        }

        // Determine which scroll directions exist across all columns
        const hasAnyVScroll = colDefs.some(c => !c.fixed && (c.scroll || 'both') !== 'h' && (c.scroll || 'both') !== 'none');
        const hasAnyHScroll = colDefs.some(c => !c.fixed && (c.scroll || 'both') !== 'v' && (c.scroll || 'both') !== 'none');

        // Create window structure
        const win = document.createElement('div');
        let cls = 'ap-window';
        // Resizable class for resize handle visibility + cursor
        if (resizable) {
            const dir = typeof resizable === 'string' ? resizable
                : resizable === true ? 'both' : 'both';
            if (dir === 'both') cls += ' ap-resizable-both';
            else if (dir === 'horizontal') cls += ' ap-resizable-h';
            else cls += ' ap-resizable-v';
        }
        // Flush scrollbar classes — remove window border where scrollable columns touch edge
        if (hasAnyVScroll) cls += ' ap-flush-right';
        if (hasAnyHScroll) cls += ' ap-flush-bottom';
        if (!padding) cls += ' ap-no-padding';
        win.className = cls;
        win.id = `window-${id}`;
        win.style.left = `${x}px`;
        win.style.top = `${y}px`;
        win.style.width = `${Math.min(maxWidth, Math.max(minWidth, width))}px`;
        win.style.height = `${Math.min(maxHeight, Math.max(minHeight, height))}px`;
        win.style.zIndex = this.nextZIndex++;
        if (theme) win.dataset.theme = theme;

        // Title bar
        const titleBar = document.createElement('div');
        titleBar.className = 'ap-window-titlebar';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ap-window-close';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.close(id);
        };

        const stripesLeft = document.createElement('div');
        stripesLeft.className = 'ap-window-stripes';

        const titleText = document.createElement('span');
        titleText.className = 'ap-window-title';
        titleText.textContent = title;

        const stripesRight = document.createElement('div');
        stripesRight.className = 'ap-window-stripes';

        titleBar.appendChild(closeBtn);
        titleBar.appendChild(stripesLeft);
        titleBar.appendChild(titleText);
        titleBar.appendChild(stripesRight);

        // Info bar (optional — System 7 info pane between title bar and content)
        let infoBarEl = null;
        if (infoBar) {
            infoBarEl = document.createElement('div');
            infoBarEl.className = 'ap-window-infobar';
            const leftSlot = document.createElement('span');
            leftSlot.className = 'ap-infobar-left';
            this._setSlotContent(leftSlot, infoBar.left);
            const centerSlot = document.createElement('span');
            centerSlot.className = 'ap-infobar-center';
            this._setSlotContent(centerSlot, infoBar.center);
            const rightSlot = document.createElement('span');
            rightSlot.className = 'ap-infobar-right';
            this._setSlotContent(rightSlot, infoBar.right);
            infoBarEl.appendChild(leftSlot);
            infoBarEl.appendChild(centerSlot);
            infoBarEl.appendChild(rightSlot);

            if (onInfoBarClick) {
                leftSlot.addEventListener('click', () => onInfoBarClick('left'));
                centerSlot.addEventListener('click', () => onInfoBarClick('center'));
                rightSlot.addEventListener('click', () => onInfoBarClick('right'));
            }
        }

        // Columns container
        const columnsContainer = document.createElement('div');
        columnsContainer.className = 'ap-window-columns';

        const columnEls = {};
        const observers = [];

        colDefs.forEach((colDef, i) => {
            const colId = colDef.id || `col-${i}`;
            const col = document.createElement('div');
            col.className = 'ap-window-col';

            // Fixed vs flexible
            if (colDef.width !== undefined && !colDef.flex) {
                col.style.width = `${colDef.width}px`;
                col.style.flexShrink = '0';
                col.style.flexGrow = '0';
            } else {
                col.style.flex = `${colDef.flex || 1}`;
                col.style.minWidth = '0';
            }

            // Scroll behavior
            const scroll = colDef.fixed ? 'none' : (colDef.scroll || (colDef.width && !colDef.flex ? 'v' : 'both'));
            if (scroll === 'none' || colDef.fixed) {
                col.classList.add('ap-col-fixed');
            } else if (scroll === 'v') {
                col.classList.add('ap-col-scroll-v');
            } else if (scroll === 'h') {
                col.classList.add('ap-col-scroll-h');
            } else {
                col.classList.add('ap-col-scroll-both');
            }

            // Mark last scrollable column for flush border
            // (will refine after loop)

            // Column separator (between columns, not on first)
            if (i > 0) {
                col.classList.add('ap-col-border-left');
            }

            columnsContainer.appendChild(col);
            columnEls[colId] = col;

            // Per-column overflow detection
            if (scroll !== 'none' && !colDef.fixed) {
                let pending = false;
                const checkOverflow = () => {
                    if (pending) return;
                    pending = true;
                    requestAnimationFrame(() => {
                        pending = false;
                        const TOLERANCE = 2;
                        if (scroll === 'v' || scroll === 'both') {
                            col.classList.toggle('ap-overflows-v',
                                col.scrollHeight - col.clientHeight > TOLERANCE);
                        }
                        if (scroll === 'h' || scroll === 'both') {
                            col.classList.toggle('ap-overflows-h',
                                col.scrollWidth - col.clientWidth > TOLERANCE);
                        }
                    });
                };
                const resizeObs = new ResizeObserver(checkOverflow);
                resizeObs.observe(col);
                observers.push(resizeObs);
                const mutationObs = new MutationObserver(checkOverflow);
                mutationObs.observe(col, { childList: true, subtree: true, characterData: true });
                observers.push(mutationObs);
                checkOverflow();
            }
        });

        // If single column with content provided, populate it
        if (content) {
            const firstCol = Object.values(columnEls)[0];
            if (typeof content === 'string') {
                firstCol.innerHTML = content;
            } else if (content instanceof HTMLElement) {
                firstCol.appendChild(content);
            }
        }

        // Resize handle
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'ap-window-resize';

        win.appendChild(titleBar);
        if (infoBarEl) win.appendChild(infoBarEl);
        win.appendChild(columnsContainer);
        win.appendChild(resizeHandle);

        // Add to workspace
        const workspace = document.getElementById('workspace');
        if (workspace) {
            workspace.appendChild(win);
        } else {
            document.body.appendChild(win);
        }

        // Lock info bar height after initial layout so dynamic content changes don't cause jumps
        if (infoBarEl) {
            requestAnimationFrame(() => {
                infoBarEl.style.height = `${infoBarEl.offsetHeight}px`;
            });
        }

        // Store window info — contentArea points to first column for backward compat
        const firstColEl = Object.values(columnEls)[0];
        this.windows.set(id, {
            element: win,
            titleBar,
            contentArea: firstColEl,
            columnEls,
            columnsContainer,
            infoBarEl,
            onInfoBarClick,
            onClose,
            constraints: { minWidth, minHeight, maxWidth, maxHeight },
            observers
        });

        // Setup interactions
        this._setupDrag(id, win, titleBar);
        if (resizable) {
            let resizeDir;
            if (typeof resizable === 'string') {
                resizeDir = resizable;
            } else {
                resizeDir = 'both';
            }
            this._setupResize(id, win, resizeHandle, resizeDir);
        }
        this._setupFocus(id, win);

        this.focus(id);
        return { element: win, columns: columnEls };
    },

    /**
     * Close a window
     * @param {string} id - Window ID
     * @param {boolean} preserveState - If true, don't notify onWindowClose (used for device disconnect)
     */
    close(id, preserveState = false) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo) return;

        // Notify persistence (unless preserving state for device disconnect)
        if (this.onWindowClose && !preserveState) {
            this.onWindowClose(id);
        }

        if (windowInfo.onClose) {
            windowInfo.onClose();
        }

        if (windowInfo.observers) {
            windowInfo.observers.forEach(obs => obs.disconnect());
        }
        windowInfo.element.remove();
        this.windows.delete(id);

        if (this.activeWindowId === id) {
            this.activeWindowId = null;
            if (this.onWindowFocus) {
                this.onWindowFocus(null, null);
            }
        }
    },

    /**
     * Focus a window (bring to front)
     */
    focus(id) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo) return;

        // Remove active class from all windows
        this.windows.forEach((info) => {
            info.element.classList.remove('ap-window-active');
        });

        // Add active class and bring to front
        windowInfo.element.classList.add('ap-window-active');
        windowInfo.element.style.zIndex = this.nextZIndex++;
        this.activeWindowId = id;

        // Notify menu bar of focused window
        if (this.onWindowFocus) {
            const titleEl = windowInfo.titleBar.querySelector('.ap-window-title');
            this.onWindowFocus(id, titleEl?.textContent || id);
        }
    },

    /**
     * Get window content area (for React rendering)
     */
    getContentArea(id) {
        const windowInfo = this.windows.get(id);
        return windowInfo ? windowInfo.contentArea : null;
    },

    /**
     * Check if window exists
     */
    exists(id) {
        return this.windows.has(id);
    },

    /**
     * Update window title
     */
    setTitle(id, title) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo) return;
        const titleEl = windowInfo.titleBar.querySelector('.ap-window-title');
        if (titleEl) titleEl.textContent = title;
    },

    /**
     * Update resize constraints for a window
     * @param {string} id - Window ID
     * @param {Object} constraints - { minWidth, minHeight, maxWidth, maxHeight }
     */
    setConstraints(id, constraints) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo) return;
        Object.assign(windowInfo.constraints, constraints);
        // Clamp current size to new constraints
        const win = windowInfo.element;
        const w = win.offsetWidth;
        const h = win.offsetHeight;
        const c = windowInfo.constraints;
        const newW = Math.min(c.maxWidth || Infinity, Math.max(c.minWidth || 250, w));
        const newH = Math.min(c.maxHeight || Infinity, Math.max(c.minHeight || 150, h));
        if (newW !== w) win.style.width = `${newW}px`;
        if (newH !== h) win.style.height = `${newH}px`;
    },

    /**
     * Update info bar content
     * @param {string} id - Window ID
     * @param {Object} content - { left, center, right } — string or HTMLElement values
     */
    setInfoBar(id, content) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo || !windowInfo.infoBarEl) return;
        const bar = windowInfo.infoBarEl;
        if (content.left !== undefined) {
            this._setSlotContent(bar.querySelector('.ap-infobar-left'), content.left);
        }
        if (content.center !== undefined) {
            this._setSlotContent(bar.querySelector('.ap-infobar-center'), content.center);
        }
        if (content.right !== undefined) {
            this._setSlotContent(bar.querySelector('.ap-infobar-right'), content.right);
        }
    },

    // Private: set slot content (string or HTMLElement)
    _setSlotContent(slot, value) {
        if (!slot) return;
        if (value instanceof HTMLElement) {
            slot.textContent = '';
            slot.appendChild(value);
        } else {
            // Remove any child elements, set text
            while (slot.firstChild) slot.removeChild(slot.firstChild);
            slot.textContent = value || '';
        }
    },

    /**
     * Toggle clickable affordance on info bar
     * @param {string} id - Window ID
     * @param {boolean} clickable - Whether right slot should appear clickable
     */
    setInfoBarClickable(id, clickable) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo || !windowInfo.infoBarEl) return;
        windowInfo.infoBarEl.classList.toggle('clickable', clickable);
    },

    // Private: setup drag behavior
    _setupDrag(id, win, titleBar) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        titleBar.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('ap-window-close')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = win.offsetLeft;
            startTop = win.offsetTop;
            this.focus(id);
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            win.style.left = `${startLeft + dx}px`;
            win.style.top = `${startTop + dy}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                // Notify persistence of geometry change
                if (this.onGeometryChange) {
                    this.onGeometryChange(id, {
                        x: win.offsetLeft,
                        y: win.offsetTop,
                        width: win.offsetWidth,
                        height: win.offsetHeight
                    });
                }
            }
        });
    },

    // Private: setup resize behavior
    _setupResize(id, win, handle, resizeDir = 'both') {
        let isResizing = false;
        let startX, startY, startWidth, startHeight;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = win.offsetWidth;
            startHeight = win.offsetHeight;
            this.focus(id);
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const c = this.windows.get(id)?.constraints || {};
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (resizeDir !== 'vertical') {
                const w = Math.min(c.maxWidth || Infinity, Math.max(c.minWidth || 250, startWidth + dx));
                win.style.width = `${w}px`;
            }
            if (resizeDir !== 'horizontal') {
                const h = Math.min(c.maxHeight || Infinity, Math.max(c.minHeight || 150, startHeight + dy));
                win.style.height = `${h}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                // Notify persistence of geometry change
                if (this.onGeometryChange) {
                    this.onGeometryChange(id, {
                        x: win.offsetLeft,
                        y: win.offsetTop,
                        width: win.offsetWidth,
                        height: win.offsetHeight
                    });
                }
            }
        });
    },

    // Private: setup focus on click
    _setupFocus(id, win) {
        win.addEventListener('mousedown', () => {
            this.focus(id);
        });
    }
};
