/**
 * Virtual device DM lifecycle tests (#93)
 *
 * Tests pair/unpair, exchange flow, DM notifications, 0x21 feedback,
 * and connect/disconnect for software instruments (Estragon, Ahab).
 */

// ============================================================================
// Test helpers
// ============================================================================

/**
 * MockPortManager — captures injected messages and exposes the receive callback
 * so tests can feed commands directly to virtual devices.
 */
function createMockPortManager() {
    const ports = {};       // portName → receiveCallback
    const injected = [];    // { portName, data }

    return {
        addVirtualPort(portName, onReceive) {
            ports[portName] = onReceive;
        },
        removeVirtualPort(portName) {
            delete ports[portName];
        },
        injectMessage(portName, data) {
            injected.push({ portName, data: new Uint8Array(data) });
        },
        // Test helpers
        getInjected() { return injected; },
        clearInjected() { injected.length = 0; },
        getReceiveCallback(portName) { return ports[portName]; },
        /**
         * Send a JSON command to a virtual device as 0x20 DM SysEx
         */
        sendCommand(portName, json) {
            const cb = ports[portName];
            if (!cb) throw new Error(`No port registered: ${portName}`);
            cb(encodeDmJsonToSysEx(json));
        },
        /**
         * Send a JSON response (no cmd) to a virtual device as 0x20 DM SysEx
         */
        sendResponse(portName, json) {
            const cb = ports[portName];
            if (!cb) throw new Error(`No port registered: ${portName}`);
            cb(encodeDmJsonToSysEx(json));
        }
    };
}

/**
 * Extract JSON from injected 0x20 messages.
 * Returns array of parsed JSON objects.
 */
function extractDmJsonMessages(injected, portName) {
    return injected
        .filter(m => m.portName === portName)
        .filter(m => m.data[0] === 0xF0 && m.data[1] === 0x7D && m.data[2] === 0x00 && m.data[3] === 0x20)
        .map(m => {
            const jsonBytes = m.data.slice(4, -1);
            return JSON.parse(new TextDecoder().decode(jsonBytes));
        });
}

/**
 * Extract 0x21 feedback messages from injected data.
 * Returns array of parsed feedback objects via parseDmFeedback.
 */
function extractFeedbackMessages(injected, portName) {
    return injected
        .filter(m => m.portName === portName)
        .filter(m => m.data[0] === 0xF0 && m.data[1] === 0x7D && m.data[2] === 0x00 && m.data[3] === 0x21)
        .map(m => {
            // Strip F0 and F7 for parseDmFeedback
            const inner = m.data.slice(1, -1);
            return parseDmFeedback(inner);
        })
        .filter(Boolean);
}

// ============================================================================
// 1. VirtualDevice base class
// ============================================================================

