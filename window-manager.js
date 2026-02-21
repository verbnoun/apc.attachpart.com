/**
 * Window Manager - Creates and manages draggable, resizable windows
 *
 * Window chrome:
 * - Title bar with window name (draggable)
 * - Close button: upper LEFT corner
 * - Resize handle: lower RIGHT corner
 * - Scrollbars when content overflows
 * - NO: minimize, maximize, fullscreen
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
     *   x: number - initial x position
     *   y: number - initial y position
     *   width: number - initial width
     *   height: number - initial height
     *   content: HTMLElement | string - window content
     *   onClose: () => void - called when window closes
     *   hScroll: boolean - horizontal scrollbar + horizontal resize (default false)
     *   vScroll: boolean - vertical scrollbar + vertical resize (default false)
     *   padding: boolean - content area has 16px padding (default true)
     *   infoBar: { left, center, right } | null - optional info bar below title
     *   onInfoBarClick: (slot) => void - called when info bar slot is clicked
     * @returns {HTMLElement} The window element
     */
    create(options) {
        const {
            id,
            title = 'Window',
            x = 100,
            y = 100,
            width = 400,
            height = 300,
            content = '',
            onClose = null,
            theme = null,
            hScroll = false,
            vScroll = false,
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
            return this.windows.get(id).element;
        }

        // Derive resize behavior from scroll properties
        const resizable = hScroll || vScroll;

        // Create window structure
        const win = document.createElement('div');
        let cls = 'ap-window';
        if (hScroll && vScroll) cls += ' ap-scroll-both';
        else if (hScroll) cls += ' ap-scroll-h';
        else if (vScroll) cls += ' ap-scroll-v';
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
                // Don't add 'clickable' class here — toggled dynamically via setInfoBarClickable
                leftSlot.addEventListener('click', () => onInfoBarClick('left'));
                centerSlot.addEventListener('click', () => onInfoBarClick('center'));
                rightSlot.addEventListener('click', () => onInfoBarClick('right'));
            }
        }

        // Content area
        const contentArea = document.createElement('div');
        contentArea.className = 'ap-window-content';
        if (typeof content === 'string') {
            contentArea.innerHTML = content;
        } else if (content instanceof HTMLElement) {
            contentArea.appendChild(content);
        }

        // Resize handle
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'ap-window-resize';

        win.appendChild(titleBar);
        if (infoBarEl) win.appendChild(infoBarEl);
        win.appendChild(contentArea);
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

        // Store window info
        const observers = [];
        this.windows.set(id, {
            element: win,
            titleBar,
            contentArea,
            infoBarEl,
            onInfoBarClick,
            onClose,
            constraints: { minWidth, minHeight, maxWidth, maxHeight },
            observers
        });

        // Setup interactions
        this._setupDrag(id, win, titleBar);
        if (resizable) {
            const resizeDir = (hScroll && vScroll) ? 'both' : hScroll ? 'horizontal' : 'vertical';
            this._setupResize(id, win, resizeHandle, resizeDir);
        }
        this._setupFocus(id, win);

        // Overflow detection: toggle ap-overflows-v / ap-overflows-h classes
        // so CSS can hide scrollbar thumbs when content fits
        if (hScroll || vScroll) {
            let pending = false;
            const checkOverflow = () => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    // Tolerance for subpixel rounding (getBoundingClientRect
                    // returns fractional values but scrollHeight/clientHeight are integers)
                    const TOLERANCE = 2;
                    if (vScroll) {
                        win.classList.toggle('ap-overflows-v',
                            contentArea.scrollHeight - contentArea.clientHeight > TOLERANCE);
                    }
                    if (hScroll) {
                        win.classList.toggle('ap-overflows-h',
                            contentArea.scrollWidth - contentArea.clientWidth > TOLERANCE);
                    }
                });
            };
            const resizeObs = new ResizeObserver(checkOverflow);
            resizeObs.observe(contentArea);
            observers.push(resizeObs);
            const mutationObs = new MutationObserver(checkOverflow);
            mutationObs.observe(contentArea, { childList: true, subtree: true, characterData: true });
            observers.push(mutationObs);
            checkOverflow();
        }

        this.focus(id);
        return win;
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
