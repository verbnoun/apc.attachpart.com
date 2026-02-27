import { describe, it, expect } from 'vitest';

describe('buildModuleState', () => {
    it('returns empty state for null topology', () => {
        const result = buildModuleState(null);
        expect(result.allModules.size).toBe(0);
        expect(result.groups.length).toBe(0);
        expect(result.modSourceIds.size).toBe(0);
    });

    it('returns empty state for topology without groups', () => {
        const result = buildModuleState({});
        expect(result.allModules.size).toBe(0);
    });

    it('builds modules from groups', () => {
        const topology = {
            groups: [{
                id: 'oscillators',
                name: 'Oscillators',
                color: '#FF0000',
                modules: [
                    { id: 'OSC1', name: 'Oscillator 1' },
                    { id: 'OSC2', name: 'Oscillator 2' }
                ]
            }]
        };

        const result = buildModuleState(topology);
        expect(result.allModules.size).toBe(2);
        expect(result.allModules.get('OSC1').name).toBe('Oscillator 1');
        expect(result.allModules.get('OSC1').groupColor).toBe('#FF0000');
    });

    it('annotates chain membership', () => {
        const topology = {
            groups: [{
                id: 'g1',
                name: 'G1',
                modules: [
                    { id: 'A', name: 'A' },
                    { id: 'B', name: 'B' },
                    { id: 'C', name: 'C' }
                ]
            }],
            chains: [{ stages: [['A'], ['B']] }]
        };

        const result = buildModuleState(topology);
        expect(result.allModules.get('A').isChainMember).toBe(true);
        expect(result.allModules.get('B').isChainMember).toBe(true);
        expect(result.allModules.get('C').isChainMember).toBe(false);
    });

    it('annotates mod source membership', () => {
        const topology = {
            groups: [{
                id: 'g1',
                name: 'G1',
                modules: [
                    { id: 'VELOCITY', name: 'Velocity' },
                    { id: 'OSC1', name: 'Osc' }
                ]
            }],
            mod_targets: {
                VELOCITY: ['CARRIER_LEVEL', 'MOD_DEPTH']
            }
        };

        const result = buildModuleState(topology);
        expect(result.allModules.get('VELOCITY').isModSource).toBe(true);
        expect(result.allModules.get('OSC1').isModSource).toBe(false);
        expect(result.modSourceIds.has('VELOCITY')).toBe(true);
    });

    it('handles fixed groups', () => {
        const topology = {
            groups: [{
                id: 'g1',
                name: 'G1',
                fixed: true,
                modules: [{ id: 'A', name: 'A' }]
            }]
        };

        const result = buildModuleState(topology);
        expect(result.allModules.get('A').fixed).toBe(true);
    });

    it('defaults color to #888', () => {
        const topology = {
            groups: [{
                id: 'g1',
                name: 'G1',
                modules: [{ id: 'A', name: 'A' }]
            }]
        };

        const result = buildModuleState(topology);
        expect(result.allModules.get('A').groupColor).toBe('#888');
    });
});

describe('canSourceModulateParam', () => {
    const topology = {
        mod_targets: {
            VELOCITY: ['CARRIER_LEVEL', 'MOD_DEPTH'],
            PRESSURE: ['FILTER_FREQUENCY']
        }
    };

    it('returns true when source can modulate param', () => {
        expect(canSourceModulateParam(topology, 'VELOCITY', 'CARRIER_LEVEL')).toBe(true);
    });

    it('returns false when source cannot modulate param', () => {
        expect(canSourceModulateParam(topology, 'VELOCITY', 'FILTER_FREQUENCY')).toBe(false);
    });

    it('returns false for unknown source', () => {
        expect(canSourceModulateParam(topology, 'UNKNOWN', 'CARRIER_LEVEL')).toBe(false);
    });

    it('handles null topology', () => {
        expect(canSourceModulateParam(null, 'VELOCITY', 'CARRIER_LEVEL')).toBe(false);
    });
});

