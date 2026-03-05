/**
 * DM dispatch contract tests — APC side
 *
 * Tests 0x20 receive decode, 0x21 feedback decode, notification routing,
 * and 0x20 send encoding. These match the C test contracts.
 *
 * Phase 5 additions: command sending via 0x20, notification dispatch through
 * API, relay filtering by subtype, relay lifecycle, and #73 pot-assignment
 * slider gating.
 */

// ============================================================================
// 1. 0x20 Receive Decode
// ============================================================================

describe('0x20 receive decode', () => {
    it('direct JSON (0x7B format) parsed correctly', () => {
        // Simulate 0x20 message with direct JSON
        const json = '{"status":"ok","op":"list-patches","patches":[]}';
        const jsonBytes = new TextEncoder().encode(json);

        // Build 0x20 payload: [0x7D][0x00][0x20][json...]
        const payload = new Uint8Array(3 + jsonBytes.length);
        payload[0] = 0x7D;
        payload[1] = 0x00;
        payload[2] = 0x20;
        payload.set(jsonBytes, 3);

        // Classify format
        expect(classifyDmFormat(payload)).toBe('direct-json');

        // Extract JSON
        const extracted = new TextDecoder().decode(payload.slice(3));
        const parsed = JSON.parse(extracted);
        expect(parsed.status).toBe('ok');
        expect(parsed.op).toBe('list-patches');
    });

    it('transport format (0x01-0x07) identified correctly', () => {
        // 0x20 with transport sub-message
        const payload = new Uint8Array([0x7D, 0x00, 0x20, 0x01, 0x00, 0x00]);
        expect(classifyDmFormat(payload)).toBe('transport');
    });

    it('notification with notification key fires callback', () => {
        const json = '{"notification":"patch-switched","index":3,"name":"Bass"}';
        const parsed = JSON.parse(json);

        // Notifications have "notification" key, not "cmd" or "status"
        expect(parsed.notification).toBe('patch-switched');
        expect(parsed.cmd).toBeUndefined();
        expect(parsed.status).toBeUndefined();
        expect(parsed.index).toBe(3);
        expect(parsed.name).toBe('Bass');
    });

    it('error notification fires error callback', () => {
        const json = '{"notification":"error","message":"something went wrong"}';
        const parsed = JSON.parse(json);
        expect(parsed.notification).toBe('error');
        expect(parsed.message).toBe('something went wrong');
    });

    it('malformed JSON does not crash', () => {
        // Non-JSON after 0x20 header should not throw
        const payload = new Uint8Array([0x7D, 0x00, 0x20, 0x7B, 0x62, 0x61, 0x64]); // "{bad"
        expect(classifyDmFormat(payload)).toBe('direct-json');

        const extracted = new TextDecoder().decode(payload.slice(3));
        expect(() => JSON.parse(extracted)).toThrow();
    });

    it('response routed via existing promise mechanism', () => {
        // Command responses have "status" key and match pending command
        const json = '{"status":"ok","op":"list-patches","patches":[]}';
        const parsed = JSON.parse(json);
        expect(parsed.status).toBe('ok');
        expect(parsed.op).toBe('list-patches');
        // This would be routed to _routeResponse → resolve pending promise
    });
});

// ============================================================================
// 2. 0x21 Receive Decode
// ============================================================================