describe('VirtualDevice base class', () => {
    it('has a random MUID', () => {
        const pm = createMockPortManager();
        const dev = new VirtualDevice(pm, 'Test Port');
        expect(dev._muid).toBeGreaterThan(0);
        expect(dev._muid).toBeLessThanOrEqual(0x0FFFFFFF);
    });

    it('two instances have different MUIDs', () => {
        const pm = createMockPortManager();
        const a = new VirtualDevice(pm, 'A');
        const b = new VirtualDevice(pm, 'B');
        // Statistically should always differ
        expect(a._muid).not.toBe(b._muid);
    });

    it('_sendDmNotification sends 0x20 JSON with notification key', () => {
        const pm = createMockPortManager();
        const dev = new VirtualDevice(pm, 'Test Port');
        dev.start();
        dev._sendDmNotification('exchange-start');

        const msgs = extractDmJsonMessages(pm.getInjected(), 'Test Port');
        expect(msgs.length).toBe(1);
        expect(msgs[0].notification).toBe('exchange-start');
    });

    it('_sendDmNotification includes extra fields', () => {
        const pm = createMockPortManager();
        const dev = new VirtualDevice(pm, 'Test Port');
        dev.start();
        dev._sendDmNotification('exchange-complete', { controls: [{ uid: 0 }] });

        const msgs = extractDmJsonMessages(pm.getInjected(), 'Test Port');
        expect(msgs[0].notification).toBe('exchange-complete');
        expect(msgs[0].controls).toEqual([{ uid: 0 }]);
    });

    it('_sendDmFeedback sends parseable 0x21 binary', () => {
        const pm = createMockPortManager();
        const dev = new VirtualDevice(pm, 'Test Port');
        dev.start();
        dev._sendDmFeedback(5, 8192, '440Hz', { priority: 1, cc: 74 });

        const feedbacks = extractFeedbackMessages(pm.getInjected(), 'Test Port');
        expect(feedbacks.length).toBe(1);
        expect(feedbacks[0].uid).toBe(5);
        expect(feedbacks[0].value).toBe(8192);
        expect(feedbacks[0].priority).toBe(1);
        expect(feedbacks[0].cc).toBe(74);
        expect(feedbacks[0].display).toBe('440Hz');
    });

    it('_sendDmFeedback defaults: priority=0, cc=0x7F, full range', () => {
        const pm = createMockPortManager();
        const dev = new VirtualDevice(pm, 'Test Port');
        dev.start();
        dev._sendDmFeedback(3, 1000, 'test');

        const feedbacks = extractFeedbackMessages(pm.getInjected(), 'Test Port');
        expect(feedbacks[0].priority).toBe(0);
        expect(feedbacks[0].cc).toBe(0x7F);
        expect(feedbacks[0].rangeMin).toBe(0);
        expect(feedbacks[0].rangeMax).toBe(16383);
    });
});

// ============================================================================
// 2. Estragon pair/unpair
// ============================================================================

describe('Estragon pair/unpair', () => {
    let pm, estragon;

    beforeEach(() => {
        pm = createMockPortManager();
        estragon = new Estragon(pm);
        estragon.start();
    });

    it('responds {status: ok, op: pair} to pair command', async () => {
        pm.sendCommand('AP Estragon', { cmd: 'pair', muid: 42 });
        await new Promise(r => setTimeout(r, 10)); // microtask flush

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const pairResp = msgs.find(m => m.op === 'pair');
        expect(pairResp).toBeDefined();
        expect(pairResp.status).toBe('ok');
    });

    it('sends exchange-start notification after pair', async () => {
        pm.sendCommand('AP Estragon', { cmd: 'pair', muid: 42 });
        await new Promise(r => setTimeout(r, 10));

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const notif = msgs.find(m => m.notification === 'exchange-start');
        expect(notif).toBeDefined();
    });

    it('sends get-control-surface after pair', async () => {
        pm.sendCommand('AP Estragon', { cmd: 'pair', muid: 42 });
        await new Promise(r => setTimeout(r, 100)); // wait for 50ms timeout

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const gcs = msgs.find(m => m.cmd === 'get-control-surface');
        expect(gcs).toBeDefined();
    });

    it('responds {status: ok, op: unpair} to unpair command', async () => {
        pm.sendCommand('AP Estragon', { cmd: 'unpair' });
        await new Promise(r => setTimeout(r, 10));

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const resp = msgs.find(m => m.op === 'unpair');
        expect(resp).toBeDefined();
        expect(resp.status).toBe('ok');
    });

    it('unpair clears exchange state', async () => {
        // Pair first
        pm.sendCommand('AP Estragon', { cmd: 'pair', muid: 42 });
        await new Promise(r => setTimeout(r, 10));
        expect(estragon._pairedMuid).toBe(42);

        pm.clearInjected();
        pm.sendCommand('AP Estragon', { cmd: 'unpair' });
        await new Promise(r => setTimeout(r, 10));

        expect(estragon._pairedMuid).toBeNull();
        expect(estragon._exchangeState).toBe('IDLE');
    });
});

// ============================================================================
// 3. Estragon exchange flow
// ============================================================================

