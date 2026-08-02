/**
 * The audio graph, read back rather than listened to.
 *
 * jsdom implements no Web Audio, which is the reason `ui/sound.ts` takes its
 * context from a factory: everything below hands it a recording fake and then
 * asserts on the graph that was built and the automation that was scheduled.
 * No test here can hear anything, and none of them tries to.
 */

import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../store/seatTokenStore';
import type { SoundName } from '../store/sound';
import { MAX_GAIN, MUTE_FADE_MS, SOUNDS, soundSpec } from '../store/sound';
import type {
    AudioBufferLike,
    AudioBufferSourceNodeLike,
    AudioContextLike,
    AudioNodeLike,
    AudioParamLike,
    BiquadFilterNodeLike,
    GainNodeLike,
    GestureTarget,
    OscillatorNodeLike
} from './sound';
import { createSoundPlayer, MAX_VOICES, MUTE_KEY } from './sound';

const ALL: SoundName[] = ['deal', 'play', 'reveal', 'your-turn', 'token-award', 'elimination', 'mule', 'victory', 'refused'];

// ------------------------------------------------------------------- the fake

interface ParamEvent {
    readonly kind: 'set' | 'linear' | 'exponential' | 'cancel';
    readonly value: number;
    readonly time: number;
}

interface Param extends AudioParamLike {
    readonly events: ParamEvent[];
}

function makeParam(): Param {
    const events: ParamEvent[] = [];
    return {
        value: 0,
        events,
        cancelScheduledValues(time) {
            // Recorded rather than enacted: what matters is that the cancel is
            // in the timeline, in the right place, before the ramp that follows.
            events.push({ kind: 'cancel', value: 0, time });
        },
        setValueAtTime(value, time) {
            events.push({ kind: 'set', value, time });
        },
        linearRampToValueAtTime(value, time) {
            events.push({ kind: 'linear', value, time });
        },
        exponentialRampToValueAtTime(value, time) {
            events.push({ kind: 'exponential', value, time });
        }
    };
}

interface SourceRecord {
    readonly starts: number[];
    readonly stops: number[];
    readonly ended: Array<() => void>;
    disconnects: number;
    connections: number;
}

function makeSourceRecord(): SourceRecord {
    return { starts: [], stops: [], ended: [], disconnects: 0, connections: 0 };
}

function scheduledMembers(record: SourceRecord) {
    return {
        connect(_destination: AudioNodeLike) {
            record.connections += 1;
        },
        disconnect() {
            record.disconnects += 1;
        },
        start(when: number) {
            record.starts.push(when);
        },
        stop(when: number) {
            record.stops.push(when);
        },
        addEventListener(_type: 'ended', listener: () => void) {
            record.ended.push(listener);
        }
    };
}

interface Recording {
    readonly context: AudioContextLike;
    readonly gains: Array<{ readonly gain: Param; disconnects: number }>;
    readonly oscillators: Array<{ readonly node: OscillatorNodeLike; readonly frequency: Param; readonly record: SourceRecord }>;
    readonly noises: Array<{ readonly node: AudioBufferSourceNodeLike; readonly record: SourceRecord }>;
    readonly filters: Array<{ readonly node: BiquadFilterNodeLike; readonly frequency: Param; readonly q: Param }>;
    readonly buffersCreated: () => number;
    readonly resumes: () => number;
    /** What a browser that refuses to resume outside a gesture looks like. */
    refuseToResume(): void;
    wakeUp(): void;
    /** WebKit's rule: a resume asked for outside these two calls does nothing. */
    openGestureWindow(): void;
    closeGestureWindow(): void;
    advance(seconds: number): void;
    /** Every `ended` handler the player registered, fired as a browser would. */
    finishEverything(): void;
}

/**
 * `gestureGated` is the iOS model, and it is the only fake here that can fail
 * the bug this file exists to pin: a context that resumes whenever it is asked
 * cannot tell a player that unlocks from a gesture apart from one that never
 * unlocks at all.
 */