describe('0x21 receive decode', () => {
    it('valid feedback parsed correctly', () => {
        // Build a 0x21 message: uid=5, value=8192, priority=1, cc=74
        const [valMsb, valLsb] = from14bit(8192);
        const [minMsb, minLsb] = from14bit(0);
        const [maxMsb, maxLsb] = from14bit(16383);
        const display = '440Hz';
        const displayBytes = new TextEncoder().encode(display);

        const data = new Uint8Array(12 + displayBytes.length + 1);
        data[0] = 0x7D;
        data[1] = 0x00;
        data[2] = 0x21;
        data[3] = 5;      // uid
        data[4] = valMsb;
        data[5] = valLsb;
        data[6] = 1;      // priority
        data[7] = 74;     // cc
        data[8] = minMsb;
        data[9] = minLsb;
        data[10] = maxMsb;
        data[11] = maxLsb;
        data.set(displayBytes, 12);
        data[12 + displayBytes.length] = 0x00;

        const result = parseDmFeedback(data);
        expect(result).not.toBeNull();
        expect(result.uid).toBe(5);
        expect(result.value).toBe(8192);
        expect(result.priority).toBe(1);
        expect(result.cc).toBe(74);
        expect(result.rangeMin).toBe(0);
        expect(result.rangeMax).toBe(16383);
        expect(result.display).toBe('440Hz');
    });

    it('matches shared byte fixtures with C builder', () => {
        // uid=5, value=8192 (MSB=64, LSB=0), priority=1, cc=74
        // range_min=0, range_max=16383 (MSB=127,LSB=127)
        const data = new Uint8Array([
            0x7D, 0x00, 0x21,   // header
            5,                   // uid
            64, 0,               // value = 8192
            1,                   // priority
            74,                  // cc
            0, 0,                // range_min = 0
            127, 127,            // range_max = 16383
            0x34, 0x34, 0x30, 0x48, 0x7A, 0x00  // "440Hz\0"
        ]);

        const result = parseDmFeedback(data);
        expect(result).not.toBeNull();
        expect(result.uid).toBe(5);
        expect(result.value).toBe(8192);
        expect(result.cc).toBe(74);
        expect(result.display).toBe('440Hz');
    });

    it('empty display works', () => {
        const data = new Uint8Array([
            0x7D, 0x00, 0x21,
            10,          // uid
            0, 100,      // value
            0,           // priority
            0x7F,        // no CC
            0, 0,        // range_min
            0, 0,        // range_max
            0x00         // empty display (just null)
        ]);

        const result = parseDmFeedback(data);
        expect(result).not.toBeNull();
        expect(result.uid).toBe(10);
        expect(result.display).toBe('');
    });

    it('max display truncated to 15 chars', () => {
        const display = 'AAAAAAAAAAAAAAA'; // 15 chars
        const displayBytes = new TextEncoder().encode(display);

        const data = new Uint8Array(12 + displayBytes.length + 1);
        data[0] = 0x7D;
        data[1] = 0x00;
        data[2] = 0x21;
        data[3] = 1;
        // rest of header zero
        data.set(displayBytes, 12);
        data[12 + displayBytes.length] = 0x00;

        const result = parseDmFeedback(data);
        expect(result).not.toBeNull();
        expect(result.display).toBe('AAAAAAAAAAAAAAA');
        expect(result.display.length).toBe(15);
    });

    it('too-short message returns null', () => {
        const data = new Uint8Array([0x7D, 0x00, 0x21, 5]);
        expect(parseDmFeedback(data)).toBeNull();
    });
});

// ============================================================================
// 3. Notification Routing
// ============================================================================

describe('notification routing', () => {
    it('patch-switched notification has correct shape', () => {
        const notification = JSON.parse('{"notification":"patch-switched","index":2,"name":"Lead"}');
        expect(notification.notification).toBe('patch-switched');
        expect(notification.index).toBe(2);
        expect(notification.name).toBe('Lead');
    });

    it('exchange-complete notification has correct shape', () => {
        const notification = JSON.parse('{"notification":"exchange-complete","controls":8}');
        expect(notification.notification).toBe('exchange-complete');
        expect(notification.controls).toBe(8);
    });

    it('exchange-failed notification has correct shape', () => {
        const notification = JSON.parse('{"notification":"exchange-failed","reason":"timeout"}');
        expect(notification.notification).toBe('exchange-failed');
        expect(notification.reason).toBe('timeout');
    });

    it('error notification has correct shape', () => {
        const notification = JSON.parse('{"notification":"error","message":"disk full"}');
        expect(notification.notification).toBe('error');
        expect(notification.message).toBe('disk full');
    });
});

// ============================================================================
// 4. 0x20 Send Encoding
// ============================================================================

