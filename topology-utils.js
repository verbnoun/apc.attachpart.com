/**
 * Topology Utilities - Pure functions for processing synth topology data
 *
 * Extracted from patch-editor.js for testability.
 * These operate on topology objects (groups, chains, mod_targets) sent by the device.
 */

//======================================================================
// TOPOLOGY → MODULE STATE
//======================================================================

/**
 * Build module state from topology
 * Returns { allModules: Map, groups: [], modSourceIds: Set, chains: [] }
 */
function buildModuleState(topology) {
    const empty = { allModules: new Map(), groups: [], modSourceIds: new Set(), chains: [] };
    if (!topology?.groups) return empty;

    const allModules = new Map();
    const groups = topology.groups.map(g => {
        const group = {
            id: g.id,
            name: g.name,
            color: g.color || '#888',
            fixed: g.fixed === true,
            modules: (g.modules || []).map(m => ({
                id: m.id,
                name: m.name,
                groupId: g.id,
                groupColor: g.color || '#888',
                fixed: g.fixed === true
            }))
        };
        group.modules.forEach(m => allModules.set(m.id, m));
        return group;
    });

    const modSourceIds = new Set(Object.keys(topology.mod_targets || {}));
    const chains = topology.chains || [];

    // Track which modules participate in chains
    const chainModuleIds = new Set();
    chains.forEach(chain => {
        (chain.stages || []).forEach(stage => {
            stage.forEach(id => chainModuleIds.add(id));
        });
    });

    // Annotate modules with chain/mod membership
    allModules.forEach((mod, id) => {
        mod.isChainMember = chainModuleIds.has(id);
        mod.isModSource = modSourceIds.has(id);
    });

    return { allModules, groups, modSourceIds, chains, chainModuleIds };
}

//======================================================================
// HELPER FUNCTIONS
//======================================================================

/**
 * Check if a modulation source can target a specific parameter
 * Uses topology.mod_targets (static data from device)
 */
function canSourceModulateParam(topology, sourceId, paramKey) {
    const targets = topology?.mod_targets?.[sourceId] || [];
    return targets.includes(paramKey);
}

/**
 * Find a module definition by ID
 */
function findModuleDef(moduleId, moduleState) {
    return moduleState?.allModules?.get(moduleId) || null;
}

/**
 * Find all AMOUNT params for a given target parameter
 * Returns array of { source, key, value, min, max }
 */
function findAmountParamsForTarget(moduleData, targetParamKey, modSourceIds) {
    if (!moduleData) return [];
    const amounts = [];
    const sources = modSourceIds ? Array.from(modSourceIds) : [];

    sources.forEach(source => {
        const amountKey = `${targetParamKey}_${source}_AMOUNT`;
        const amountData = moduleData[amountKey];
        if (amountData !== undefined) {
            amounts.push({
                source,
                key: amountKey,
                value: typeof amountData === 'object' ? amountData.initial : amountData,
                min: amountData.range?.[0] ?? -1,
                max: amountData.range?.[1] ?? 1,
                uid: amountData.uid,
                cc: amountData.cc ?? -1,
                name: amountData.name || source.replace(/_/g, ' '),
                priority: amountData.priority ?? 999
            });
        }
    });
    return amounts;
}

/**
 * Get absolute range for a parameter from topology params
 * Topology params use module type keys (e.g., "OSC", "FILTER") with param suffix keys.
 * OSC0/1/2 share ranges under "OSC" key.
 * @param {Object} topology - Topology object with params section
 * @param {string} paramKey - Full param key (e.g., "FILTER_FREQUENCY", "OSC0_LEVEL")
 * @returns {{ absMin: number, absMax: number }|null}
 */
function getAbsoluteRange(topology, paramKey) {
    if (!topology?.params) return null;

    // OSC params: "OSC0_LEVEL" → type "OSC", suffix "LEVEL"
    const oscMatch = paramKey.match(/^OSC(\d)_(.+)$/);
    if (oscMatch) {
        const r = topology.params.OSC?.[oscMatch[2]];
        return r ? { absMin: r[0], absMax: r[1] } : null;
    }

    // Others: "FILTER_FREQUENCY" → type "FILTER", suffix "FREQUENCY"
    for (const [type, params] of Object.entries(topology.params)) {
        if (paramKey.startsWith(type + '_')) {
            const suffix = paramKey.substring(type.length + 1);
            if (params[suffix]) return { absMin: params[suffix][0], absMax: params[suffix][1] };
        }
    }

    return null;
}

/**
 * Calculate the impact of deleting a module
 * Returns routes that will be removed and modules that will be orphaned
 */
function calculateDeletionImpact(patch, moduleId, modConnections) {
    const impact = {
        routesRemoved: [],      // Direct routes from/to this module
        orphanedModules: [],    // Modules that will have no connections after
    };

    if (!patch || !modConnections) return impact;

    // Find all routes involving this module
    modConnections.forEach(conn => {
        // Routes FROM this module (it's the source)
        if (conn.from === moduleId) {
            impact.routesRemoved.push({
                source: conn.from,
                target: conn.toModule,
                param: conn.toParam,
                amount: conn.amount
            });
        }
        // Routes TO this module (it has a param being modulated)
        if (conn.toModule === moduleId) {
            impact.routesRemoved.push({
                source: conn.from,
                target: conn.toModule,
                param: conn.toParam,
                amount: conn.amount
            });
        }
    });

    // Check if any sources will be orphaned (lose all their targets)
    const sourcesAffected = new Set(impact.routesRemoved.map(r => r.source));

    sourcesAffected.forEach(sourceId => {
        if (sourceId === moduleId) return; // Skip the module being deleted

        // Count remaining routes for this source after deletion
        const remainingRoutes = modConnections.filter(conn =>
            conn.from === sourceId &&
            conn.toModule !== moduleId // Exclude routes to the deleted module
        );

        if (remainingRoutes.length === 0) {
            impact.orphanedModules.push(sourceId);
        }
    });

    return impact;
}