function makeContext(options: { state?: string; sampleRate?: number; gestureGated?: boolean } = {}): Recording {
    let currentTime = 0;
    let state = options.state ?? 'running';
    let resumes = 0;
    let buffersCreated = 0;
    let stubborn = false;
    const gated = options.gestureGated ?? false;
    let inGesture = false;

    const gains: Recording['gains'] = [];
    const oscillators: Recording['oscillators'] = [];
    const noises: Recording['noises'] = [];
    const filters: Recording['filters'] = [];

    const context: AudioContextLike = {
        get currentTime() {
            return currentTime;
        },
        // Deliberately tiny. The noise buffer is two seconds of samples drawn
        // one at a time from the injected random, and a realistic 48 kHz would
        // make every noise test draw 96,000 numbers to prove nothing extra.
        sampleRate: options.sampleRate ?? 1000,
        destination: {
            connect() {},
            disconnect() {}
        },
        get state() {
            return state;
        },
        resume() {
            resumes += 1;
            // A real `resume()` is a promise, so a browser never comes back
            // running on the same tick; a fake that did would hide the branch
            // that drops the sound waiting for it.
            if (!stubborn && (!gated || inGesture)) state = 'running';
            return Promise.resolve();
        },
        createGain(): GainNodeLike {
            const gain = makeParam();
            const entry = { gain, disconnects: 0 };
            gains.push(entry);
            return {
                gain,
                connect() {},
                disconnect() {
                    entry.disconnects += 1;
                }
            };
        },
        createOscillator(): OscillatorNodeLike {
            const frequency = makeParam();
            const record = makeSourceRecord();
            const node: OscillatorNodeLike = { type: '', frequency, ...scheduledMembers(record) };
            oscillators.push({ node, frequency, record });
            return node;
        },
        createBiquadFilter(): BiquadFilterNodeLike {
            const frequency = makeParam();
            const q = makeParam();
            const node: BiquadFilterNodeLike = {
                type: '',
                frequency,
                Q: q,
                connect() {},
                disconnect() {}
            };
            filters.push({ node, frequency, q });
            return node;
        },
        createBufferSource(): AudioBufferSourceNodeLike {
            const record = makeSourceRecord();
            const node: AudioBufferSourceNodeLike = { buffer: null, loop: false, ...scheduledMembers(record) };
            noises.push({ node, record });
            return node;
        },
        createBuffer(_channels: number, length: number): AudioBufferLike {
            buffersCreated += 1;
            return { length, getChannelData: () => new Float32Array(length) };
        }
    };

    return {
        context,
        gains,
        oscillators,
        noises,
        filters,
        buffersCreated: () => buffersCreated,
        resumes: () => resumes,
        refuseToResume() {
            stubborn = true;
            state = 'suspended';
        },
        wakeUp() {
            stubborn = false;
            state = 'running';
        },
        openGestureWindow() {
            inGesture = true;
        },
        closeGestureWindow() {
            inGesture = false;
        },
        advance(seconds) {
            currentTime += seconds;
        },
        finishEverything() {
            for (const source of [...oscillators.map(o => o.record), ...noises.map(n => n.record)]) {
                const handlers = [...source.ended];
                source.ended.length = 0;
                for (const handler of handlers) handler();
            }
        }
    };
}

function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
        removeItem: key => {
            values.delete(key);
        }
    };
}

interface Registration {
    readonly listener: () => void;
    readonly options: { once?: boolean; capture?: boolean } | undefined;
}

/** A `document` that never existed, so a test can raise a tap that never happened. */
function makeGestures() {
    const bound = new Map<string, Registration[]>();

    const target: GestureTarget = {
        addEventListener(type, listener, options) {
            bound.set(type, [...(bound.get(type) ?? []), { listener, options }]);
        },
        removeEventListener(type, listener) {
            const left = (bound.get(type) ?? []).filter(entry => entry.listener !== listener);
            if (left.length === 0) bound.delete(type);
            else bound.set(type, left);
        }
    };

    return {
        target,
        registered: () => [...bound.keys()],
        optionsFor: (type: string) => bound.get(type)?.[0]?.options,
        fire(type: string) {
            for (const entry of [...(bound.get(type) ?? [])]) {
                // `once` really does remove before it calls, as a browser does.
                if (entry.options?.once === true) target.removeEventListener(type, entry.listener);
                entry.listener();
            }
        }
    };
}