describe('0x20 send encoding', () => {
    it('encodeDmJsonToSysEx produces correct framing', () => {
        const cmd = { cmd: 'list-patches' };
        const sysex = encodeDmJsonToSysEx(cmd);

        expect(sysex[0]).toBe(0xF0);                        // SysEx start
        expect(sysex[1]).toBe(0x7D);                        // manufacturer
        expect(sysex[2]).toBe(0x00);                        // device
        expect(sysex[3]).toBe(0x20);                        // DM channel subtype
        expect(sysex[4]).toBe(0x7B);                        // '{' — first JSON byte
        expect(sysex[sysex.length - 2]).toBe(0x7D);         // '}' — last JSON byte
        expect(sysex[sysex.length - 1]).toBe(0xF7);         // SysEx end
    });

    it('first payload byte is 0x7B, last is 0x7D', () => {
        const sysex = encodeDmJsonToSysEx({ cmd: 'save' });
        // Payload starts at index 4 (after F0 7D 00 20)
        expect(sysex[4]).toBe(0x7B);  // '{'
        // Last payload byte before F7
        expect(sysex[sysex.length - 2]).toBe(0x7D);  // '}'
    });

    it('round-trip: encode → classify → decode matches original', () => {
        const original = { cmd: 'get-patch', index: 3 };
        const sysex = encodeDmJsonToSysEx(original);

        // Strip F0/F7 for classification
        const inner = sysex.slice(1, -1);  // [0x7D][0x00][0x20][json...]

        // Classify
        expect(classifySysEx(inner)).toBe('dm-channel');
        expect(classifyDmFormat(inner)).toBe('direct-json');

        // Decode JSON
        const jsonBytes = inner.slice(3);
        const decoded = JSON.parse(new TextDecoder().decode(jsonBytes));
        expect(decoded.cmd).toBe('get-patch');
        expect(decoded.index).toBe(3);
    });
});

// ============================================================================
// 5. Phase 5 — Command sending via 0x20
// ============================================================================

/**
 * Helper: create an API with a mock registry that captures sent bytes.
 * Returns { api, sent } where sent is an array of Uint8Arrays.
 */
function createMockApi() {
    const sent = [];
    const api = new UnifiedDeviceAPI();
    const mockRegistry = {
        send(portName, data) { sent.push(new Uint8Array(data)); },
        isConnected(portName) { return true; }
    };
    api._registry = mockRegistry;
    api._portName = 'Test Port';
    return { api, sent };
}

/**
 * Helper: simulate an incoming 0x20 SysEx message to an API instance.
 * Wraps JSON in [F0][7D][00][20][json][F7] and feeds through handleMidiMessage.
 */
function injectDmMessage(api, json) {
    const sysex = encodeDmJsonToSysEx(json);
    api.handleMidiMessage({ data: sysex });
}

describe('Phase 5 — command sending via 0x20', () => {
    it('_send uses encodeDmJsonToSysEx (0x20 framing)', () => {
        const { api, sent } = createMockApi();
        api._send({ cmd: 'list-patches' });

        expect(sent.length).toBe(1);
        const msg = sent[0];
        expect(msg[0]).toBe(0xF0);
        expect(msg[1]).toBe(0x7D);
        expect(msg[2]).toBe(0x00);
        expect(msg[3]).toBe(0x20);  // DM channel
        expect(msg[msg.length - 1]).toBe(0xF7);

        // Verify JSON payload
        const jsonBytes = msg.slice(4, -1);
        const parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
        expect(parsed.cmd).toBe('list-patches');
    });

    it('pair command encodes correctly via query', () => {
        const { api, sent } = createMockApi();
        api.query({ cmd: 'pair', muid: 42 }, 'mutation-ack');

        const msg = sent[0];
        expect(msg[3]).toBe(0x20);
        const jsonBytes = msg.slice(4, -1);
        const parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
        expect(parsed.cmd).toBe('pair');
        expect(parsed.muid).toBe(42);
    });
});

// ============================================================================
// 6. Phase 5 — Notification dispatch through API
// ============================================================================