describe('Estragon exchange flow', () => {
    let pm, estragon;

    beforeEach(() => {
        pm = createMockPortManager();
        estragon = new Estragon(pm);
        estragon.start();
    });

    it('sends set-patch after receiving control-surface', async () => {
        // Pair triggers exchange
        pm.sendCommand('AP Estragon', { cmd: 'pair', muid: 42 });
        await new Promise(r => setTimeout(r, 100)); // wait for get-control-surface

        pm.clearInjected();

        // Simulate controller responding with control-surface
        pm.sendResponse('AP Estragon', {
            status: 'ok', op: 'control-surface',
            mfg: 'AttachPart', device: 'Ahab', version: '0.2.0',
            controls: { '1d.abs.rotary': 8, '1d.abs.linear': 2 },
            labeled: true, keyboard: { keys: 0 }, parts: 1
        });

        await new Promise(r => setTimeout(r, 100)); // wait for set-patch timeout

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const setPatch = msgs.find(m => m.cmd === 'set-patch');
        expect(setPatch).toBeDefined();
        expect(setPatch.name).toBe('FM Init'); // first patch
        expect(setPatch.controls).toBeDefined();
        expect(Array.isArray(setPatch.controls)).toBe(true);
    });

    it('sends exchange-complete notification with controls after exchange', async () => {
        pm.sendCommand('AP Estragon', { cmd: 'pair', muid: 42 });
        await new Promise(r => setTimeout(r, 100));

        pm.clearInjected();

        // Controller responds
        pm.sendResponse('AP Estragon', {
            status: 'ok', op: 'control-surface',
            controls: { '1d.abs.rotary': 8 }, parts: 1
        });
        await new Promise(r => setTimeout(r, 100));

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const notif = msgs.find(m => m.notification === 'exchange-complete');
        expect(notif).toBeDefined();
        expect(notif.controls).toBeDefined();
        expect(Array.isArray(notif.controls)).toBe(true);
    });
});

// ============================================================================
// 4. Estragon notifications
// ============================================================================

describe('Estragon notifications', () => {
    let pm, estragon;

    beforeEach(() => {
        pm = createMockPortManager();
        estragon = new Estragon(pm);
        estragon.start();
    });

    it('sends patch-switched notification on select-patch', async () => {
        pm.sendCommand('AP Estragon', { cmd: 'select-patch', index: 2 });
        await new Promise(r => setTimeout(r, 10));

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Estragon');
        const notif = msgs.find(m => m.notification === 'patch-switched');
        expect(notif).toBeDefined();
        expect(notif.patchIndex).toBe(2);
    });
});

// ============================================================================
// 5. Estragon 0x21 feedback
// ============================================================================

describe('Estragon 0x21 feedback', () => {
    let pm, estragon;

    beforeEach(() => {
        pm = createMockPortManager();
        estragon = new Estragon(pm);
        estragon.start();
    });

    it('update-param sends 0x21 binary feedback (not legacy 0x10)', async () => {
        pm.sendCommand('AP Estragon', {
            cmd: 'update-param', index: 0, param: 'CARRIER_RATIO', value: 3.5
        });
        await new Promise(r => setTimeout(r, 10));

        // Should have 0x21 feedback
        const feedbacks = extractFeedbackMessages(pm.getInjected(), 'AP Estragon');
        expect(feedbacks.length).toBe(1);
        expect(feedbacks[0].uid).toBe(0); // CARRIER_RATIO is uid=0

        // Should NOT have legacy 0x10
        const legacy = pm.getInjected().filter(m =>
            m.portName === 'AP Estragon' &&
            m.data[0] === 0xF0 && m.data[3] === 0x10
        );
        expect(legacy.length).toBe(0);
    });

    it('0x21 feedback wire format matches parseDmFeedback', async () => {
        pm.sendCommand('AP Estragon', {
            cmd: 'update-param', index: 0, param: 'MOD_DEPTH', value: 440
        });
        await new Promise(r => setTimeout(r, 10));

        const feedbacks = extractFeedbackMessages(pm.getInjected(), 'AP Estragon');
        expect(feedbacks.length).toBe(1);
        // MOD_DEPTH is uid=3 (after CARRIER_RATIO=0, CARRIER_LEVEL=1, CARRIER_WAVE=2, MOD_RATIO=3... wait)
        // Actually: CARRIER module: CARRIER_RATIO(0), CARRIER_LEVEL(1), CARRIER_WAVE(2)
        // MODULATOR module: MOD_RATIO(3), MOD_DEPTH(4), MOD_WAVE(5)
        expect(feedbacks[0].uid).toBe(4);
        expect(feedbacks[0].display).toBe('440Hz');
    });
});

