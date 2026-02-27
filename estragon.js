/**
 * Estragon - 2-operator FM synth (virtual device)
 *
 * Capabilities: IDENTITY, SYNTH, PATCHES, PARAMS, CONFIG
 *
 * Audio chain (per voice):
 *   modOsc(noteFreq * modRatio) -> modGain(modDepth) -> carrier.frequency
 *   carrierOsc(noteFreq * carrierRatio) -> envGain(ADSR) -> masterGain -> destination
 *
 * Handles:
 * - get-device-info -> identity response
 * - controller-available -> triggers exchange (get-control-surface -> set-patch)
 * - config-get -> topology (groups, chains, mod_targets, waves)
 * - list-patches / get-patch / select-patch / create-patch / delete-patch
 * - update-param -> applies param + sends value feedback
 * - save -> ACK
 * - Note On/Off -> FM synthesis via Web Audio
 */

class Estragon extends VirtualDevice {
    constructor(portManager, portName) {
        super(portManager, portName || 'AP Estragon');

        // Audio
        this._audioCtx = null;
        this._voices = new Map(); // channel -> { modOsc, modGain, carrierOsc, envGain, masterGain }

        // Preset patches
        this._patches = [
            this._makePreset('FM Init', 1.0, 2.0, 200, 0, 0, 0.01, 0.3, 0.7, 0.5),
            this._makePreset('Bell',    1.0, 3.5, 800, 0, 0, 0.001, 1.5, 0.0, 2.0),
            this._makePreset('Bass',    1.0, 1.0, 1500, 0, 0, 0.01, 0.2, 0.4, 0.1),
            this._makePreset('Pad',     1.0, 2.0, 100, 0, 0, 0.8, 0.5, 0.8, 1.5)
        ];
        this._currentPatchIndex = 0;

        // Parts: channel → patch mapping (multi-timbral support)
        this._parts = [
            { index: 0, patchIndex: 0, channels: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] }
        ];
        this._channelPatchMap = new Array(16).fill(0); // channel → patchIndex

        // Exchange state
        this._exchangeState = 'IDLE';
        this._controllerPort = null;

        // Topology (returned by config-get for patch editor)
        this._topology = {
            status: 'ok', op: 'config',
            groups: [
                { id: 'operators', name: 'Operators', color: '#FF7043', fixed: true,
                  modules: [
                    { id: 'MODULATOR', name: 'Modulator' },
                    { id: 'CARRIER', name: 'Carrier' }
                  ] },
                { id: 'envelope', name: 'Envelope', color: '#FFC107', fixed: true,
                  modules: [
                    { id: 'AMP_ENV', name: 'Amp Env' }
                  ] },
                { id: 'expression', name: 'Expression', color: '#9C27B0',
                  modules: [
                    { id: 'VELOCITY', name: 'Velocity' },
                    { id: 'PRESSURE', name: 'Pressure' },
                    { id: 'BEND', name: 'Bend' }
                  ] }
            ],
            chains: [
                { color: '#FF7043', stages: [['MODULATOR'], ['CARRIER']] }
            ],
            mod_targets: {
                VELOCITY: ['CARRIER_LEVEL', 'MOD_DEPTH', 'CARRIER_RATIO', 'MOD_RATIO',
                           'AMP_ENV_ATTACK', 'AMP_ENV_DECAY', 'AMP_ENV_SUSTAIN', 'AMP_ENV_RELEASE'],
                PRESSURE: ['CARRIER_LEVEL', 'MOD_DEPTH', 'CARRIER_RATIO', 'MOD_RATIO', 'AMP_ENV_SUSTAIN'],
                BEND:     ['CARRIER_RATIO', 'MOD_RATIO', 'CARRIER_LEVEL', 'MOD_DEPTH'],
                AMP_ENV:  ['CARRIER_LEVEL']
            },
            waves: {
                osc: [
                    { id: 0, name: 'Sine' },
                    { id: 1, name: 'Triangle' },
                    { id: 2, name: 'Saw' },
                    { id: 3, name: 'Square' }
                ]
            }
        };