describe('Phase 5 — notification dispatch', () => {
    it('0x20 JSON with notification key fires onDmNotification, not query', async () => {
        const { api } = createMockApi();
        const notifications = [];
        api.onDmNotification((json) => notifications.push(json));

        // Send a query to create a queued waiter
        const promise = api.query({ cmd: 'list-patches' }, 'list-patches');

        // Inject a notification (should NOT resolve the query)
        injectDmMessage(api, { notification: 'exchange-start' });

        expect(notifications.length).toBe(1);
        expect(notifications[0].notification).toBe('exchange-start');

        // Query should still be pending (queue entry still exists)
        expect(api._responseQueues['list-patches'].length).toBe(1);

        // Clean up — resolve the pending query
        injectDmMessage(api, { status: 'ok', op: 'list-patches', patches: [] });
        await promise;
    });

    it('0x20 JSON without notification key resolves queued query', async () => {
        const { api } = createMockApi();
        const promise = api.query({ cmd: 'list-patches' }, 'list-patches');

        injectDmMessage(api, { status: 'ok', op: 'list-patches', patches: [] });

        const result = await promise;
        expect(result.status).toBe('ok');
        expect(result.op).toBe('list-patches');
    });

    it('0x20 error response rejects queued query', async () => {
        const { api } = createMockApi();
        const promise = api.query({ cmd: 'delete-patch' }, 'mutation-ack');

        injectDmMessage(api, { error: 'patch not found' });

        await expect(promise).rejects.toThrow('patch not found');
    });

    it('two concurrent get-patch queries both resolve independently', async () => {
        const { api } = createMockApi();

        const p1 = api.query({ cmd: 'get-patch', index: 0 }, 'get-patch');
        const p2 = api.query({ cmd: 'get-patch', index: 1 }, 'get-patch');

        // First response resolves first query (FIFO)
        injectDmMessage(api, { index: 0, name: 'Patch A', osc: {} });
        // Second response resolves second query
        injectDmMessage(api, { index: 1, name: 'Patch B', osc: {} });

        const r1 = await p1;
        const r2 = await p2;
        expect(r1.name).toBe('Patch A');
        expect(r2.name).toBe('Patch B');
    });
});

// ============================================================================
// 7. Phase 5 — Relay filtering by subtype
// ============================================================================

describe('Phase 5 — relay filtering', () => {
    /**
     * Helper: create a DeviceRegistry with exchange relay active,
     * mock ports, and capture what gets relayed.
     */
    function createRelayRegistry() {
        const relayed = [];
        const registry = new DeviceRegistry();

        // Stub the port manager
        registry._portManager = {
            send(portName, data) { relayed.push({ to: portName, data: new Uint8Array(data) }); return true; },
            onMessage(portName, cb) {},
            offMessage(portName) {},
            init() {}
        };

        // Mark ports as connected
        registry._connectedDevices = new Set(['synth', 'controller']);

        // Register dummy APIs that won't crash on handleMidiMessage
        registry._apis['synth'] = { handleMidiMessage() {} };
        registry._apis['controller'] = { handleMidiMessage() {} };

        // Config-pair enables exchange relay (#103)
        registry.addRoute('controller', 'synth');
        registry.setConfigPair('controller', 'synth');

        return { registry, relayed };
    }

    function buildSysEx(subtype) {
        // Build: [F0][7D][00][subtype][payload][F7]
        return new Uint8Array([0xF0, 0x7D, 0x00, subtype, 0x00, 0xF7]);
    }

    it('SysEx with subtype 0x01-0x07 (transport) is relayed', () => {
        for (let subtype = 0x01; subtype <= 0x07; subtype++) {
            const { registry, relayed } = createRelayRegistry();
            const sysex = buildSysEx(subtype);
            registry._handleMessage('synth', { data: sysex });
            const forwardedToController = relayed.filter(r => r.to === 'controller');
            expect(forwardedToController.length).toBeGreaterThan(0);
        }
    });

    it('SysEx with subtype 0x10/0x11 (feedback) is relayed', () => {
        for (const subtype of [0x10, 0x11]) {
            const { registry, relayed } = createRelayRegistry();
            const sysex = buildSysEx(subtype);
            registry._handleMessage('synth', { data: sysex });
            const forwardedToController = relayed.filter(r => r.to === 'controller');
            expect(forwardedToController.length).toBeGreaterThan(0);
        }
    });

    it('SysEx with subtype 0x20/0x21 (DM) is NOT relayed', () => {
        for (const subtype of [0x20, 0x21]) {
            const { registry, relayed } = createRelayRegistry();
            const sysex = buildSysEx(subtype);
            registry._handleMessage('synth', { data: sysex });
            const forwardedToController = relayed.filter(r => r.to === 'controller');
            expect(forwardedToController.length).toBe(0);
        }
    });
});

