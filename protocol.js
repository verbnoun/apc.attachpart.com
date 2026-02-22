/**
 * AttachPart Unified Device Protocol
 *
 * Defines capabilities and command mappings for device discovery.
 * All devices speak the same protocol - capabilities determine available features.
 */

//======================================================================
// CAPABILITY CONSTANTS
//======================================================================

const CAPABILITIES = {
    IDENTITY: 'IDENTITY',       // Device responds to get-device-info
    CONTROLLER: 'CONTROLLER',   // Has physical controls (pots, keys)
    SYNTH: 'SYNTH',            // Audio synthesis with modulation
    PATCHES: 'PATCHES',         // Patch storage and management
    CONFIG: 'CONFIG',           // Device configuration
    FIRMWARE: 'FIRMWARE',       // OTA firmware updates
    PARAMS: 'PARAMS'           // Real-time parameter control
};

//======================================================================
// COMMAND → CAPABILITY MAPPING
//======================================================================

const COMMAND_CAPABILITIES = {
    // IDENTITY (all devices)
    'get-device-info': CAPABILITIES.IDENTITY,

    // CONTROLLER
    'get-control-surface': CAPABILITIES.CONTROLLER,
    'assign': CAPABILITIES.CONTROLLER,

    // PATCHES
    'list-patches': CAPABILITIES.PATCHES,
    'get-patch': CAPABILITIES.PATCHES,
    'create-patch': CAPABILITIES.PATCHES,
    'delete-patch': CAPABILITIES.PATCHES,
    'rename-patch': CAPABILITIES.PATCHES,
    'select-patch': CAPABILITIES.PATCHES,
    'move-patch': CAPABILITIES.PATCHES,

    // CONFIG
    'config-get': CAPABILITIES.CONFIG,
    'config-set': CAPABILITIES.CONFIG,
    'config-reset': CAPABILITIES.CONFIG,

    // SAVE (works with both PATCHES and CONFIG)
    'save': null,  // Special: requires PATCHES OR CONFIG

    // FIRMWARE
    'upload-firmware': CAPABILITIES.FIRMWARE,
    'restart-device': CAPABILITIES.FIRMWARE,

    // PARAMS (real-time patch editing)
    'update-param': CAPABILITIES.PARAMS,
    'update-range': CAPABILITIES.PARAMS,
    'toggle-module': CAPABILITIES.PARAMS,
    'toggle-modulation': CAPABILITIES.PARAMS,
    'update-modulation-amount': CAPABILITIES.PARAMS,
    'toggle-cc': CAPABILITIES.PARAMS,
    'move-module': CAPABILITIES.PARAMS
};

//======================================================================
// KNOWN DEVICE PORTS (for discovery)
//======================================================================

// Exact port names - no fuzzy matching
const KNOWN_PORTS = [
    'Bartleby MPE',
    'Candide MPE',
    'Dagon MPE',           // Future hardware
    'AP Aach',             // Software FM synth (lives in APC)
    'AP Abbott'             // Software step sequencer controller (lives in APC)
];

// Port → capability set (virtual devices declare capabilities here)
const PORT_CAPABILITIES = {
    'AP Aach': [CAPABILITIES.IDENTITY, CAPABILITIES.SYNTH, CAPABILITIES.PATCHES, CAPABILITIES.PARAMS],
    'AP Abbott': [CAPABILITIES.IDENTITY, CAPABILITIES.CONTROLLER, CAPABILITIES.CONFIG]
};

//======================================================================
// SYSEX CONSTANTS
//======================================================================

const SYSEX_MANUFACTURER_ID = 0x7D;  // Educational/Development
const SYSEX_DEVICE_ID = 0x00;        // Broadcast

//======================================================================
// HELPER FUNCTIONS
//======================================================================

/**
 * Check if a command requires a specific capability
 * @param {string} cmd - Command name
 * @param {string[]} capabilities - Device capabilities array
 * @returns {boolean} - true if command is allowed
 */
function commandAllowed(cmd, capabilities) {
    const required = COMMAND_CAPABILITIES[cmd];

    // Unknown command - allow (fail at device level)
    if (required === undefined) {
        return true;
    }

    // Special case: save works with PATCHES or CONFIG
    if (required === null && cmd === 'save') {
        return capabilities.includes(CAPABILITIES.PATCHES) ||
               capabilities.includes(CAPABILITIES.CONFIG);
    }

    // IDENTITY is always allowed (it's how we discover)
    if (required === CAPABILITIES.IDENTITY) {
        return true;
    }

    return capabilities.includes(required);
}

/**
 * Get the required capability for a command
 * @param {string} cmd - Command name
 * @returns {string|null} - Capability name or null
 */
function getRequiredCapability(cmd) {
    return COMMAND_CAPABILITIES[cmd] || null;
}

// Export to global scope (browser)
window.CAPABILITIES = CAPABILITIES;
window.COMMAND_CAPABILITIES = COMMAND_CAPABILITIES;
window.KNOWN_PORTS = KNOWN_PORTS;
window.PORT_CAPABILITIES = PORT_CAPABILITIES;
window.SYSEX_MANUFACTURER_ID = SYSEX_MANUFACTURER_ID;
window.SYSEX_DEVICE_ID = SYSEX_DEVICE_ID;
window.commandAllowed = commandAllowed;
window.getRequiredCapability = getRequiredCapability;
