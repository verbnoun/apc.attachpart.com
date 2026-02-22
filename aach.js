/**
 * Aach - 2-operator FM synth (virtual device)
 *
 * Capabilities: IDENTITY, SYNTH, PATCHES, PARAMS
 *
 * Audio chain (per voice):
 *   modOsc(noteFreq * modRatio) -> modGain(modDepth) -> carrier.frequency
 *   carrierOsc(noteFreq * carrierRatio) -> envGain(ADSR) -> masterGain -> destination
 *
 * Handles:
 * - get-device-info -> identity response
 * - controller-available -> triggers exchange (get-control-surface -> set-patch)
 * - config-get -> topology (modules, mod_targets, audio_chain, waves)
 * - list-patches / get-patch / select-patch / create-patch / delete-patch
 * - update-param -> applies param + sends value feedback
 * - save -> ACK
 * - Note On/Off -> FM synthesis via Web Audio
 */

class Aach extends VirtualDevice {
    constructor(portManager, portName) {
        super(portManager, portName || 'AP Aach');

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

        // Exchange state
        this._exchangeState = 'IDLE';
        this._controllerPort = null;

        // Topology (returned by config-get for patch editor)
        this._topology = {
            status: 'ok', op: 'config', readonly: true,
            modules: {
                audio: [
                    { id: 'CARRIER', name: 'Carrier' },
                    { id: 'MODULATOR', name: 'Modulator' }
                ],
                mod: [
                    { id: 'AMP_ENV', name: 'Amp Env' }
                ],
                control: [
                    { id: 'VELOCITY', name: 'Velocity' }
                ]
            },
            mod_targets: {
                VELOCITY: ['CARRIER_LEVEL', 'MOD_DEPTH'],
                AMP_ENV:  ['CARRIER_LEVEL']
            },
            audio_chain: ['MODULATOR', 'CARRIER'],
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
                AMP_ENV_ATTACK:  { name: 'Attack',  priority: 3, initial: atk, range: [0.001, 2], cc: 23 },
                AMP_ENV_DECAY:   { name: 'Decay',   priority: 4, initial: dec, range: [0.001, 2], cc: 24 },
                AMP_ENV_SUSTAIN: { name: 'Sustain', priority: 5, initial: sus, range: [0, 1],     cc: 25 },
                AMP_ENV_RELEASE: { name: 'Release', priority: 6, initial: rel, range: [0.001, 3], cc: 26 }
            }
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
                    name: 'Aach',
                    project: 'Aach',
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
                this._sendResponse({ status: 'ok', op: 'select-patch', current_index: json.index });
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
                this._sendResponse({ status: 'ok', op: 'toggle-module' });
                break;

            case 'toggle-modulation':
                this._sendResponse({ status: 'ok', op: 'toggle-modulation' });
                break;

            case 'update-modulation-amount':
                this._sendResponse({ status: 'ok', op: 'update-modulation-amount' });
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

            // Exchange protocol (from controller via relay)
            case 'control-surface':
                this._handleControlSurface(json);
                break;

            case 'thanks':
                this._exchangeState = 'IDLE';
                console.log(`[${this._portName}] Exchange complete`);
                break;

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
        }
    }

    //--------------------------------------------------------------
    // Exchange protocol
    //--------------------------------------------------------------

    _handleControllerAvailable(json) {
        this._exchangeState = 'EXCHANGE';
        this._controllerPort = json.port;
        console.log(`[${this._portName}] Controller available: ${json.device}`);

        this._sendResponse({ status: 'ok', op: 'controller-available' });

        setTimeout(() => {
            this._sendResponse({
                cmd: 'get-control-surface',
                mfg: 'AttachPart',
                device: 'Aach',
                version: '1.0.0'
            });
        }, 50);
    }

    _handleControlSurface(json) {
        console.log(`[${this._portName}] Got control surface: ${json.device}`);

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
                controls
            });
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
        // Deep clone to avoid mutations, set index
        const response = JSON.parse(JSON.stringify(patch));
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

    _noteOn(channel, note, velocity) {
        const ctx = this._ensureAudioCtx();
        const now = ctx.currentTime;
        const patch = this._patches[this._currentPatchIndex];

        // Read params from current patch
        const carrierRatio = patch.CARRIER.CARRIER_RATIO.initial;
        const carrierLevel = patch.CARRIER.CARRIER_LEVEL.initial;
        const carrierWave  = patch.CARRIER.CARRIER_WAVE.initial;
        const modRatio     = patch.MODULATOR.MOD_RATIO.initial;
        const modDepth     = patch.MODULATOR.MOD_DEPTH.initial;
        const modWave      = patch.MODULATOR.MOD_WAVE.initial;
        const attack       = patch.AMP_ENV.AMP_ENV_ATTACK.initial;
        const decay        = patch.AMP_ENV.AMP_ENV_DECAY.initial;
        const sustain      = patch.AMP_ENV.AMP_ENV_SUSTAIN.initial;
        const release      = patch.AMP_ENV.AMP_ENV_RELEASE.initial;

        const noteFreq = 440 * Math.pow(2, (note - 69) / 12);
        const vol = (velocity / 127) * carrierLevel;

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
        // Attack
        envGain.gain.linearRampToValueAtTime(vol, now + attack);
        // Decay -> Sustain
        envGain.gain.setTargetAtTime(vol * sustain, now + attack, decay / 3);

        // Master gain (overall level)
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
            release, note
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
}

window.Aach = Aach;