/** A player over one recording context, with a constant random unless told otherwise. */
function makePlayer(options: { recording?: Recording; storage?: KeyValueStore; random?: () => number } = {}) {
    const recording = options.recording ?? makeContext();
    const gestures = makeGestures();
    let contexts = 0;
    const player = createSoundPlayer({
        createContext: () => {
            contexts += 1;
            return recording.context;
        },
        gestures: gestures.target,
        storage: options.storage ?? memoryStore(),
        random: options.random ?? (() => 0.5)
    });

    /**
     * A real gesture: the browser's resume window is open for the dispatch and
     * shut the moment it returns. Anything the player wants from the context has
     * to be asked for in between, which is the whole point.
     */
    function gesture(type: string) {
        recording.openGestureWindow();
        gestures.fire(type);
        recording.closeGestureWindow();
    }

    return {
        player,
        recording,
        gestures,
        contexts: () => contexts,
        tap: () => gesture('pointerdown'),
        press: () => gesture('keydown')
    };
}

// -------------------------------------------------------------- the gesture gate

describe('the context', () => {
    it('is not created until something is played', () => {
        const { contexts } = makePlayer();
        // Constructed at module load or in the factory, a browser answers with a
        // console warning and a context that is suspended for the rest of the
        // page's life. Nothing may exist before the first gesture-driven play.
        expect(contexts()).toBe(0);
    });

    it('is created once, however many sounds are played', () => {
        const { player, recording, contexts } = makePlayer();
        player.play('play');
        recording.advance(1);
        player.play('reveal');
        recording.advance(1);
        player.play('elimination');
        expect(contexts()).toBe(1);
    });

    it('is resumed when the browser hands it back suspended', () => {
        // Safari creates every context suspended, so a player that never
        // resumed would build a perfect graph and emit nothing at all.
        const recording = makeContext({ state: 'suspended' });
        const { player } = makePlayer({ recording });
        player.play('play');
        expect(recording.resumes()).toBe(1);
    });

    it('drops a sound rather than scheduling it into a context that is still asleep', () => {
        // A suspended context queues work against a clock that is not moving,
        // so everything scheduled while waiting arrives at once the moment it
        // wakes. One missing swish beats the first second of a match landing as
        // a single chord.
        const recording = makeContext();
        recording.refuseToResume();
        const { player } = makePlayer({ recording });

        player.play('victory');
        expect(recording.oscillators).toHaveLength(0);
        expect(recording.resumes()).toBe(1);

        recording.wakeUp();
        player.play('victory');
        expect(recording.oscillators).not.toHaveLength(0);
    });

    it('is not created at all while muted', () => {
        const { player, contexts } = makePlayer({ storage: memoryStore({ [MUTE_KEY]: '1' }) });
        player.play('mule');
        expect(contexts()).toBe(0);
    });

    it('stays silent rather than throwing when the browser has no Web Audio', () => {
        const player = createSoundPlayer({
            createContext: () => {
                throw new ReferenceError('no such constructor');
            },
            gestures: makeGestures().target,
            storage: memoryStore(),
            random: () => 0.5
        });
        expect(() => player.play('victory')).not.toThrow();
    });

    it('stays silent rather than throwing when the unlock gesture finds no Web Audio', () => {
        // The unlock runs from a listener, where a throw goes nowhere a player
        // can see and takes the rest of the handler with it.
        const gestures = makeGestures();
        createSoundPlayer({
            createContext: () => {
                throw new ReferenceError('no such constructor');
            },
            gestures: gestures.target,
            storage: memoryStore(),
            random: () => 0.5
        });
        expect(() => gestures.fire('pointerdown')).not.toThrow();
    });

    it('gives up after one failure rather than retrying on every sound', () => {
        let attempts = 0;
        const player = createSoundPlayer({
            createContext: () => {
                attempts += 1;
                throw new Error('no');
            },
            gestures: makeGestures().target,
            storage: memoryStore(),
            random: () => 0.5
        });
        player.play('play');
        player.play('play');
        player.play('play');
        expect(attempts).toBe(1);
    });
});

// ---------------------------------------------------------- the gesture unlock

