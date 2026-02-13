/**
 * Workspace Persistence - Saves and restores window layout to localStorage
 *
 * Storage format:
 * {
 *   windows: {
 *     'log-window': { x, y, width, height, wasOpen },
 *     'config-Bartleby MPE': { x, y, width, height, wasOpen },
 *     ...
 *   }
 * }
 */

const WorkspacePersistence = {
    STORAGE_KEY: 'attachpart-workspace',

    // Tool windows (always available, no device dependency)
    TOOL_WINDOWS: ['log-window', 'expression-pad'],

    /**
     * Get stored state for a window
     * @param {string} windowId
     * @returns {Object|null} { x, y, width, height, wasOpen }
     */
    getWindowState(windowId) {
        const state = this._load();
        return state.windows[windowId] || null;
    },

    /**
     * Save window geometry (position + size)
     * @param {string} windowId
     * @param {Object} geometry { x, y, width, height }
     */
    saveGeometry(windowId, geometry) {
        const state = this._load();
        if (!state.windows[windowId]) {
            state.windows[windowId] = { wasOpen: true };
        }
        state.windows[windowId].x = geometry.x;
        state.windows[windowId].y = geometry.y;
        state.windows[windowId].width = geometry.width;
        state.windows[windowId].height = geometry.height;
        this._save(state);
    },

    /**
     * Mark window as open/closed
     * @param {string} windowId
     * @param {boolean} wasOpen
     */
    setWasOpen(windowId, wasOpen) {
        const state = this._load();
        if (!state.windows[windowId]) {
            state.windows[windowId] = {};
        }
        state.windows[windowId].wasOpen = wasOpen;
        this._save(state);
    },

    /**
     * Check if a device app window was open
     * @param {string} portName
     * @returns {boolean}
     */
    wasDeviceWindowOpen(portName) {
        const state = this._load();
        return state.windows[`device-${portName}`]?.wasOpen === true;
    },

    /**
     * Get all tool windows that were open
     * @returns {string[]}
     */
    getOpenToolWindows() {
        const state = this._load();
        return this.TOOL_WINDOWS.filter(windowId =>
            state.windows[windowId]?.wasOpen === true
        );
    },

    // Private: load state from localStorage
    _load() {
        try {
            const json = localStorage.getItem(this.STORAGE_KEY);
            if (json) {
                const state = JSON.parse(json);
                if (state && typeof state.windows === 'object') {
                    return state;
                }
            }
        } catch (e) {
            console.warn('WorkspacePersistence: Failed to load state', e);
        }
        return { windows: {} };
    },

    // Private: save state to localStorage
    _save(state) {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            console.warn('WorkspacePersistence: Failed to save state', e);
        }
    }
};