        // Wave type map (id -> Web Audio type)
        this._waveTypes = ['sine', 'triangle', 'sawtooth', 'square'];
    }

    //--------------------------------------------------------------
    // Preset factory
    //--------------------------------------------------------------

    _makePreset(name, cRatio, mRatio, mDepth, cWave, mWave, atk, dec, sus, rel) {
        return {
            index: 0, // filled on read
            name,
            version: '1.0',
            CARRIER: {
                name: 'Carrier',
                CARRIER_RATIO: { name: 'Ratio', priority: 1, initial: cRatio, range: [0.5, 16], cc: 20 },
                CARRIER_LEVEL: { name: 'Level', priority: 7, initial: 0.7, range: [0, 1], cc: -1 },
                CARRIER_WAVE:  { name: 'Wave',  priority: -1, initial: cWave, range: [0, 3], cc: -1 }
            },
            MODULATOR: {
                name: 'Modulator',
                MOD_RATIO: { name: 'Ratio', priority: 2, initial: mRatio, range: [0.5, 16], cc: 21 },
                MOD_DEPTH: { name: 'Depth', priority: 0, initial: mDepth, range: [0, 5000], cc: 22 },
                MOD_WAVE:  { name: 'Wave',  priority: -1, initial: mWave, range: [0, 3], cc: -1 }
            },
            AMP_ENV: {
                name: 'Amp Env',
                targets: ['CARRIER_LEVEL'],
                AMP_ENV_ATTACK:  { name: 'Attack',  priority: 3, initial: atk, range: [0.001, 2], cc: 23 },
                AMP_ENV_DECAY:   { name: 'Decay',   priority: 4, initial: dec, range: [0.001, 2], cc: 24 },
                AMP_ENV_SUSTAIN: { name: 'Sustain', priority: 5, initial: sus, range: [0, 1],     cc: 25 },
                AMP_ENV_RELEASE: { name: 'Release', priority: 6, initial: rel, range: [0.001, 3], cc: 26 }
            },
            VELOCITY: { name: 'Velocity' },
            PRESSURE: { name: 'Pressure' },
            BEND: { name: 'Bend' }
        };
    }

    //--------------------------------------------------------------
    // Command dispatch
    //--------------------------------------------------------------

    handleCommand(json) {
        switch (json.cmd) {
            case 'get-device-info':
                this._sendResponse({
                    status: 'ok',
                    op: 'device-info',
                    name: 'Estragon',
                    project: 'Estragon',
                    version: '1.0.0',
                    capabilities: PORT_CAPABILITIES[this._portName]
                });
                break;

            case 'controller-available':
                this._handleControllerAvailable(json);
                break;

            case 'config-get':
                this._sendResponse(this._topology);
                break;

            case 'list-patches':
                this._sendResponse({
                    patches: this._patches.map(p => p.name),
                    current_index: this._currentPatchIndex
                });
                break;

            case 'get-patch':
                this._handleGetPatch(json);
                break;

            case 'select-patch':
                this._currentPatchIndex = json.index;
                // Update Part 0 to match (backward compat for single-part controllers)
                if (this._parts.length > 0) {
                    this._parts[0].patchIndex = json.index;
                }
                this._rebuildChannelPatchMap();
                this._sendResponse({ status: 'ok', op: 'select-patch', current_index: json.index });
                break;

            case 'get-parts':
                this._sendResponse({
                    status: 'ok', op: 'parts',
                    parts: this._parts,
                    patches: this._patches.map(p => p.name)
                });
                break;

            case 'set-parts':
                this._parts = json.parts;
                this._rebuildChannelPatchMap();
                this._sendResponse({ status: 'ok', op: 'set-parts' });
                break;

            case 'create-patch': {
                const name = json.name || `Patch ${this._patches.length + 1}`;
                this._patches.push(this._makePreset(name, 1.0, 2.0, 200, 0, 0, 0.01, 0.3, 0.7, 0.5));
                this._sendResponse({ status: 'ok', op: 'create-patch' });
                break;
            }

            case 'delete-patch':
                if (json.index >= 0 && json.index < this._patches.length && this._patches.length > 1) {
                    this._patches.splice(json.index, 1);
                    if (this._currentPatchIndex >= this._patches.length) {
                        this._currentPatchIndex = this._patches.length - 1;
                    }
                }
                this._sendResponse({ status: 'ok', op: 'delete-patch' });
                break;

            case 'rename-patch':
                if (json.index >= 0 && json.index < this._patches.length) {
                    this._patches[json.index].name = json.name;
                }
                this._sendResponse({ status: 'ok', op: 'rename-patch' });
                break;

            case 'move-patch':
                this._handleMovePatch(json);
                break;

            case 'update-param':
                this._handleUpdateParam(json);
                break;

            case 'toggle-module':
                this._handleToggleModule(json);
                break;

            case 'toggle-modulation':
                this._handleToggleModulation(json);
                break;

            case 'update-modulation-amount':
                this._handleUpdateModAmount(json);
                break;

            case 'toggle-cc':
                this._sendResponse({ status: 'ok', op: 'toggle-cc' });
                break;

            case 'move-module':
                this._sendResponse({ status: 'ok', op: 'move-module' });
                break;

            case 'save':
                this._sendResponse({ status: 'saved' });
                break;

            // Exchange protocol: 'thanks' removed — exchange completes
            // after sending set-patch (matches Candide behavior)

            default:
                console.log(`[${this._portName}] Unhandled: ${json.cmd}`);
                this._sendResponse({ status: 'ok', op: json.cmd });
        }
    }

    handleMidi(data) {
        const status = data[0] & 0xF0;
        const channel = data[0] & 0x0F;

        if (status === 0x90 && data[2] > 0) {
            this._noteOn(channel, data[1], data[2]);
        } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
            this._noteOff(channel);
        } else if (status === 0xE0) {
            // Pitch bend
            const raw = data[1] | (data[2] << 7);
            const bend = (raw - 8192) / 8192; // -1 to +1
            this._applyBend(channel, bend);
        } else if (status === 0xD0) {
            // Channel pressure (aftertouch)
            const pressure = data[1] / 127;
            this._applyPressure(channel, pressure);
        }
    }

    //--------------------------------------------------------------
    // Exchange protocol
    //--------------------------------------------------------------

    // Receive exchange responses (no cmd field) relayed from controller
    handleExchangeResponse(json) {
        if (json.op === 'control-surface' && this._exchangeState === 'EXCHANGE') {
            this._handleControlSurface(json);
        }
    }

    _handleControllerAvailable(json) {
        this._exchangeState = 'EXCHANGE';
        this._controllerPort = json.port;
        console.log(`[${this._portName}] Controller available: ${json.device}`);

        this._sendResponse({ status: 'ok', op: 'controller-available' });

        setTimeout(() => {
            this._sendResponse({
                cmd: 'get-control-surface',
                mfg: 'AttachPart',
                device: 'Estragon',
                version: '1.0.0'
            });
        }, 50);
    }

    _handleControlSurface(json) {
        console.log(`[${this._portName}] Got control surface: ${json.device}`);

        // Configure parts from controller's advertised part count
        const numParts = json.parts || 1;
        if (numParts > 1) {
            const channelsPerPart = Math.floor(16 / numParts);
            this._parts = [];
            for (let i = 0; i < numParts; i++) {
                const startCh = i * channelsPerPart;
                const endCh = (i === numParts - 1) ? 16 : startCh + channelsPerPart;
                this._parts.push({
                    index: i,
                    patchIndex: i % this._patches.length,
                    channels: Array.from({ length: endCh - startCh }, (_, j) => startCh + j)
                });
            }
            this._rebuildChannelPatchMap();
            console.log(`[${this._portName}] Configured ${numParts} parts (${channelsPerPart} ch each)`);
        }

        // Build controls list from current patch params with cc > 0
        const patch = this._patches[this._currentPatchIndex];
        const controls = [];
        for (const modKey of ['CARRIER', 'MODULATOR', 'AMP_ENV']) {
            const mod = patch[modKey];
            if (!mod) continue;
            for (const [paramKey, param] of Object.entries(mod)) {
                if (paramKey === 'name') continue;
                if (param.cc > 0) {
                    controls.push({
                        input: paramKey,
                        label: param.name,
                        cc: param.cc,
                        priority: param.priority
                    });
                }
            }
        }

        setTimeout(() => {
            this._sendResponse({
                cmd: 'set-patch',
                name: patch.name,
                patches: this._patches.map(p => p.name),
                controls
            });
            // Exchange complete — matches Candide behavior (completes after sending set-patch)
            this._exchangeState = 'IDLE';
            console.log(`[${this._portName}] Exchange complete`);
        }, 50);
    }

    //--------------------------------------------------------------
    // Patch + params
    //--------------------------------------------------------------

    _handleGetPatch(json) {
        const idx = json.index;
        if (idx < 0 || idx >= this._patches.length) {
            this._sendResponse({ error: 'Invalid patch index' });
            return;
        }

        const patch = this._patches[idx];
        // Deep clone to avoid mutations, set index; exclude _disabled stash
        const response = JSON.parse(JSON.stringify(patch));
        delete response._disabled;
        response.index = idx;
        this._sendResponse(response);
    }

    _handleUpdateParam(json) {
        const patch = this._patches[json.index];
        if (!patch) {
            this._sendResponse({ error: 'Invalid patch index' });
            return;
        }

        // Find param across modules
        for (const modKey of ['CARRIER', 'MODULATOR', 'AMP_ENV']) {
            const mod = patch[modKey];
            if (!mod || !mod[json.param]) continue;

            if (json.value !== undefined) {
                mod[json.param].initial = json.value;

                // Send value feedback SysEx if param has a CC
                if (mod[json.param].cc > 0) {
                    this._sendValueFeedback(mod[json.param].cc, `${json.value}`);
                }
            }
            if (json.priority !== undefined) {
                mod[json.param].priority = json.priority;
            }
            break;
        }

        this._sendResponse({ status: 'ok', op: 'update-param' });
    }

    _handleMovePatch(json) {
        const from = json.fromIdx;
        const to = json.toIdx;
        if (from >= 0 && from < this._patches.length && to >= 0 && to < this._patches.length) {
            const [moved] = this._patches.splice(from, 1);
            this._patches.splice(to, 0, moved);
        }
        this._sendResponse({ status: 'ok', op: 'move-patch' });
    }

    _handleToggleModule(json) {
        const patch = this._patches[json.index];
        if (!patch) {
            this._sendResponse({ error: 'Invalid patch index' });
            return;
        }

        const moduleId = json.module;
        if (json.enabled) {
            // Re-enable: restore from stashed data or create defaults
            if (patch._disabled?.[moduleId]) {
                patch[moduleId] = patch._disabled[moduleId];
                delete patch._disabled[moduleId];
            }
        } else {
            // Disable: stash module data, strip params (keep name + targets)
            if (patch[moduleId]) {
                if (!patch._disabled) patch._disabled = {};
                patch._disabled[moduleId] = patch[moduleId];
                delete patch[moduleId];

                // Also remove any _AMOUNT params referencing this module as source
                for (const [modKey, modData] of Object.entries(patch)) {
                    if (typeof modData !== 'object' || !modData) continue;
                    if (['name', 'version', 'index', '_disabled'].includes(modKey)) continue;
                    for (const key of Object.keys(modData)) {
                        if (key.endsWith(`_${moduleId}_AMOUNT`)) {
                            delete modData[key];
                        }
                    }
                }
            }
        }

        this._sendResponse({ status: 'ok', op: 'toggle-module' });
    }

    _handleToggleModulation(json) {
        const patch = this._patches[json.index];
        if (!patch) {
            this._sendResponse({ error: 'Invalid patch index' });
            return;
        }

        const { target: targetParam, source: sourceModule, enabled } = json;

        // Find which module owns the target param
        for (const [modKey, modData] of Object.entries(patch)) {
            if (typeof modData !== 'object' || !modData) continue;
            if (['name', 'version', 'index', '_disabled'].includes(modKey)) continue;

            if (modData[targetParam]) {
                const amountKey = `${targetParam}_${sourceModule}_AMOUNT`;
                if (enabled) {
                    // Create amount param with default value
                    modData[amountKey] = { name: `${sourceModule} Amount`, initial: 0.5, range: [-1, 1] };
                } else {
                    // Remove amount param
                    delete modData[amountKey];
                }
                break;
            }
        }

        this._sendResponse({ status: 'ok', op: 'toggle-modulation' });
    }

    _handleUpdateModAmount(json) {
        const patch = this._patches[json.index];
        if (!patch) {
            this._sendResponse({ error: 'Invalid patch index' });
            return;
        }

        const { param: amountParam, value } = json;

        // Find the module containing this _AMOUNT param
        for (const [modKey, modData] of Object.entries(patch)) {
            if (typeof modData !== 'object' || !modData) continue;
            if (['name', 'version', 'index', '_disabled'].includes(modKey)) continue;

            if (modData[amountParam]) {
                if (typeof modData[amountParam] === 'object') {
                    modData[amountParam].initial = value;
                } else {
                    modData[amountParam] = value;
                }
                break;
            }
        }

        this._sendResponse({ status: 'ok', op: 'update-modulation-amount' });
    }

    //--------------------------------------------------------------
    // Value feedback (binary SysEx, same format as Candide)
    //--------------------------------------------------------------

    _sendValueFeedback(cc, text) {
        // F0 7D 00 10 CC text... 00 F7
        const textBytes = new TextEncoder().encode(text);
        const msg = new Uint8Array(5 + textBytes.length + 2);
        msg[0] = 0xF0;
        msg[1] = 0x7D;
        msg[2] = 0x00;
        msg[3] = 0x10;
        msg[4] = cc & 0x7F;
        msg.set(textBytes, 5);
        msg[5 + textBytes.length] = 0x00;
        msg[5 + textBytes.length + 1] = 0xF7;
        this._sendMidi(msg);
    }

    //--------------------------------------------------------------
    // Parts (multi-timbral channel → patch mapping)
    //--------------------------------------------------------------

    _rebuildChannelPatchMap() {
        this._channelPatchMap.fill(this._currentPatchIndex);
        for (const part of this._parts) {
            for (const ch of part.channels) {
                this._channelPatchMap[ch] = part.patchIndex;
            }
        }
    }

    //--------------------------------------------------------------
    // Web Audio — 2-op FM engine
    //--------------------------------------------------------------

    _ensureAudioCtx() {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }
        return this._audioCtx;
    }

    // Read _AMOUNT params for a control source from patch data
    // Returns { CARRIER_LEVEL: 0.5, MOD_DEPTH: -0.3, ... }
    _getModAmounts(patch, source) {
        const amounts = {};
        const suffix = `_${source}_AMOUNT`;
        for (const [modKey, modData] of Object.entries(patch)) {
            if (typeof modData !== 'object' || !modData) continue;
            if (['name', 'version', 'index', '_disabled'].includes(modKey)) continue;
            for (const [key, value] of Object.entries(modData)) {
                if (!key.endsWith(suffix)) continue;
                const param = key.slice(0, -(source.length + 8)); // Strip _{SOURCE}_AMOUNT
                amounts[param] = typeof value === 'object' ? value.initial : value;
            }
        }
        return amounts;
    }

    _noteOn(channel, note, velocity) {
        const ctx = this._ensureAudioCtx();
        const now = ctx.currentTime;
        const patchIdx = this._channelPatchMap[channel];
        const patch = this._patches[patchIdx];

        // Read base params from current patch
        const baseCarrierRatio = patch.CARRIER.CARRIER_RATIO.initial;
        const baseCarrierLevel = patch.CARRIER.CARRIER_LEVEL.initial;
        const carrierWave      = patch.CARRIER.CARRIER_WAVE.initial;
        const baseModRatio     = patch.MODULATOR.MOD_RATIO.initial;
        const baseModDepth     = patch.MODULATOR.MOD_DEPTH.initial;
        const modWave          = patch.MODULATOR.MOD_WAVE.initial;
        const baseAttack       = patch.AMP_ENV.AMP_ENV_ATTACK.initial;
        const baseDecay        = patch.AMP_ENV.AMP_ENV_DECAY.initial;
        const baseSustain      = patch.AMP_ENV.AMP_ENV_SUSTAIN.initial;
        const baseRelease      = patch.AMP_ENV.AMP_ENV_RELEASE.initial;

        // Apply velocity modulation (data-driven from _AMOUNT params)
        // Formula: effective = base * (1 - amount + amount * vel)
        //   amount=0 → base,  amount=1 vel=1 → base,  amount=1 vel=0 → 0
        const velAmounts = this._getModAmounts(patch, 'VELOCITY');
        const vel = velocity / 127;
        const applyVel = (base, paramKey) => {
            const a = velAmounts[paramKey];
            if (a === undefined) return base;
            return Math.max(0, base * (1 - a + a * vel));
        };

        const carrierRatio = applyVel(baseCarrierRatio, 'CARRIER_RATIO');
        const carrierLevel = applyVel(baseCarrierLevel, 'CARRIER_LEVEL');
        const modRatio     = applyVel(baseModRatio, 'MOD_RATIO');
        const modDepth     = applyVel(baseModDepth, 'MOD_DEPTH');
        const attack       = applyVel(baseAttack, 'AMP_ENV_ATTACK');
        const decay        = applyVel(baseDecay, 'AMP_ENV_DECAY');
        const sustain      = applyVel(baseSustain, 'AMP_ENV_SUSTAIN');
        const release      = applyVel(baseRelease, 'AMP_ENV_RELEASE');

        const noteFreq = 440 * Math.pow(2, (note - 69) / 12);

        // Stop previous voice on same channel
        this._noteOff(channel);

        // Modulator oscillator -> modGain -> carrier.frequency
        const modOsc = ctx.createOscillator();
        modOsc.type = this._waveTypes[modWave] || 'sine';
        modOsc.frequency.value = noteFreq * modRatio;

        const modGain = ctx.createGain();
        modGain.gain.value = modDepth;

        // Carrier oscillator
        const carrierOsc = ctx.createOscillator();
        carrierOsc.type = this._waveTypes[carrierWave] || 'sine';
        carrierOsc.frequency.value = noteFreq * carrierRatio;

        // FM connection: mod output wiggles carrier frequency
        modOsc.connect(modGain);
        modGain.connect(carrierOsc.frequency);

        // Envelope gain (ADSR shapes amplitude)
        const envGain = ctx.createGain();
        envGain.gain.setValueAtTime(0, now);
        envGain.gain.linearRampToValueAtTime(carrierLevel, now + attack);
        envGain.gain.setTargetAtTime(carrierLevel * sustain, now + attack, decay / 3);

        // Master gain (overall level, also used for continuous level modulation)
        const masterGain = ctx.createGain();
        masterGain.gain.value = 0.3;

        // Connect: carrier -> env -> master -> destination
        carrierOsc.connect(envGain);
        envGain.connect(masterGain);
        masterGain.connect(ctx.destination);

        // Start oscillators
        modOsc.start(now);
        carrierOsc.start(now);

        this._voices.set(channel, {
            modOsc, modGain, carrierOsc, envGain, masterGain,
            release, note, noteFreq, patchIndex: patchIdx,
            // Velocity-adjusted base values (for pressure/bend to modulate from)
            carrierRatio, carrierLevel, modRatio, modDepth, sustain,
            // Modulation amounts for continuous control (read once at note-on)
            pressureAmounts: this._getModAmounts(patch, 'PRESSURE'),
            bendAmounts: this._getModAmounts(patch, 'BEND'),
            // Current continuous values
            currentPressure: 0,
            currentBend: 0
        });
    }

    _noteOff(channel) {
        const voice = this._voices.get(channel);
        if (!voice) return;

        const ctx = this._audioCtx;
        const now = ctx.currentTime;
        const { modOsc, carrierOsc, envGain, release } = voice;

        // Release: ramp to 0 over release time
        envGain.gain.cancelScheduledValues(now);
        envGain.gain.setValueAtTime(envGain.gain.value, now);
        envGain.gain.linearRampToValueAtTime(0, now + release);

        // Schedule stop after release completes
        const stopTime = now + release + 0.05;
        modOsc.stop(stopTime);
        carrierOsc.stop(stopTime);

        this._voices.delete(channel);
    }

    // Combined pressure + bend modulation (data-driven from _AMOUNT params)
    // Both sources contribute additively to the same audio params.
    // Reads LIVE amounts from patch data so wires added mid-note take effect.
    _updateContinuousMod(channel) {
        const voice = this._voices.get(channel);
        if (!voice) return;

        const patch = this._patches[voice.patchIndex];
        const pressureAmounts = this._getModAmounts(patch, 'PRESSURE');
        const bendAmounts = this._getModAmounts(patch, 'BEND');
        const hasPressure = Object.keys(pressureAmounts).length > 0;
        const hasBend = Object.keys(bendAmounts).length > 0;
        if (!hasPressure && !hasBend) return;

        const now = this._audioCtx.currentTime;
        const p = voice.currentPressure;
        const b = voice.currentBend;

        // Carrier frequency (ratio → semitones → frequency)
        const cRatioP = (pressureAmounts.CARRIER_RATIO || 0) * p * 12;
        const cRatioB = (bendAmounts.CARRIER_RATIO || 0) * b * 12;
        const cSemitones = cRatioP + cRatioB;
        voice.carrierOsc.frequency.setValueAtTime(
            voice.noteFreq * voice.carrierRatio * Math.pow(2, cSemitones / 12), now
        );

        // Modulator frequency
        const mRatioP = (pressureAmounts.MOD_RATIO || 0) * p * 12;
        const mRatioB = (bendAmounts.MOD_RATIO || 0) * b * 12;
        const mSemitones = mRatioP + mRatioB;
        voice.modOsc.frequency.setValueAtTime(
            voice.noteFreq * voice.modRatio * Math.pow(2, mSemitones / 12), now
        );

        // Mod depth (multiplicative: 1 + combined offset)
        const depthP = (pressureAmounts.MOD_DEPTH || 0) * p;
        const depthB = (bendAmounts.MOD_DEPTH || 0) * b;
        voice.modGain.gain.setValueAtTime(
            Math.max(0, voice.modDepth * (1 + depthP + depthB)), now
        );

        // Carrier level (via masterGain, base 0.3)
        const levelP = (pressureAmounts.CARRIER_LEVEL || 0) * p;
        const levelB = (bendAmounts.CARRIER_LEVEL || 0) * b;
        voice.masterGain.gain.setValueAtTime(
            Math.max(0, 0.3 * (1 + levelP + levelB)), now
        );

        // Envelope sustain level (pressure can swell/reduce sustain)
        const susP = (pressureAmounts.AMP_ENV_SUSTAIN || 0) * p;
        const susB = (bendAmounts.AMP_ENV_SUSTAIN || 0) * b;
        if (susP !== 0 || susB !== 0) {
            const effSustain = Math.max(0, Math.min(1, voice.sustain * (1 + susP + susB)));
            voice.envGain.gain.cancelScheduledValues(now);
            voice.envGain.gain.setValueAtTime(voice.envGain.gain.value, now);
            voice.envGain.gain.setTargetAtTime(voice.carrierLevel * effSustain, now, 0.05);
        }
    }

    _applyBend(channel, bend) {
        const voice = this._voices.get(channel);
        if (!voice) return;
        voice.currentBend = bend;
        this._updateContinuousMod(channel);
    }

    _applyPressure(channel, pressure) {
        const voice = this._voices.get(channel);
        if (!voice) return;
        voice.currentPressure = pressure;
        this._updateContinuousMod(channel);
    }
}

window.Estragon = Estragon;
