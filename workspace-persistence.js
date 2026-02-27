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
    TOOL_WINDOWS: ['log-window', 'expression-pad', 'routing-window'],

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
     * Get config section windows that were open for a device
     * @param {string} portName
     * @returns {string[]} section names (e.g. ['curves', 'dials'])
     */
    getOpenConfigWindows(portName) {
        const state = this._load();
        const sections = [];
        for (const section of ['curves', 'dials', 'pedal', 'screen']) {
            const windowId = `config-${section}-${portName}`;
            if (state.windows[windowId]?.wasOpen === true) {
                sections.push(section);
            }
        }
        return sections;
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

    // Route persistence
    saveRoutes(routes) {
        try {
            localStorage.setItem('attachpart-routes', JSON.stringify(routes));
        } catch (e) { /* ignore */ }
    },

    loadRoutes() {
        try {
            const json = localStorage.getItem('attachpart-routes');
            return json ? JSON.parse(json) : [];
        } catch (e) { return []; }
    },

    saveConfigPairs(configPairs) {
        try {
            localStorage.setItem('attachpart-config-pairs', JSON.stringify(configPairs));
        } catch (e) { /* ignore */ }
    },

    loadConfigPairs() {
        try {
            const json = localStorage.getItem('attachpart-config-pairs');
            return json ? JSON.parse(json) : {};
        } catch (e) { return {}; }
    },

    // Node position persistence
    POSITIONS_KEY: 'attachpart-node-positions',

    saveNodePositions(deviceKey, patchIndex, positions) {
        try {
            const key = `${deviceKey}-${patchIndex}`;
            const all = this._loadPositions();
            all[key] = positions;
            localStorage.setItem(this.POSITIONS_KEY, JSON.stringify(all));
        } catch (e) { /* ignore */ }
    },

    loadNodePositions(deviceKey, patchIndex) {
        try {
            const key = `${deviceKey}-${patchIndex}`;
            const all = this._loadPositions();
            return all[key] || null;
        } catch (e) { return null; }
    },

    _loadPositions() {
        try {
            const json = localStorage.getItem(this.POSITIONS_KEY);
            return json ? JSON.parse(json) : {};
        } catch (e) { return {}; }
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
