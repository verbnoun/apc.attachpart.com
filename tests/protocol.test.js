import { describe, it, expect } from 'vitest';

describe('commandAllowed', () => {
    it('allows IDENTITY commands regardless of capabilities', () => {
        expect(commandAllowed('get-device-info', [])).toBe(true);
        expect(commandAllowed('get-device-info', [CAPABILITIES.SYNTH])).toBe(true);
    });

    it('allows commands when device has required capability', () => {
        expect(commandAllowed('get-patch', [CAPABILITIES.PATCHES])).toBe(true);
        expect(commandAllowed('update-param', [CAPABILITIES.PARAMS])).toBe(true);
        expect(commandAllowed('get-config', [CAPABILITIES.CONFIG])).toBe(true);
    });

    it('blocks commands when device lacks required capability', () => {
        expect(commandAllowed('get-patch', [CAPABILITIES.CONFIG])).toBe(false);
        expect(commandAllowed('update-param', [CAPABILITIES.PATCHES])).toBe(false);
    });

    it('allows save with PATCHES capability', () => {
        expect(commandAllowed('save', [CAPABILITIES.PATCHES])).toBe(true);
    });

    it('allows save with CONFIG capability', () => {
        expect(commandAllowed('save', [CAPABILITIES.CONFIG])).toBe(true);
    });

    it('blocks save without PATCHES or CONFIG', () => {
        expect(commandAllowed('save', [CAPABILITIES.SYNTH])).toBe(false);
    });

    it('allows unknown commands (handled at device level)', () => {
        expect(commandAllowed('unknown-command', [])).toBe(true);
    });
});

describe('getRequiredCapability', () => {
    it('returns correct capability for patch commands', () => {
        expect(getRequiredCapability('get-patch')).toBe(CAPABILITIES.PATCHES);
        expect(getRequiredCapability('list-patches')).toBe(CAPABILITIES.PATCHES);
        expect(getRequiredCapability('select-patch')).toBe(CAPABILITIES.PATCHES);
    });

    it('returns correct capability for param commands', () => {
        expect(getRequiredCapability('update-param')).toBe(CAPABILITIES.PARAMS);
        expect(getRequiredCapability('toggle-module')).toBe(CAPABILITIES.PARAMS);
    });

    it('returns correct capability for config commands', () => {
        expect(getRequiredCapability('config-get')).toBe(CAPABILITIES.CONFIG);
        expect(getRequiredCapability('config-set')).toBe(CAPABILITIES.CONFIG);
    });

    it('returns null for unknown commands', () => {
        expect(getRequiredCapability('unknown-command')).toBeNull();
    });

    it('returns IDENTITY for device info', () => {
        expect(getRequiredCapability('get-device-info')).toBe(CAPABILITIES.IDENTITY);
    });
});

describe('CAPABILITIES', () => {
    it('has expected capability constants', () => {
        expect(CAPABILITIES.IDENTITY).toBeDefined();
        expect(CAPABILITIES.SYNTH).toBeDefined();
        expect(CAPABILITIES.PATCHES).toBeDefined();
        expect(CAPABILITIES.PARAMS).toBeDefined();
        expect(CAPABILITIES.CONFIG).toBeDefined();
        expect(CAPABILITIES.CONTROLLER).toBeDefined();
    });
});