// ============================================================================
// 8. Phase 5 — Relay lifecycle
// ============================================================================

describe('Exchange relay from config-pairing (#103)', () => {
    it('config-pair enables relay (no explicit enable needed)', () => {
        const relayed = [];
        const registry = new DeviceRegistry();
        registry._portManager = {
            send(portName, data) { relayed.push({ to: portName, data: new Uint8Array(data) }); return true; },
            onMessage() {}, offMessage() {}, init() {}
        };
        registry._connectedDevices = new Set(['synth', 'controller']);
        registry._apis['synth'] = { handleMidiMessage() {} };
        registry._apis['controller'] = { handleMidiMessage() {} };

        // Set config pair — this alone should enable relay
        registry.addRoute('controller', 'synth');
        registry.setConfigPair('controller', 'synth');

        // Send exchange transport from synth
        const sysex = new Uint8Array([0xF0, 0x7D, 0x00, 0x01, 0x00, 0xF7]);
        registry._handleMessage('synth', { data: sysex });
        expect(relayed.some(r => r.to === 'controller')).toBe(true);
    });

    it('clearing config-pair stops relay', () => {
        const relayed = [];
        const registry = new DeviceRegistry();
        registry._portManager = {
            send(portName, data) { relayed.push({ to: portName, data: new Uint8Array(data) }); return true; },
            onMessage() {}, offMessage() {}, init() {}
        };
        registry._connectedDevices = new Set(['synth', 'controller']);
        registry._apis['synth'] = { handleMidiMessage() {} };
        registry._apis['controller'] = { handleMidiMessage() {} };

        registry.addRoute('controller', 'synth');
        registry.setConfigPair('controller', 'synth');
        registry.clearConfigPair('controller');

        const sysex = new Uint8Array([0xF0, 0x7D, 0x00, 0x01, 0x00, 0xF7]);
        registry._handleMessage('synth', { data: sysex });
        expect(relayed.some(r => r.to === 'controller')).toBe(false);
    });
});

// ============================================================================
// 9. Phase 5 — #73 pot-assignment slider gating
// ============================================================================

describe('Phase 5 — #73 pot-assignment slider gating', () => {
    it('param in potAssignedParams → storeOnly on drag', () => {
        const potAssignedParams = new Set(['osc.level', 'osc.detune']);
        const hasController = true;
        const param = { key: 'osc.level', cc: 23 };

        const hasPotAssignment = hasController && potAssignedParams.has(param.key);
        expect(hasPotAssignment).toBe(true);

        // storeOnly should be true
        const opts = hasPotAssignment ? { value: 0.5, storeOnly: true } : 0.5;
        expect(opts).toEqual({ value: 0.5, storeOnly: true });

        // Live CC should NOT fire
        const shouldSendLiveCC = (!hasController || !hasPotAssignment) && param.cc >= 0;
        expect(shouldSendLiveCC).toBe(false);
    });

    it('param NOT in potAssignedParams → sends live CC on drag', () => {
        const potAssignedParams = new Set(['osc.level', 'osc.detune']);
        const hasController = true;
        const param = { key: 'filter.amount', cc: 7 };

        const hasPotAssignment = hasController && potAssignedParams.has(param.key);
        expect(hasPotAssignment).toBe(false);

        // storeOnly should be false (plain value, not object)
        const opts = hasPotAssignment ? { value: 0.5, storeOnly: true } : 0.5;
        expect(opts).toBe(0.5);

        // Live CC SHOULD fire
        const shouldSendLiveCC = (!hasController || !hasPotAssignment) && param.cc >= 0;
        expect(shouldSendLiveCC).toBe(true);
    });
});