// ============================================================================
// 6. Ahab pair/unpair
// ============================================================================

describe('Ahab pair/unpair', () => {
    let pm, ahab;

    beforeEach(() => {
        pm = createMockPortManager();
        ahab = new Ahab(pm);
        ahab.start();
    });

    it('responds {status: ok, op: pair} to pair command', async () => {
        pm.sendCommand('AP Ahab', { cmd: 'pair', muid: 99 });
        await new Promise(r => setTimeout(r, 10));

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Ahab');
        const resp = msgs.find(m => m.op === 'pair');
        expect(resp).toBeDefined();
        expect(resp.status).toBe('ok');
    });

    it('stores paired MUID', async () => {
        pm.sendCommand('AP Ahab', { cmd: 'pair', muid: 99 });
        await new Promise(r => setTimeout(r, 10));
        expect(ahab._pairedMuid).toBe(99);
    });

    it('responds {status: ok, op: unpair} to unpair command', async () => {
        pm.sendCommand('AP Ahab', { cmd: 'unpair' });
        await new Promise(r => setTimeout(r, 10));

        const msgs = extractDmJsonMessages(pm.getInjected(), 'AP Ahab');
        const resp = msgs.find(m => m.op === 'unpair');
        expect(resp).toBeDefined();
        expect(resp.status).toBe('ok');
    });

    it('unpair clears state', async () => {
        pm.sendCommand('AP Ahab', { cmd: 'pair', muid: 99 });
        await new Promise(r => setTimeout(r, 10));
        expect(ahab._pairedMuid).toBe(99);

        pm.sendCommand('AP Ahab', { cmd: 'unpair' });
        await new Promise(r => setTimeout(r, 10));
        expect(ahab._pairedMuid).toBeNull();
        expect(ahab._patchData).toBeNull();
    });
});

// ============================================================================
// 7. Connect/Disconnect lifecycle
// ============================================================================

describe('Connect/Disconnect lifecycle', () => {
    it('Estragon connect sets _connected', () => {
        const pm = createMockPortManager();
        const estragon = new Estragon(pm);
        expect(estragon._connected).toBe(false);
        estragon.connect();
        expect(estragon._connected).toBe(true);
    });

    it('Estragon disconnect clears paired state', () => {
        const pm = createMockPortManager();
        const estragon = new Estragon(pm);
        estragon._pairedMuid = 42;
        estragon._exchangeState = 'EXCHANGE';
        estragon.connect();
        estragon.disconnect();
        expect(estragon._connected).toBe(false);
        expect(estragon._pairedMuid).toBeNull();
        expect(estragon._exchangeState).toBe('IDLE');
    });

    it('Estragon connect is idempotent', () => {
        const pm = createMockPortManager();
        const estragon = new Estragon(pm);
        estragon.connect();
        estragon.connect();
        expect(estragon._connected).toBe(true);
    });

    it('Ahab connect/disconnect lifecycle', () => {
        const pm = createMockPortManager();
        const ahab = new Ahab(pm);
        expect(ahab._connected).toBe(false);
        ahab.connect();
        expect(ahab._connected).toBe(true);
        ahab._pairedMuid = 99;
        ahab.disconnect();
        expect(ahab._connected).toBe(false);
        expect(ahab._pairedMuid).toBeNull();
    });
});
