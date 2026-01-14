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
            onClose = null
        } = options;

        // Don't create duplicate windows
        if (this.windows.has(id)) {
            this.focus(id);
            return this.windows.get(id).element;
        }

        // Create window structure
        const win = document.createElement('div');
        win.className = 'ap-window';
        win.id = `window-${id}`;
        win.style.left = `${x}px`;
        win.style.top = `${y}px`;
        win.style.width = `${width}px`;
        win.style.height = `${height}px`;
        win.style.zIndex = this.nextZIndex++;

        // Title bar
        const titleBar = document.createElement('div');
        titleBar.className = 'ap-window-titlebar';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ap-window-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.close(id);
        };

        const titleText = document.createElement('span');
        titleText.className = 'ap-window-title';
        titleText.textContent = title;

        titleBar.appendChild(closeBtn);
        titleBar.appendChild(titleText);

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

        // Dimensions display (for sizing reference)
        const dimsDisplay = document.createElement('div');
        dimsDisplay.className = 'ap-window-dims';
        dimsDisplay.textContent = `${width}×${height}`;

        win.appendChild(titleBar);
        win.appendChild(contentArea);
        win.appendChild(dimsDisplay);
        win.appendChild(resizeHandle);

        // Add to workspace
        const workspace = document.getElementById('workspace');
        if (workspace) {
            workspace.appendChild(win);
        } else {
            document.body.appendChild(win);
        }

        // Store window info
        this.windows.set(id, {
            element: win,
            titleBar,
            contentArea,
            dimsDisplay,
            onClose
        });

        // Setup interactions
        this._setupDrag(id, win, titleBar);
        this._setupResize(id, win, resizeHandle);
        this._setupFocus(id, win);

        this.focus(id);
        return win;
    },

    /**
     * Close a window
     */
    close(id) {
        const windowInfo = this.windows.get(id);
        if (!windowInfo) return;

        if (windowInfo.onClose) {
            windowInfo.onClose();
        }

        windowInfo.element.remove();
        this.windows.delete(id);

        if (this.activeWindowId === id) {
            this.activeWindowId = null;
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
            isDragging = false;
        });
    },

    // Private: setup resize behavior
    _setupResize(id, win, handle) {
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
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newWidth = Math.max(200, startWidth + dx);
            const newHeight = Math.max(150, startHeight + dy);
            win.style.width = `${newWidth}px`;
            win.style.height = `${newHeight}px`;

            // Update dimensions display
            const windowInfo = this.windows.get(id);
            if (windowInfo && windowInfo.dimsDisplay) {
                windowInfo.dimsDisplay.textContent = `${newWidth}×${newHeight}`;
            }
        });

        document.addEventListener('mouseup', () => {
            isResizing = false;
        });
    },

    // Private: setup focus on click
    _setupFocus(id, win) {
        win.addEventListener('mousedown', () => {
            this.focus(id);
        });
    }
};
