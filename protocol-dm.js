/**
 * Device Management Protocol — SysEx classification and 0x21 feedback parsing
 *
 * Shared protocol definitions for routing DM messages (0x20/0x21)
 * independently from Config Exchange (0x01-0x07/0x10/0x11).
 *
 * Wire format contract: byte layouts here MUST match ap_sysex_protocol.h (C).
 */

//======================================================================
// Constants
//======================================================================

const AP_SYSEX_MFG_ID     = 0x7D;
const AP_SYSEX_DEVICE_ID  = 0x00;
const AP_SYSEX_MIN_LEN    = 3;  // [mfg][device][subtype]

const AP_DM_FEEDBACK_HEADER_SIZE = 12;
const AP_DM_FEEDBACK_MAX_DISPLAY = 15;
const AP_DM_FEEDBACK_NO_CC       = 0x7F;

//======================================================================
// Classification
//======================================================================

/**
 * Classify a SysEx payload by subtype.
 * @param {Uint8Array|number[]} data - Payload after F0/F7 stripping: [0x7D][0x00][subtype][...]
 * @returns {string} Route: 'exchange-transport' | 'exchange-value' | 'exchange-adsr' |
 *                          'dm-channel' | 'dm-feedback' | 'unknown'
 */
function classifySysEx(data) {
    if (!data || data.length < AP_SYSEX_MIN_LEN) {
        return 'unknown';
    }

    if (data[0] !== AP_SYSEX_MFG_ID) {
        return 'unknown';
    }

    const subtype = data[2];

    if (subtype >= 0x01 && subtype <= 0x07) {
        return 'exchange-transport';
    }

    switch (subtype) {
        case 0x10: return 'exchange-value';
        case 0x11: return 'exchange-adsr';
        case 0x20: return 'dm-channel';
        case 0x21: return 'dm-feedback';
        default:   return 'unknown';
    }
}

/**
 * Classify a 0x20 DM channel message format.
 * @param {Uint8Array|number[]} data - Payload: [0x7D][0x00][0x20][format_byte][...]
 * @returns {string} 'direct-json' | 'transport' | 'invalid'
 */
function classifyDmFormat(data) {
    if (!data || data.length < 4) {
        return 'invalid';
    }

    const formatByte = data[3];

    if (formatByte === 0x7B) {
        return 'direct-json';
    }

    if (formatByte >= 0x01 && formatByte <= 0x07) {
        return 'transport';
    }

    return 'invalid';
}

//======================================================================
// DM Feedback (0x21) Parsing
//======================================================================

/**
 * Parse a 0x21 DM feedback binary message.
 * @param {Uint8Array|number[]} data - Payload: [0x7D][0x00][0x21][uid][val_msb][val_lsb]...
 * @returns {Object|null} { uid, value, priority, cc, rangeMin, rangeMax, display } or null
 */
function parseDmFeedback(data) {
    if (!data || data.length < AP_DM_FEEDBACK_HEADER_SIZE + 1) {
        return null;
    }

    if (data[2] !== 0x21) {
        return null;
    }

    const uid      = data[3];
    const value    = to14bit(data[4], data[5]);
    const priority = data[6];
    const cc       = data[7];
    const rangeMin = to14bit(data[8], data[9]);
    const rangeMax = to14bit(data[10], data[11]);

    // Parse display text (null-terminated starting at byte 12)
    let displayEnd = AP_DM_FEEDBACK_HEADER_SIZE;
    const maxEnd = Math.min(data.length, AP_DM_FEEDBACK_HEADER_SIZE + AP_DM_FEEDBACK_MAX_DISPLAY + 1);
    while (displayEnd < maxEnd && data[displayEnd] !== 0x00) {
        displayEnd++;
    }

    const displayBytes = data.slice(AP_DM_FEEDBACK_HEADER_SIZE, displayEnd);
    const display = String.fromCharCode(...(Array.isArray(displayBytes) ? displayBytes : Array.from(displayBytes)));

    return { uid, value, priority, cc, rangeMin, rangeMax, display };
}

//======================================================================
// 14-bit Helpers
//======================================================================

function to14bit(msb, lsb) {
    return ((msb & 0x7F) << 7) | (lsb & 0x7F);
}

function from14bit(val) {
    return [(val >> 7) & 0x7F, val & 0x7F];
}

//======================================================================
// DM 0x20 Send Encoding
//======================================================================

/**
 * Encode a JSON command as a 0x20 DM SysEx message.
 * Format: [F0][7D][00][20][json_bytes][F7]
 *
 * Not wired into _sendCommand() yet (Phase 5), but available for testing
 * and manual send.
 *
 * @param {Object} json - Command object (e.g., {cmd: 'list-patches'})
 * @returns {Uint8Array} Complete SysEx message including F0/F7
 */
function encodeDmJsonToSysEx(json) {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const sysex = new Uint8Array(jsonBytes.length + 5);
    sysex[0] = 0xF0;
    sysex[1] = 0x7D;
    sysex[2] = 0x00;
    sysex[3] = 0x20;
    sysex.set(jsonBytes, 4);  // First byte = 0x7B ('{')
    sysex[sysex.length - 1] = 0xF7;
    return sysex;
}

//======================================================================
// Exports (browser global)
//======================================================================

window.classifySysEx = classifySysEx;
window.classifyDmFormat = classifyDmFormat;
window.parseDmFeedback = parseDmFeedback;
window.encodeDmJsonToSysEx = encodeDmJsonToSysEx;
window.to14bit = to14bit;
window.from14bit = from14bit;
window.AP_DM_FEEDBACK_NO_CC = AP_DM_FEEDBACK_NO_CC;
