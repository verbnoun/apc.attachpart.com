import { describe, it, expect } from 'vitest';

describe('buildMidi1NoteOn', () => {
    it('builds correct status byte', () => {
        const msg = buildMidi1NoteOn(0, 60, 0.5);
        expect(msg[0]).toBe(0x90); // Note On, channel 0
    });

    it('respects channel', () => {
        const msg = buildMidi1NoteOn(5, 60, 0.5);
        expect(msg[0]).toBe(0x95); // Note On, channel 5
    });

    it('includes note number', () => {
        const msg = buildMidi1NoteOn(0, 72, 0.5);
        expect(msg[1]).toBe(72);
    });

    it('scales velocity from 0-1 to 0-127', () => {
        expect(buildMidi1NoteOn(0, 60, 1.0)[2]).toBe(127);
        expect(buildMidi1NoteOn(0, 60, 0.0)[2]).toBe(0);
        const mid = buildMidi1NoteOn(0, 60, 0.5)[2];
        expect(mid).toBeGreaterThan(50);
        expect(mid).toBeLessThan(70);
    });

    it('returns 3-byte message', () => {
        const msg = buildMidi1NoteOn(0, 60, 0.5);
        expect(msg.length).toBe(3);
    });
});

describe('buildMidi1NoteOff', () => {
    it('builds correct status byte', () => {
        const msg = buildMidi1NoteOff(0, 60);
        expect(msg[0]).toBe(0x80);
    });

    it('includes note number', () => {
        const msg = buildMidi1NoteOff(0, 72);
        expect(msg[1]).toBe(72);
    });

    it('returns 3-byte message', () => {
        expect(buildMidi1NoteOff(0, 60).length).toBe(3);
    });
});

describe('buildMidi1ChannelPressure', () => {
    it('builds correct status byte', () => {
        const msg = buildMidi1ChannelPressure(0, 0.5);
        expect(msg[0]).toBe(0xD0);
    });

    it('scales pressure to 0-127', () => {
        expect(buildMidi1ChannelPressure(0, 1.0)[1]).toBe(127);
        expect(buildMidi1ChannelPressure(0, 0.0)[1]).toBe(0);
    });

    it('returns 2-byte message', () => {
        expect(buildMidi1ChannelPressure(0, 0.5).length).toBe(2);
    });
});

describe('buildMidi1PitchBend', () => {
    it('builds correct status byte', () => {
        const msg = buildMidi1PitchBend(0, 0);
        expect(msg[0]).toBe(0xE0);
    });

    it('centers at 8192 for bend=0', () => {
        const msg = buildMidi1PitchBend(0, 0);
        const raw = msg[1] | (msg[2] << 7);
        expect(raw).toBe(8192);
    });

    it('maxes at 16383 for bend=1', () => {
        const msg = buildMidi1PitchBend(0, 1);
        const raw = msg[1] | (msg[2] << 7);
        expect(raw).toBe(16383);
    });

    it('mins at 0 for bend=-1', () => {
        const msg = buildMidi1PitchBend(0, -1);
        const raw = msg[1] | (msg[2] << 7);
        expect(raw).toBe(0);
    });

    it('returns 3-byte message', () => {
        expect(buildMidi1PitchBend(0, 0).length).toBe(3);
    });
});

describe('MpeChannelAllocator', () => {
    it('allocates channels from pool', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        const ch = alloc.allocate(60);
        expect(ch).toBeGreaterThanOrEqual(1);
        expect(ch).toBeLessThanOrEqual(15);
    });

    it('returns same channel for same note', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        const ch1 = alloc.allocate(60);
        const ch2 = alloc.allocate(60);
        expect(ch2).toBe(ch1);
    });

    it('allocates different channels for different notes', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        const ch1 = alloc.allocate(60);
        const ch2 = alloc.allocate(62);
        expect(ch2).not.toBe(ch1);
    });

    it('releases channel back to pool', () => {
        const alloc = new MpeChannelAllocator(0, 3);
        const ch1 = alloc.allocate(60);
        alloc.release(60);
        expect(alloc.getChannel(60)).toBeUndefined();
        // Pool has channels available again after release
        const ch2 = alloc.allocate(62);
        expect(ch2).toBeGreaterThanOrEqual(1);
        expect(ch2).toBeLessThanOrEqual(3);
    });

    it('getChannel returns channel for allocated note', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        const ch = alloc.allocate(60);
        expect(alloc.getChannel(60)).toBe(ch);
    });

    it('getChannel returns undefined for unallocated note', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        expect(alloc.getChannel(60)).toBeUndefined();
    });

    it('getMasterChannel returns master', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        expect(alloc.getMasterChannel()).toBe(0);
    });

    it('reset clears all allocations', () => {
        const alloc = new MpeChannelAllocator(0, 15);
        alloc.allocate(60);
        alloc.allocate(62);
        alloc.reset();
        expect(alloc.getChannel(60)).toBeUndefined();
        expect(alloc.getChannel(62)).toBeUndefined();
    });
});