describe('the gesture unlock', () => {
    it('is listening from construction, before anything has been played', () => {
        // Attached lazily — on the first `play`, say — it would be attached from
        // inside a socket push and would already be too late for the tap that
        // caused it.
        const { gestures } = makePlayer();
        expect(gestures.registered()).toEqual(['pointerdown', 'keydown']);
    });

    it('takes both events, because a keyboard player never taps', () => {
        const { gestures } = makePlayer();
        expect(gestures.registered()).toContain('pointerdown');
        expect(gestures.registered()).toContain('keydown');
    });

    it('is one-shot and heard on the way down', () => {
        const { gestures } = makePlayer();
        for (const type of ['pointerdown', 'keydown']) {
            expect(gestures.optionsFor(type), type).toMatchObject({ once: true, capture: true });
        }
    });

    it('builds and resumes the context from inside the gesture', () => {
        const recording = makeContext({ state: 'suspended', gestureGated: true });
        const { contexts, tap } = makePlayer({ recording });

        expect(contexts()).toBe(0);
        tap();

        expect(contexts()).toBe(1);
        expect(recording.context.state).toBe('running');
    });

    it('leaves the game silent when sound arrives with no gesture behind it', () => {
        // THE iOS BUG. Every `play` call site is inside the store subscriber, so
        // it runs from a WebSocket frame or a queued microtask and never from
        // within a tap — and WebKit honours `resume()` only inside one. A player
        // that unlocked lazily on the first `play` passes every other test in
        // this file and makes no sound for the whole session, with nothing
        // thrown to say so.
        const recording = makeContext({ state: 'suspended', gestureGated: true });
        const { player } = makePlayer({ recording });

        player.play('victory');
        recording.advance(1);
        player.play('mule');

        expect(recording.oscillators).toHaveLength(0);
        expect(recording.context.state).toBe('suspended');
    });

    it('sounds after a tap, for a play that is still nowhere near one', () => {
        const recording = makeContext({ state: 'suspended', gestureGated: true });
        const { player, tap } = makePlayer({ recording });

        tap();
        player.play('victory');

        expect(recording.oscillators).not.toHaveLength(0);
    });

    it('sounds after a keypress, for the player who only ever uses the keyboard', () => {
        const recording = makeContext({ state: 'suspended', gestureGated: true });
        const { player, press } = makePlayer({ recording });

        press();
        player.play('victory');

        expect(recording.oscillators).not.toHaveLength(0);
    });

    it('costs one gesture: both listeners come off after the first', () => {
        const { gestures, tap } = makePlayer();
        tap();
        // `once` retires the one that fired; the other is taken off by hand.
        expect(gestures.registered()).toEqual([]);
    });

    it('unlocks even while muted, because the gesture does not come round again', () => {
        const recording = makeContext({ state: 'suspended', gestureGated: true });
        const { player, tap } = makePlayer({ recording, storage: memoryStore({ [MUTE_KEY]: '1' }) });

        tap();
        player.setMuted(false);
        player.play('victory');

        expect(recording.oscillators).not.toHaveLength(0);
    });

    it('keeps its own resume attempt, for a context suspended long after the gesture', () => {
        // Backgrounding a tab suspends a running context and never resumes it,
        // by which time the unlock listener is long gone.
        const recording = makeContext({ state: 'suspended' });
        const { player } = makePlayer({ recording });

        player.play('play');

        expect(recording.resumes()).toBe(1);
    });
});

// ------------------------------------------------------------------ the graph

