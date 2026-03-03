/**
 * Wire format contract tests — JS equivalents of test_wire_format.cpp
 *
 * Same byte sequences, same expected results. The CONTRACT is that
 * both C and JS sides agree on the byte layout.
 */

// ============================================================================
// 1. Subtype Classification
// ============================================================================

describe('classifySysEx', () => {
    it('classifies 0x01 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x01])).toBe('exchange-transport');
    });

    it('classifies 0x02 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x02])).toBe('exchange-transport');
    });

    it('classifies 0x03 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x03])).toBe('exchange-transport');
    });

    it('classifies 0x04 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x04])).toBe('exchange-transport');
    });

    it('classifies 0x05 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x05])).toBe('exchange-transport');
    });

    it('classifies 0x06 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x06])).toBe('exchange-transport');
    });

    it('classifies 0x07 as exchange-transport', () => {
        expect(classifySysEx([0x7D, 0x00, 0x07])).toBe('exchange-transport');
    });

    it('classifies 0x10 as exchange-value', () => {
        expect(classifySysEx([0x7D, 0x00, 0x10, 0x05, 0x40, 0x00])).toBe('exchange-value');
    });

    it('classifies 0x11 as exchange-adsr', () => {
        expect(classifySysEx([0x7D, 0x00, 0x11, 0x05, 0x00, 0x01])).toBe('exchange-adsr');
    });

    it('classifies 0x20 as dm-channel', () => {
        expect(classifySysEx([0x7D, 0x00, 0x20, 0x7B])).toBe('dm-channel');
    });

    it('classifies 0x21 as dm-feedback', () => {
        expect(classifySysEx([0x7D, 0x00, 0x21, 0x05, 0x40, 0x00])).toBe('dm-feedback');
    });

    it('returns unknown for 0x30', () => {
        expect(classifySysEx([0x7D, 0x00, 0x30])).toBe('unknown');
    });

    it('returns unknown for too-short data', () => {
        expect(classifySysEx([0x7D, 0x00])).toBe('unknown');
    });

    it('returns unknown for wrong manufacturer', () => {
        expect(classifySysEx([0x7E, 0x00, 0x01])).toBe('unknown');
    });

    it('returns unknown for null/empty', () => {
        expect(classifySysEx(null)).toBe('unknown');
        expect(classifySysEx([])).toBe('unknown');
    });
});

// ============================================================================
// 2. DM Channel (0x20) Disambiguation
// ============================================================================

describe('classifyDmFormat', () => {
    it('classifies 0x7B as direct-json', () => {
        expect(classifyDmFormat([0x7D, 0x00, 0x20, 0x7B])).toBe('direct-json');
    });

    it('classifies 0x01 as transport', () => {
        expect(classifyDmFormat([0x7D, 0x00, 0x20, 0x01])).toBe('transport');
    });

    it('classifies 0x07 as transport', () => {
        expect(classifyDmFormat([0x7D, 0x00, 0x20, 0x07])).toBe('transport');
    });

    it('classifies 0x08 as invalid (gap)', () => {
        expect(classifyDmFormat([0x7D, 0x00, 0x20, 0x08])).toBe('invalid');
    });

    it('returns invalid for too-short data', () => {
        expect(classifyDmFormat([0x7D, 0x00, 0x20])).toBe('invalid');
    });
});

// ============================================================================
// 3. DM Feedback (0x21) Parsing
// ============================================================================

describe('parseDmFeedback', () => {
    it('parses a valid feedback message', () => {
        // uid=5, value=8192, priority=3, cc=10,
        // range_min=0, range_max=16383, display="Filter"
        const data = [
            0x7D, 0x00, 0x21,               // header
            0x05,                            // uid
            0x40, 0x00,                      // value: (0x40 << 7) | 0x00 = 8192
            0x03,                            // priority
            0x0A,                            // cc = 10
            0x00, 0x00,                      // range_min = 0
            0x7F, 0x7F,                      // range_max = 16383
            0x46, 0x69, 0x6C, 0x74, 0x65, 0x72, 0x00  // "Filter\0"
        ];

        const fb = parseDmFeedback(data);
        expect(fb).not.toBeNull();
        expect(fb.uid).toBe(5);
        expect(fb.value).toBe(8192);
        expect(fb.priority).toBe(3);
        expect(fb.cc).toBe(10);
        expect(fb.rangeMin).toBe(0);
        expect(fb.rangeMax).toBe(16383);
        expect(fb.display).toBe('Filter');
    });

    it('handles no CC assigned (0x7F)', () => {
        const data = [
            0x7D, 0x00, 0x21,
            0x01,                            // uid
            0x00, 0x64,                      // value = 100
            0x00,                            // priority
            0x7F,                            // cc = 0x7F (no CC)
            0x00, 0x00,                      // range_min
            0x7F, 0x7F,                      // range_max
            0x56, 0x6F, 0x6C, 0x00          // "Vol\0"
        ];

        const fb = parseDmFeedback(data);
        expect(fb).not.toBeNull();
        expect(fb.cc).toBe(AP_DM_FEEDBACK_NO_CC);
    });

    it('handles max-length display (15 chars)', () => {
        const text = '123456789012345';  // 15 chars
        const textBytes = Array.from(text).map(c => c.charCodeAt(0));
        const data = [
            0x7D, 0x00, 0x21,
            0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            ...textBytes, 0x00
        ];

        const fb = parseDmFeedback(data);
        expect(fb).not.toBeNull();
        expect(fb.display).toBe('123456789012345');
    });

    it('handles empty display', () => {
        const data = [
            0x7D, 0x00, 0x21,
            0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00  // just null terminator
        ];

        const fb = parseDmFeedback(data);
        expect(fb).not.toBeNull();
        expect(fb.display).toBe('');
    });

    it('returns null for too-short message', () => {
        const data = [0x7D, 0x00, 0x21, 0x05, 0x40];
        expect(parseDmFeedback(data)).toBeNull();
    });

    it('returns null for null input', () => {
        expect(parseDmFeedback(null)).toBeNull();
    });
});

// ============================================================================
// 4. 14-bit Helpers
// ============================================================================

describe('14-bit encoding', () => {
    it('encodes zero', () => {
        const [msb, lsb] = from14bit(0);
        expect(msb).toBe(0x00);
        expect(lsb).toBe(0x00);
        expect(to14bit(msb, lsb)).toBe(0);
    });

    it('encodes max (16383)', () => {
        const [msb, lsb] = from14bit(16383);
        expect(msb).toBe(0x7F);
        expect(lsb).toBe(0x7F);
        expect(to14bit(msb, lsb)).toBe(16383);
    });

    it('encodes midpoint (8192)', () => {
        const [msb, lsb] = from14bit(8192);
        expect(msb).toBe(0x40);
        expect(lsb).toBe(0x00);
        expect(to14bit(msb, lsb)).toBe(8192);
    });
});

// ============================================================================
// 5. Cross-Contamination
// ============================================================================

describe('cross-contamination', () => {
    it('0x01-0x07 never classify as DM', () => {
        for (let subtype = 0x01; subtype <= 0x07; subtype++) {
            const route = classifySysEx([0x7D, 0x00, subtype]);
            expect(route).not.toBe('dm-channel');
            expect(route).not.toBe('dm-feedback');
        }
    });

    it('0x20 does not classify as exchange', () => {
        const route = classifySysEx([0x7D, 0x00, 0x20, 0x7B]);
        expect(route).not.toBe('exchange-transport');
        expect(route).not.toBe('exchange-value');
        expect(route).not.toBe('exchange-adsr');
    });
});