describe('findModuleDef', () => {
    it('finds module by ID', () => {
        const moduleState = buildModuleState({
            groups: [{
                id: 'g1', name: 'G1',
                modules: [{ id: 'OSC1', name: 'Oscillator' }]
            }]
        });

        const mod = findModuleDef('OSC1', moduleState);
        expect(mod.name).toBe('Oscillator');
    });

    it('returns null for unknown module', () => {
        const moduleState = buildModuleState({
            groups: [{ id: 'g1', name: 'G1', modules: [] }]
        });
        expect(findModuleDef('UNKNOWN', moduleState)).toBeNull();
    });

    it('returns null for null moduleState', () => {
        expect(findModuleDef('OSC1', null)).toBeNull();
    });
});

describe('findAmountParamsForTarget', () => {
    it('finds amount params matching target', () => {
        const moduleData = {
            CARRIER_LEVEL: { initial: 0.7, range: [0, 1] },
            CARRIER_LEVEL_VELOCITY_AMOUNT: { initial: 0.5, range: [-1, 1] },
            CARRIER_LEVEL_PRESSURE_AMOUNT: { initial: 0.3, range: [-1, 1] }
        };

        const amounts = findAmountParamsForTarget(
            moduleData,
            'CARRIER_LEVEL',
            new Set(['VELOCITY', 'PRESSURE'])
        );

        expect(amounts.length).toBe(2);
        expect(amounts.find(a => a.source === 'VELOCITY').value).toBe(0.5);
        expect(amounts.find(a => a.source === 'PRESSURE').value).toBe(0.3);
    });

    it('returns empty for no matches', () => {
        const moduleData = { CARRIER_LEVEL: { initial: 0.7 } };
        const amounts = findAmountParamsForTarget(
            moduleData,
            'CARRIER_LEVEL',
            new Set(['VELOCITY'])
        );
        expect(amounts.length).toBe(0);
    });

    it('handles null module data', () => {
        expect(findAmountParamsForTarget(null, 'X', new Set())).toEqual([]);
    });

    it('handles plain number values', () => {
        const moduleData = {
            PARAM_VELOCITY_AMOUNT: 0.8
        };
        const amounts = findAmountParamsForTarget(
            moduleData,
            'PARAM',
            new Set(['VELOCITY'])
        );
        expect(amounts[0].value).toBe(0.8);
    });
});

describe('calculateDeletionImpact', () => {
    it('identifies routes from deleted module', () => {
        const connections = [
            { from: 'VELOCITY', toModule: 'CARRIER', toParam: 'CARRIER_LEVEL', amount: 0.5 }
        ];

        const impact = calculateDeletionImpact({}, 'VELOCITY', connections);
        expect(impact.routesRemoved.length).toBe(1);
        expect(impact.routesRemoved[0].source).toBe('VELOCITY');
    });

    it('identifies routes to deleted module', () => {
        const connections = [
            { from: 'VELOCITY', toModule: 'CARRIER', toParam: 'CARRIER_LEVEL', amount: 0.5 }
        ];

        const impact = calculateDeletionImpact({}, 'CARRIER', connections);
        expect(impact.routesRemoved.length).toBe(1);
    });

    it('detects orphaned sources', () => {
        const connections = [
            { from: 'VELOCITY', toModule: 'TARGET', toParam: 'PARAM', amount: 0.5 }
        ];

        // Deleting TARGET orphans VELOCITY (its only target)
        const impact = calculateDeletionImpact({}, 'TARGET', connections);
        expect(impact.orphanedModules).toContain('VELOCITY');
    });

    it('does not orphan source with remaining targets', () => {
        const connections = [
            { from: 'VELOCITY', toModule: 'TARGET1', toParam: 'P1', amount: 0.5 },
            { from: 'VELOCITY', toModule: 'TARGET2', toParam: 'P2', amount: 0.3 }
        ];

        const impact = calculateDeletionImpact({}, 'TARGET1', connections);
        expect(impact.orphanedModules).not.toContain('VELOCITY');
    });

    it('handles null inputs', () => {
        const impact = calculateDeletionImpact(null, 'X', null);
        expect(impact.routesRemoved.length).toBe(0);
        expect(impact.orphanedModules.length).toBe(0);
    });
});