describe('the graph a spec builds', () => {
    it('gives every voice its own oscillator or buffer source', () => {
        const { player, recording } = makePlayer();
        player.play('mule');

        const spec = soundSpec('mule');
        const tones = spec.voices.filter(voice => voice.source.kind === 'tone').length;
        const noise = spec.voices.filter(voice => voice.source.kind === 'noise').length;

        expect(recording.oscillators).toHaveLength(tones);
        expect(recording.noises).toHaveLength(noise);
        expect(recording.gains).toHaveLength(spec.voices.length + 1); // + the master
    });

    it('takes the waveform and the pitch from the spec, never from here', () => {
        const { player, recording } = makePlayer({ random: () => 0.5 });
        player.play('refused');

        const voice = soundSpec('refused').voices[0];
        const source = voice.source;
        expect(source.kind).toBe('tone');
        if (source.kind !== 'tone') return;

        expect(recording.oscillators[0].node.type).toBe(source.wave);
        // random() === 0.5 is the midpoint, so the jitter factor is exactly 1.
        expect(recording.oscillators[0].frequency.events[0].value).toBeCloseTo(source.frequencyHz, 6);
    });

    it('glides a pitch that the spec says glides, and holds one that does not', () => {
        const { player, recording } = makePlayer();
        player.play('refused'); // G3 → E♭3
        expect(recording.oscillators[0].frequency.events.map(event => event.kind)).toEqual(['set', 'exponential']);

        const steady = makePlayer();
        steady.player.play('your-turn'); // two steady sines
        expect(steady.recording.oscillators[0].frequency.events.map(event => event.kind)).toEqual(['set']);
    });

    it('builds a filter only for the voices that declare one', () => {
        const { player, recording } = makePlayer();
        player.play('token-award');

        const spec = soundSpec('token-award');
        expect(recording.filters).toHaveLength(spec.voices.filter(voice => voice.filter !== undefined).length);
        expect(recording.filters[0].node.type).toBe('lowpass');
    });

    it('sweeps a filter cutoff the way the spec draws it', () => {
        const { player, recording } = makePlayer();
        player.play('deal'); // bandpass 1600 → 600

        const filter = soundSpec('deal').voices[0].filter;
        expect(filter).toBeDefined();
        expect(recording.filters[0].node.type).toBe(filter?.kind);
        expect(recording.filters[0].q.value).toBeCloseTo(filter?.q ?? 0, 6);
        expect(recording.filters[0].frequency.events.map(event => event.value)).toEqual([
            filter?.cutoffHz,
            filter?.sweepToHz
        ]);
    });

    it('starts and stops every source, so nothing runs on past its voice', () => {
        const { player, recording } = makePlayer();
        player.play('victory');

        for (const oscillator of recording.oscillators) {
            expect(oscillator.record.starts).toHaveLength(1);
            expect(oscillator.record.stops).toHaveLength(1);
            expect(oscillator.record.stops[0]).toBeGreaterThan(oscillator.record.starts[0]);
        }
    });

    it('staggers a voice by the delay the spec gives it', () => {
        const { player, recording } = makePlayer();
        player.play('victory'); // 0ms, 90ms, 180ms

        const delays = soundSpec('victory').voices.map(voice => voice.delayMs / 1000);
        expect(recording.oscillators.map(o => o.record.starts[0])).toEqual(delays);
    });
});

// --------------------------------------------------------------- the envelope

describe('the envelope', () => {
    it('rises out of silence linearly, because an exponential ramp cannot start from zero', () => {
        const { player, recording } = makePlayer();
        player.play('play');

        // The master gain is created first; the voices follow.
        const voice = recording.gains[1].gain.events;
        expect(voice[0]).toMatchObject({ kind: 'set', value: 0 });
        expect(voice[1].kind).toBe('linear');
    });

    it('never ramps exponentially to zero, in any sound in the vocabulary', () => {
        // Zero is an invalid target: it throws in some browsers and silently
        // does nothing in others, which is the worse of the two.
        for (const name of ALL) {
            const { player, recording } = makePlayer();
            player.play(name);
            const targets = recording.gains
                .flatMap(entry => entry.gain.events)
                .filter(event => event.kind === 'exponential')
                .map(event => event.value);
            expect(targets.every(value => value > 0)).toBe(true);
        }
    });

    it('ends at true zero, so no voice leaves a floor ringing under the next', () => {
        const { player, recording } = makePlayer();
        player.play('reveal');

        for (const entry of recording.gains.slice(1)) {
            const last = entry.gain.events[entry.gain.events.length - 1];
            expect(last).toMatchObject({ kind: 'set', value: 0 });
        }
    });

    it('schedules a timeline that only moves forwards', () => {
        for (const name of ALL) {
            const { player, recording } = makePlayer();
            player.play(name);
            for (const entry of recording.gains.slice(1)) {
                const times = entry.gain.events.map(event => event.time);
                expect(times).toEqual([...times].sort((a, b) => a - b));
            }
        }
    });

    it('peaks at the spec gain scaled by the voice, and never above the ceiling', () => {
        const { player, recording } = makePlayer({ random: () => 0.5 });
        player.play('elimination');

        const spec = soundSpec('elimination');
        const peaks = recording.gains.slice(1).map(entry => entry.gain.events[1].value);
        expect(peaks).toEqual(spec.voices.map(voice => spec.gain * voice.gain));
        expect(Math.max(...peaks)).toBeLessThanOrEqual(MAX_GAIN);
    });

    it('holds the ceiling even when jitter pushes a spec above it', () => {
        // `varySpec` multiplies the master gain, so the loudest sound in the
        // set can leave the pure layer slightly over MAX_GAIN.
        const { player, recording } = makePlayer({ random: () => 1 });
        player.play('mule');
        const peaks = recording.gains.slice(1).map(entry => entry.gain.events[1].value);
        expect(Math.max(...peaks)).toBeLessThanOrEqual(MAX_GAIN);
    });
});

