import { describe, it, expect, beforeEach } from 'vitest';

describe('MidiState', () => {
    let state;

    beforeEach(() => {
        state = new MidiState();
    });

    // ---- Pub/Sub ----

    describe('subscribe', () => {
        it('returns unsubscribe function', () => {
            const unsub = state.subscribe(() => {});
            expect(typeof unsub).toBe('function');
        });

        it('notifies subscribers on events', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, data }));

            state.handleMidiThrough(new Uint8Array([0x90, 60, 100]));
            expect(events.length).toBe(1);
            expect(events[0].type).toBe('noteOn');
        });

        it('stops notifying after unsubscribe', () => {
            const events = [];
            const unsub = state.subscribe((type, data) => events.push(type));

            state.handleMidiThrough(new Uint8Array([0x90, 60, 100]));
            expect(events.length).toBe(1);

            unsub();
            state.handleMidiThrough(new Uint8Array([0x90, 62, 100]));
            expect(events.length).toBe(1); // No new event
        });

        it('survives subscriber errors', () => {
            state.subscribe(() => { throw new Error('bad'); });
            const events = [];
            state.subscribe((type) => events.push(type));

            state.handleMidiThrough(new Uint8Array([0x90, 60, 100]));
            expect(events.length).toBe(1); // Second subscriber still called
        });
    });

    // ---- MIDI Through Parsing ----

    describe('handleMidiThrough', () => {
        it('parses Note On', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, ...data }));

            state.handleMidiThrough(new Uint8Array([0x90, 60, 100]));
            expect(events[0].type).toBe('noteOn');
            expect(events[0].note).toBe(60);
            expect(events[0].velocity).toBeCloseTo(100 / 127, 2);
        });

        it('treats Note On with velocity 0 as Note Off', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, ...data }));

            state.handleMidiThrough(new Uint8Array([0x90, 60, 100])); // on
            state.handleMidiThrough(new Uint8Array([0x90, 60, 0]));   // off (vel=0)
            expect(events[1].type).toBe('noteOff');
        });

        it('parses Note Off', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, ...data }));

            state.handleMidiThrough(new Uint8Array([0x80, 60, 64]));
            expect(events[0].type).toBe('noteOff');
            expect(events[0].note).toBe(60);
        });

        it('parses Pitch Bend', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, ...data }));

            // Center (8192 = 0x00 + 0x40<<7)
            state.handleMidiThrough(new Uint8Array([0xE0, 0x00, 0x40]));
            expect(events[0].type).toBe('bend');
            expect(events[0].bend).toBeCloseTo(0, 1);
        });

        it('parses Channel Pressure', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, ...data }));

            state.handleMidiThrough(new Uint8Array([0xD0, 64]));
            expect(events[0].type).toBe('pressure');
            expect(events[0].pressure).toBeCloseTo(64 / 127, 2);
        });

        it('stores latest velocity', () => {
            state.handleMidiThrough(new Uint8Array([0x90, 60, 100]));
            expect(state.getLatestVelocity()).toBeCloseTo(100 / 127, 2);
        });

        it('tracks active notes', () => {
            state.handleMidiThrough(new Uint8Array([0x90, 60, 100])); // ch 0
            expect(state.getActiveNotes().size).toBe(1);

            state.handleMidiThrough(new Uint8Array([0x80, 60, 0]));   // off
            expect(state.getActiveNotes().size).toBe(0);
        });
    });

    // ---- All MIDI Input (CC handling) ----

    describe('handleAllMidiInput', () => {
        it('stores CC values by port:cc', () => {
            state.handleAllMidiInput('port1', new Uint8Array([0xB0, 20, 100]));
            expect(state.getCCValue('port1', 20)).toBe(100);
        });

        it('returns null for unseen CC', () => {
            expect(state.getCCValue('port1', 20)).toBeNull();
        });

        it('decodes octave from CC 102', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, ...data }));

            state.handleAllMidiInput('port1', new Uint8Array([0xB0, 102, 64]));
            const status = state.getControllerStatus('port1');
            expect(status.octave).toBeDefined();
        });

        it('decodes sustain from CC 64', () => {
            state.handleAllMidiInput('port1', new Uint8Array([0xB0, 64, 127]));
            expect(state.getControllerStatus('port1').sustain).toBe(true);

            state.handleAllMidiInput('port1', new Uint8Array([0xB0, 64, 0]));
            expect(state.getControllerStatus('port1').sustain).toBe(false);
        });
    });

    // ---- Value Feedback ----

    describe('value feedback', () => {
        it('stores by portName:uid', () => {
            state.handleValueFeedback({ portName: 'candide', uid: 3, displayText: '440Hz' });
            const result = state.getValueFeedback('candide', 3);
            expect(result.displayText).toBe('440Hz');
        });

        it('returns null for missing feedback', () => {
            expect(state.getValueFeedback('candide', 99)).toBeNull();
        });

        it('isolates by port', () => {
            state.handleValueFeedback({ portName: 'candide', uid: 2, displayText: '100Hz' });
            state.handleValueFeedback({ portName: 'estragon', uid: 2, displayText: 'Sine' });

            expect(state.getValueFeedback('candide', 2).displayText).toBe('100Hz');
            expect(state.getValueFeedback('estragon', 2).displayText).toBe('Sine');
        });

        it('clearValueFeedback clears only specified port', () => {
            state.handleValueFeedback({ portName: 'candide', uid: 0, displayText: 'A' });
            state.handleValueFeedback({ portName: 'estragon', uid: 0, displayText: 'B' });

            state.clearValueFeedback('candide');
            expect(state.getValueFeedback('candide', 0)).toBeNull();
            expect(state.getValueFeedback('estragon', 0).displayText).toBe('B');
        });

        it('clearValueFeedback without port clears all', () => {
            state.handleValueFeedback({ portName: 'candide', uid: 0, displayText: 'A' });
            state.handleValueFeedback({ portName: 'estragon', uid: 0, displayText: 'B' });

            state.clearValueFeedback();
            expect(state.getValueFeedback('candide', 0)).toBeNull();
            expect(state.getValueFeedback('estragon', 0)).toBeNull();
        });

        it('notifies subscribers on value feedback', () => {
            const events = [];
            state.subscribe((type, data) => events.push({ type, data }));

            state.handleValueFeedback({ portName: 'candide', uid: 3, displayText: '440Hz' });
            expect(events[0].type).toBe('valueFeedback');
            expect(events[0].data.uid).toBe(3);
        });
    });

    // ---- Reset ----

    describe('reset', () => {
        it('clears all state', () => {
            state.handleMidiThrough(new Uint8Array([0x90, 60, 100]));
            state.reset();

            expect(state.getActiveNotes().size).toBe(0);
            expect(state.getLatestVelocity()).toBeNull();
        });

        it('notifies subscribers', () => {
            const events = [];
            state.subscribe((type) => events.push(type));
            state.reset();
            expect(events).toContain('reset');
        });
    });
});