// ------------------------------------------------------------------- cleanup

describe('cleanup', () => {
    it('disconnects every node once its source ends', () => {
        const { player, recording } = makePlayer();
        player.play('deal'); // one noise voice, one filter, one gain

        expect(recording.noises[0].record.disconnects).toBe(0);
        recording.finishEverything();
        expect(recording.noises[0].record.disconnects).toBe(1);
        expect(recording.gains[1].disconnects).toBe(1);
    });

    it('frees the voice it was holding, so a finished sound stops counting against the cap', () => {
        const { player, recording } = makePlayer();

        // Three mules is twelve voices — the cap exactly.
        player.play('mule');
        player.play('mule');
        player.play('mule');
        const held = recording.gains.length;
        player.play('mule');
        expect(recording.gains).toHaveLength(held);

        recording.finishEverything();
        player.play('mule');
        expect(recording.gains.length).toBeGreaterThan(held);
    });
});

// ----------------------------------------------------------------- restraint

describe('a burst of events', () => {
    it('drops rather than queues once the voice cap is reached', () => {
        const { player, recording } = makePlayer();
        const perPlay = soundSpec('mule').voices.length;

        for (let i = 0; i < 10; i += 1) player.play('mule');

        // The master gain plus whole sounds only — never a partial chord.
        const voiceGains = recording.gains.length - 1;
        expect(voiceGains).toBeLessThanOrEqual(MAX_VOICES);
        expect(voiceGains % perPlay).toBe(0);
    });

    it('refuses to retrigger a sound inside its own minimum interval', () => {
        const { player, recording } = makePlayer();
        player.play('refused');
        player.play('refused');
        player.play('refused');
        expect(recording.oscillators).toHaveLength(1);

        recording.advance(soundSpec('refused').minIntervalMs / 1000);
        player.play('refused');
        expect(recording.oscillators).toHaveLength(2);
    });

    it('lets every card of a staggered deal sound, because the deal interval is short', () => {
        const { player, recording } = makePlayer();
        player.play('deal');
        recording.advance(0.04); // DEAL_STAGGER_MS
        player.play('deal');
        expect(recording.noises).toHaveLength(2);
    });

    it('does not let a dropped sound suppress the next one that would fit', () => {
        const { player, recording } = makePlayer();

        // Fill the cap, then ask for a refusal — which has a 250 ms floor of
        // its own and is dropped here for the cap instead.
        for (let i = 0; i < 3; i += 1) player.play('mule');
        const before = recording.gains.length;
        player.play('refused');
        expect(recording.gains).toHaveLength(before);

        // Same instant on the context clock. A drop that had recorded itself as
        // a play would silence this one for a quarter of a second.
        recording.finishEverything();
        player.play('refused');
        expect(recording.gains.length).toBe(before + 1);
    });
});

// ------------------------------------------------------------------- the noise

describe('the noise buffer', () => {
    it('is built once and reused', () => {
        const { player, recording } = makePlayer();
        player.play('deal');
        recording.advance(1);
        player.play('deal');
        recording.advance(1);
        player.play('elimination');
        expect(recording.buffersCreated()).toBe(1);
    });

    it('loops, so a voice longer than the buffer is still a whole voice', () => {
        const { player, recording } = makePlayer();
        player.play('mule');
        expect(recording.noises[0].node.loop).toBe(true);
        expect(recording.noises[0].node.buffer).not.toBeNull();
    });
});

// -------------------------------------------------------------------- jitter

describe('jitter', () => {
    it('comes from the injected random, so two plays can differ', () => {
        const low = makePlayer({ random: () => 0 });
        low.player.play('deal');

        const high = makePlayer({ random: () => 1 });
        high.player.play('deal');

        const lowCutoff = low.recording.filters[0].frequency.events[0].value;
        const highCutoff = high.recording.filters[0].frequency.events[0].value;
        expect(highCutoff).toBeGreaterThan(lowCutoff);
    });

    it('is deterministic for a given random, so a test can pin what a player hears', () => {
        const first = makePlayer({ random: () => 0.25 });
        first.player.play('your-turn');
        const second = makePlayer({ random: () => 0.25 });
        second.player.play('your-turn');

        expect(first.recording.oscillators.map(o => o.frequency.events[0].value)).toEqual(
            second.recording.oscillators.map(o => o.frequency.events[0].value)
        );
    });

    it('moves the whole sound together, so a tuned interval stays tuned', () => {
        const { player, recording } = makePlayer({ random: () => 0 });
        player.play('token-award');

        const spec = SOUNDS['token-award'];
        const tones = spec.voices.map(voice => (voice.source.kind === 'tone' ? voice.source.frequencyHz : 0));
        const heard = recording.oscillators.map(o => o.frequency.events[0].value);

        // The fifth is still a fifth: every ratio survives the transposition.
        expect(heard[1] / heard[0]).toBeCloseTo(tones[1] / tones[0], 6);
    });
});

// ---------------------------------------------------------------------- mute

describe('mute', () => {
    it('defaults to unmuted, because nothing can sound before a gesture anyway', () => {
        const { player } = makePlayer();
        expect(player.muted()).toBe(false);
    });

    it('is remembered across sessions', () => {
        const storage = memoryStore();
        makePlayer({ storage }).player.setMuted(true);
        expect(makePlayer({ storage }).player.muted()).toBe(true);
    });

    it('silences everything that follows', () => {
        const { player, recording } = makePlayer();
        player.setMuted(true);
        player.play('mule');
        player.play('victory');
        expect(recording.oscillators).toHaveLength(0);
    });

    it('fades what is already in flight rather than cutting it', () => {
        const { player, recording } = makePlayer();
        player.play('victory');
        const master = recording.gains[0].gain;
        const before = master.events.length;

        player.setMuted(true);
        const scheduled = master.events.slice(before);
        expect(scheduled.map(event => event.kind)).toEqual(['cancel', 'set', 'linear']);
        // A step through a sounding voice is a click — the one artefact every
        // envelope in this module is shaped to avoid.
        expect(scheduled[2].value).toBe(0);
        expect(scheduled[2].time).toBeGreaterThan(scheduled[1].time);
    });

    it('takes exactly the fade the vocabulary specifies', () => {
        // The duration is data in `store/sound.ts` with every other envelope
        // time, not a number sitting beside the ramp that schedules it.
        const { player, recording } = makePlayer();
        player.play('victory');
        recording.advance(3);

        player.setMuted(true);
        const master = recording.gains[0].gain.events;
        const ramp = master[master.length - 1];
        const held = master[master.length - 2];

        expect(ramp.time - held.time).toBeCloseTo(MUTE_FADE_MS / 1000, 9);
    });

    it('clears the ramp already in the timeline before scheduling the next', () => {
        // The Web Audio timeline is processed in TIME order, not insertion
        // order. Toggled twice inside the fade window without a cancel, the
        // earlier dive to zero is still in the timeline and still runs — so the
        // master gain drops out on its way back up, from a mute the player has
        // already undone.
        const { player, recording } = makePlayer();
        player.play('victory');
        const master = recording.gains[0].gain;

        player.setMuted(true);
        const midFade = master.events.length;
        // Same instant on the context clock: the fade to zero has been scheduled
        // and has not finished.
        player.setMuted(false);

        const second = master.events.slice(midFade);
        expect(second[0].kind).toBe('cancel');
        // Cancelled from no later than the new automation starts, or the dive it
        // is meant to remove survives it.
        expect(second[0].time).toBeLessThanOrEqual(second[1].time);
        expect(second[second.length - 1]).toMatchObject({ kind: 'linear', value: 1 });
    });

    it('restores the master gain on unmute', () => {
        const { player, recording } = makePlayer();
        player.play('victory');
        player.setMuted(true);
        player.setMuted(false);
        const last = recording.gains[0].gain.events[recording.gains[0].gain.events.length - 1];
        expect(last).toMatchObject({ kind: 'linear', value: 1 });
    });

    it('survives a storage that refuses to write', () => {
        // Safari in private mode throws from setItem. Losing a remembered
        // preference is not worth taking the table down for.
        const hostile: KeyValueStore = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
            removeItem: () => {}
        };
        const { player } = makePlayer({ storage: hostile });
        expect(() => player.setMuted(true)).not.toThrow();
        expect(player.muted()).toBe(true);
    });
});
