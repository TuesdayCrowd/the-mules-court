/**
 * The audio graph — the half of sound that a browser has to be present for.
 *
 * `store/sound.ts` decides **what** an event sounds like and owns every number
 * in the vocabulary; this file knows only **how** to build the graph a
 * `SoundSpec` describes. The split is the same one `store/motion.ts` and
 * `ui/beats.ts` already keep, and for the same reason: a frequency written
 * beside an oscillator is a frequency no test can read.
 *
 * Nothing is loaded and nothing is decoded. Every voice is an oscillator or a
 * slice of one reused noise buffer, so the whole sound design costs zero bytes
 * of network and zero runtime dependencies.
 *
 * ## Why the `*Like` interfaces exist
 *
 * jsdom implements no Web Audio at all, so a test that reached for a real
 * `AudioContext` could assert nothing about the graph. Everything below is
 * typed against the narrowest structural slice this file actually uses, which a
 * real `AudioContext` satisfies and a plain object can too — so
 * `sound.test.ts` reads back the nodes created and the envelope values
 * scheduled instead of listening to anything.
 *
 * `type` is `string` rather than the exact union on both the oscillator and the
 * filter, and that is forced rather than sloppy: the DOM's own `OscillatorType`
 * is wider than `Waveform`, and TypeScript checks a mutable property in one
 * direction only, so the narrow union would refuse the real node. The values
 * this file assigns still come from the pure layer's unions, which is where the
 * check that matters lives.
 *
 * ## The six traps, and where each is answered
 *
 * 1. **A context cannot start before a gesture, and `play` is never inside
 *    one.** Every call site is in the store subscriber, which runs from a socket
 *    frame or a queued microtask — never synchronously inside a tap. WebKit
 *    honours `resume()` only from within a gesture, so a player that unlocked
 *    lazily on the first `play` stayed suspended for the entire session and the
 *    game was silent on iOS with nothing thrown to say so. `createSoundPlayer`
 *    therefore registers a one-shot `pointerdown` and `keydown` listener at
 *    construction and creates-or-resumes the context from inside that gesture.
 *    `ensureContext` keeps its own resume attempt as the belt-and-braces path —
 *    Safari also hands back a suspended context after a tab is backgrounded,
 *    long after the unlock gesture is gone.
 * 2. **Never ramp exponentially to zero.** Zero is an invalid target and an
 *    invalid starting value; `scheduleEnvelope` ramps to `SILENCE` and then
 *    steps to true zero.
 * 3. **Nodes leak unless disconnected.** Every voice cleans itself up in its
 *    source's `ended` handler.
 * 4. **One context, shared.** Held in a closure and built once.
 * 5. **A burst must not stack.** `MAX_VOICES` caps what can sound at once and
 *    a sound that will not fit is dropped whole, never queued and never played
 *    half — half a chord is a different chord.
 * 6. **One noise buffer.** Built once per context and looped, rather than
 *    regenerated per card on the device that can least afford it.
 */

import type { KeyValueStore } from '../store/seatTokenStore';
import type { AmbienceName, SoundFilter, SoundName, SoundSpec, SoundSource, SoundVoice } from '../store/sound';
import {
    AMBIENCE,
    AMBIENCE_FADE_MS,
    AMBIENCE_GAIN,
    MAX_GAIN,
    MUTE_FADE_MS,
    SOUNDS,
    soundSpec,
    varySample,
    varySpec
} from '../store/sound';

// ------------------------------------------------------- the injected surface

export interface AudioParamLike {
    value: number;
    /**
     * Clears everything already scheduled at or after this time.
     *
     * Not optional politeness: the automation timeline is processed in TIME
     * order, not insertion order, so a second ramp scheduled while a first is
     * still pending does not replace it. Muting and unmuting inside the fade
     * window without this leaves the dive to zero in the timeline, and the
     * master gain still drops out before coming back.
     */
    cancelScheduledValues(startTime: number): void;
    setValueAtTime(value: number, startTime: number): void;
    linearRampToValueAtTime(value: number, endTime: number): void;
    exponentialRampToValueAtTime(value: number, endTime: number): void;
}

export interface AudioNodeLike {
    connect(destination: AudioNodeLike): void;
    disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
    readonly gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
    /** Widened deliberately — see the module header. */
    type: string;
    readonly frequency: AudioParamLike;
    readonly Q: AudioParamLike;
}

/** What an oscillator and a buffer source have in common, which is all this file needs. */
export interface ScheduledSourceLike extends AudioNodeLike {
    start(when: number): void;
    stop(when: number): void;
    /**
     * `addEventListener`, not the `onended` property.
     *
     * The property's real type takes an `Event`, and a handler that takes an
     * argument is not assignable to one that takes none — so a real
     * `OscillatorNode` would fail to satisfy this interface for a reason that
     * has nothing to do with audio. The method form is bivariant and accepts
     * the same fake in a test and the same real node in a browser.
     */
    addEventListener(type: 'ended', listener: () => void): void;
}

export interface OscillatorNodeLike extends ScheduledSourceLike {
    /** Widened deliberately — see the module header. */
    type: string;
    readonly frequency: AudioParamLike;
}

export interface AudioBufferLike {
    readonly length: number;
    getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends ScheduledSourceLike {
    buffer: AudioBufferLike | null;
    loop: boolean;
    /**
     * Speed, and therefore pitch — the two are one control on a buffer.
     *
     * Optional on the interface rather than required, because the noise voices
     * that predate sampling never touch it and a test double written for those
     * should not have to grow a field to keep compiling.
     */
    readonly playbackRate?: AudioParamLike;
}

export interface AudioContextLike {
    readonly currentTime: number;
    readonly sampleRate: number;
    readonly destination: AudioNodeLike;
    readonly state: string;
    resume(): Promise<void>;
    createGain(): GainNodeLike;
    createOscillator(): OscillatorNodeLike;
    createBiquadFilter(): BiquadFilterNodeLike;
    createBufferSource(): AudioBufferSourceNodeLike;
    createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
    /**
     * Turns encoded bytes into a playable buffer.
     *
     * Optional for the same reason `playbackRate` is: a context that only ever
     * synthesises never needs it, and every existing test double is such a
     * context. A player handed no decoder simply never has a sample to prefer.
     */
    decodeAudioData?(data: ArrayBuffer): Promise<AudioBufferLike>;
}

/**
 * Where the unlock gesture is listened for — `document` in a browser.
 *
 * Injected rather than reached for, like every other ambient thing in this
 * client, which is what lets a test fire a tap that never happened.
 */
export interface GestureTarget {
    addEventListener(type: string, listener: () => void, options?: { once?: boolean; capture?: boolean }): void;
    removeEventListener(type: string, listener: () => void, options?: { capture?: boolean }): void;
}

/**
 * The two events that mean "a person is here".
 *
 * Both, because they are not interchangeable: a player driving the table from
 * the keyboard never emits a `pointerdown`, and a player on a phone never emits
 * a `keydown`. Listening for one of them silences the other player entirely.
 *
 * `pointerdown` rather than `click` because it is the earliest of the gesture's
 * events, so the unlock is finished before the tap it rode in on has even
 * decided what it hit.
 */
const UNLOCK_EVENTS = ['pointerdown', 'keydown'] as const;

// --------------------------------------------------------------- the player

/** The part of the player the mute control needs, and nothing more. */
export interface SoundControl {
    muted(): boolean;
    setMuted(muted: boolean): void;
}

export interface SoundPlayer extends SoundControl {
    /** Fire and forget. A sound that cannot be made is silence, never an error. */
    play(name: SoundName): void;
    /**
     * Put a bed under the table, or take it away with `null`.
     *
     * Idempotent by name: calling it with the bed already playing does nothing,
     * which matters because the only sensible call site is a store subscriber
     * that fires on every single state push. A version that restarted the loop
     * each time would make the room tone stutter once per frame from the server.
     */
    setAmbience(name: AmbienceName | null): void;
}

export interface SoundPlayerDeps {
    /**
     * Builds the one `AudioContext`, called at most once and never before a
     * gesture. A factory rather than a context so that nothing is constructed
     * at module load — a context built on page load logs a browser warning and
     * is dead on arrival.
     */
    readonly createContext: () => AudioContextLike;
    /**
     * Where the first tap or keypress is heard, so the context can be unlocked
     * from inside a real gesture. `document` in `main.ts`.
     */
    readonly gestures: GestureTarget;
    /** Where the mute preference lives. Injected exactly as `referenceDock` injects it. */
    readonly storage: KeyValueStore;
    /** Jitter's source of variation, so a test can make a play deterministic. */
    readonly random: () => number;
    /**
     * Fetches the encoded bytes for a path under `public/assets/`.
     *
     * **Optional, and the whole sampling feature hangs off that.** A player
     * built without it synthesises everything and has no ambience — which is
     * exactly the game as it stood before the recordings existed, still fully
     * exercised by the tests written for it. Supplying it is opt-in enrichment,
     * never a prerequisite.
     *
     * Injected rather than reached for so a test can serve, stall, or fail a
     * load without a network; `main.ts` wires it to a fetch of the resolved
     * asset URL.
     */
    readonly loadAudio?: (path: string) => Promise<ArrayBuffer>;
}

/**
 * Remembered outright rather than per match: a player who muted the game muted
 * the game, and having sound return on the next table is the failure the
 * preference exists to prevent.
 */
export const MUTE_KEY = 'mules-court:muted';

/**
 * The floor an exponential ramp aims at, standing in for zero.
 *
 * `exponentialRampToValueAtTime(0, t)` is invalid — it throws in some browsers
 * and silently does nothing in others — and so is ramping *from* zero. Every
 * envelope therefore rises linearly out of silence, falls exponentially to this
 * value, and steps to true zero afterwards.
 */
const SILENCE = 0.0001;

/**
 * How many voices may sound at once before a new sound is dropped.
 *
 * A single state push can carry a deal, a play, an elimination and a token
 * award, and the Mule alone is four voices. Twelve leaves room for a busy turn
 * without letting a burst turn into a chord — and the sound that will not fit
 * is dropped whole rather than queued, because a card sound arriving a second
 * after its card is worse than no sound at all.
 */
export const MAX_VOICES = 12;

/** Long enough to cover the longest voice in the vocabulary, then looped. */
const NOISE_SECONDS = 2;

export function createSoundPlayer(deps: SoundPlayerDeps): SoundPlayer {
    let silenced = recall() === '1';
    let context: AudioContextLike | null = null;
    let master: GainNodeLike | null = null;
    let noise: AudioBufferLike | null = null;
    /**
     * Set once a context has failed to build. Without it, a browser with no Web
     * Audio would attempt a fresh context on every single sound in the match.
     */
    let unavailable = false;
    let voices = 0;
    /** Context time, in ms, of the last time each sound was allowed to start. */
    const lastStart = new Map<SoundName, number>();

    /** Decoded cues, keyed by name. A miss means "synthesise it instead". */
    const samples = new Map<SoundName, AudioBufferLike>();
    /** Decoded beds. Loaded on first request rather than up front — see `preloadCues`. */
    const beds = new Map<AmbienceName, AudioBufferLike>();
    /** Paths with a load in flight or permanently failed, so neither is retried in a loop. */
    const settled = new Set<string>();
    let cuesRequested = false;

    /** What the game wants playing, which is not the same as what is playing. */
    let desiredBed: AmbienceName | null = null;
    let currentBed: { readonly name: AmbienceName; readonly source: AudioBufferSourceNodeLike; readonly amp: GainNodeLike } | null =
        null;

    /**
     * Both halves guarded, exactly as `referenceDock` guards them: Safari in
     * private mode throws from `setItem`, and losing a remembered preference is
     * not worth taking the table down for.
     */
    function recall(): string | null {
        try {
            return deps.storage.getItem(MUTE_KEY);
        } catch {
            return null;
        }
    }

    function remember(value: string): void {
        try {
            deps.storage.setItem(MUTE_KEY, value);
        } catch {
            /* a forgotten preference is not a failure worth surfacing */
        }
    }

    /** A rejected resume is a browser still waiting for a gesture, not a fault. */
    function resumeQuietly(ctx: AudioContextLike): void {
        try {
            void ctx.resume().catch(() => {});
        } catch {
            /* nothing to do but stay silent */
        }
    }

    function ensureContext(): AudioContextLike | null {
        if (unavailable) return null;

        if (context === null) {
            try {
                const created = deps.createContext();
                const out = created.createGain();
                out.gain.value = 1;
                out.connect(created.destination);

                context = created;
                master = out;

                // The earliest honest moment to start fetching: there is now a
                // decoder, and this branch runs exactly once. Deliberately not
                // at module load, where there is no context, and not on first
                // `play`, which would guarantee the first cue of the match is
                // the one that misses.
                preloadCues(created);
            } catch {
                // No Web Audio, or a browser refusing another context. Sound is
                // decoration attached to something that already happened; the
                // table plays on in silence rather than surfacing this.
                unavailable = true;
                return null;
            }
        }

        if (context.state !== 'running') {
            // Safari hands every context back suspended, and backgrounding a
            // tab suspends a running one without ever resuming it again.
            resumeQuietly(context);

            /**
             * Still not running, so this sound is **dropped** rather than
             * scheduled.
             *
             * A suspended context does not refuse work — it queues it, against
             * a clock that is not moving. Everything scheduled while waiting
             * therefore has a start time in the past by the time the resume
             * lands, and the browser answers by playing all of it at once. One
             * missing swish is a far smaller thing than the whole first second
             * of a match arriving in a single chord.
             *
             * The re-read is what keeps that cost at one sound: `resume()` is a
             * promise in a browser, so this branch is taken once, but a context
             * that comes back synchronously never loses anything at all.
             */
            if (context.state !== 'running') return null;
        }

        return context;
    }

    /**
     * The unlock, run from inside the first gesture and then never again.
     *
     * `{ capture: true }` so it is heard on the way down, before any surface can
     * stop the event; `{ once: true }` so it costs one call. `once` only removes
     * the listener that actually fired, so the other one is taken off by hand —
     * a keyboard player must not leave a pointer listener bound for the life of
     * the page, and vice versa.
     *
     * Runs whether or not the player is muted. Mute is a preference that can
     * change at any moment; the gesture is a moment that does not come back, and
     * a player who unmutes an hour in would otherwise find the context still
     * suspended with no gesture left to wake it.
     */
    function unlock(): void {
        for (const type of UNLOCK_EVENTS) deps.gestures.removeEventListener(type, unlock, { capture: true });
        ensureContext();
    }

    for (const type of UNLOCK_EVENTS) deps.gestures.addEventListener(type, unlock, { once: true, capture: true });

    function noiseBuffer(ctx: AudioContextLike): AudioBufferLike {
        if (noise !== null) return noise;

        const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
        const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i += 1) samples[i] = deps.random() * 2 - 1;

        noise = buffer;
        return buffer;
    }

    // ------------------------------------------------------ loading recordings

    /**
     * Fetch and decode one path, once, ever.
     *
     * Every failure lands in the same place and does the same thing: mark the
     * path settled and return. A cue then keeps synthesising and a bed simply
     * never arrives, which is the behaviour the game had before any of these
     * files existed. Nothing here is worth taking a table down for, and nothing
     * here retries — a path that 404s would otherwise be re-fetched on every
     * play for the length of the match.
     */
    async function decode(ctx: AudioContextLike, path: string): Promise<AudioBufferLike | null> {
        if (settled.has(path)) return null;
        settled.add(path);

        const fetchBytes = deps.loadAudio;
        if (fetchBytes === undefined || ctx.decodeAudioData === undefined) return null;

        try {
            return await ctx.decodeAudioData(await fetchBytes(path));
        } catch {
            return null;
        }
    }

    /**
     * Pull in all nine cues as soon as there is a context to decode them with.
     *
     * Eager for the cues and lazy for the beds, which is not an inconsistency:
     * the nine cues together are a few hundred kilobytes and any of them can be
     * needed within a second of the first tap, whereas one bed is larger than
     * all nine and a session will only ever want one or two. Loading beds up
     * front would spend the most bandwidth on the least urgent audio.
     *
     * Fire-and-forget on purpose — `play` never waits on this, it just checks
     * whether the buffer happens to be there yet.
     */
    function preloadCues(ctx: AudioContextLike): void {
        if (cuesRequested || deps.loadAudio === undefined) return;
        cuesRequested = true;

        for (const name of Object.keys(SOUNDS) as SoundName[]) {
            void decode(ctx, soundSpec(name).samplePath).then(buffer => {
                if (buffer !== null) samples.set(name, buffer);
            });
        }
    }

    function buildSource(ctx: AudioContextLike, source: SoundSource, start: number, end: number): ScheduledSourceLike {
        if (source.kind === 'noise') {
            const node = ctx.createBufferSource();
            node.buffer = noiseBuffer(ctx);
            // Looped, so a voice longer than the buffer is still a voice rather
            // than a swish that stops halfway through its own envelope.
            node.loop = true;
            return node;
        }

        const node = ctx.createOscillator();
        node.type = source.wave;
        node.frequency.setValueAtTime(source.frequencyHz, start);
        if (source.glideToHz !== undefined) node.frequency.exponentialRampToValueAtTime(source.glideToHz, end);
        return node;
    }

    function buildFilter(ctx: AudioContextLike, filter: SoundFilter, start: number, end: number): BiquadFilterNodeLike {
        const node = ctx.createBiquadFilter();
        node.type = filter.kind;
        node.Q.value = filter.q;
        node.frequency.setValueAtTime(filter.cutoffHz, start);
        if (filter.sweepToHz !== undefined) node.frequency.exponentialRampToValueAtTime(filter.sweepToHz, end);
        return node;
    }

    /**
     * ADSR, in the only order the Web Audio automation timeline accepts.
     *
     * Linear out of zero, because an exponential ramp cannot start from it;
     * exponential through the decay and the release, because that is what a
     * struck or brushed thing does and a linear fade reads as a fader being
     * pulled; and a final step to true zero, because the `SILENCE` floor left
     * ringing under the next sound is the click this whole function exists to
     * avoid.
     */
    function scheduleEnvelope(param: AudioParamLike, voice: SoundVoice, peak: number, start: number, end: number): void {
        const top = Math.max(peak, SILENCE);
        const attackEnd = start + voice.envelope.attackMs / 1000;
        const decayEnd = attackEnd + voice.envelope.decayMs / 1000;
        const level = Math.max(top * voice.envelope.sustain, SILENCE);
        // `store/sound.ts` asserts attack + decay + release <= duration for
        // every voice, so this clamp never fires for the shipped vocabulary —
        // it is here so that a spec which broke that rule would still schedule a
        // monotonic timeline rather than throwing at a player.
        const releaseStart = Math.max(end - voice.envelope.releaseMs / 1000, decayEnd);

        param.setValueAtTime(0, start);
        param.linearRampToValueAtTime(top, attackEnd);
        param.exponentialRampToValueAtTime(level, decayEnd);
        param.setValueAtTime(level, releaseStart);
        param.exponentialRampToValueAtTime(SILENCE, end);
        param.setValueAtTime(0, end);
    }

    function startVoice(ctx: AudioContextLike, out: GainNodeLike, spec: SoundSpec, voice: SoundVoice): void {
        const start = ctx.currentTime + voice.delayMs / 1000;
        const end = start + voice.durationMs / 1000;

        const amp = ctx.createGain();
        // The design's ceiling applied here rather than trusted: jitter
        // multiplies the master gain, so a spec written at MAX_GAIN can leave
        // the pure layer slightly above it.
        scheduleEnvelope(amp.gain, voice, Math.min(spec.gain, MAX_GAIN) * voice.gain, start, end);

        const source = buildSource(ctx, voice.source, start, end);
        const filter = voice.filter === undefined ? null : buildFilter(ctx, voice.filter, start, end);

        if (filter === null) {
            source.connect(amp);
        } else {
            source.connect(filter);
            filter.connect(amp);
        }
        amp.connect(out);

        voices += 1;
        source.addEventListener('ended', () => {
            voices = Math.max(0, voices - 1);
            source.disconnect();
            filter?.disconnect();
            amp.disconnect();
        });

        source.start(start);
        source.stop(end);
    }

    /**
     * One recorded cue, played flat.
     *
     * No envelope, and that is the difference from `startVoice` rather than an
     * omission: the file already *contains* its attack and its tail, trimmed and
     * faded when it was mastered. Scheduling an ADSR over the top would be a
     * second envelope fighting the one in the audio.
     */
    function playSample(ctx: AudioContextLike, out: GainNodeLike, spec: SoundSpec, buffer: AudioBufferLike): void {
        const varied = varySample(spec, deps.random);
        const start = ctx.currentTime;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        // Absent on a double written before sampling existed; a recording that
        // cannot be detuned is still a recording.
        source.playbackRate?.setValueAtTime(varied.playbackRate, start);

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(varied.gain, start);

        source.connect(amp);
        amp.connect(out);

        voices += 1;
        source.addEventListener('ended', () => {
            voices = Math.max(0, voices - 1);
            source.disconnect();
            amp.disconnect();
        });

        // Started but never stopped: a non-looping buffer ends itself and fires
        // `ended` when it does. Scheduling a stop would clip the tail the
        // mastering pass was careful to keep.
        source.start(start);
    }

    // ---------------------------------------------------------------- ambience

    /**
     * Take the bed away, fading rather than cutting.
     *
     * The `ended` handler is attached here rather than at start because a
     * looping source has no natural end — it fires `ended` only in response to
     * this `stop`, so this is the one path on which its nodes can be released.
     * That asymmetry is also why a bed must never be counted in `voices`: a loop
     * that is still playing would hold its slot forever, and after `MAX_VOICES`
     * bed changes the table would fall silent with nothing to show for it.
     */
    function stopBed(): void {
        const bed = currentBed;
        if (bed === null || context === null) return;
        currentBed = null;

        const at = context.currentTime;
        const until = at + AMBIENCE_FADE_MS / 1000;

        bed.amp.gain.cancelScheduledValues(at);
        bed.amp.gain.setValueAtTime(bed.amp.gain.value, at);
        bed.amp.gain.linearRampToValueAtTime(0, until);

        bed.source.addEventListener('ended', () => {
            bed.source.disconnect();
            bed.amp.disconnect();
        });
        bed.source.stop(until);
    }

    /** Bring a decoded bed in from silence, looping. */
    function startBed(ctx: AudioContextLike, out: GainNodeLike, name: AmbienceName, buffer: AudioBufferLike): void {
        const start = ctx.currentTime;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        // The files are crossfaded head-to-tail so the seam is continuous;
        // looping one is why that mastering step existed.
        source.loop = true;

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0, start);
        amp.gain.linearRampToValueAtTime(AMBIENCE_GAIN, start + AMBIENCE_FADE_MS / 1000);

        source.connect(amp);
        amp.connect(out);
        source.start(start);

        currentBed = { name, source, amp };
    }

    /**
     * Reconcile what is playing with what the game wants playing.
     *
     * Called from `setAmbience`, from a bed finishing its download, and from
     * unmuting — three different events with one meaning, so they share a body
     * rather than each getting their own subtly different version.
     */
    function reconcileBed(): void {
        // Muted is not "playing quietly": a loop nobody can hear is battery
        // spent on nothing, so it is stopped outright and restored on unmute.
        const wanted = silenced ? null : desiredBed;

        if (currentBed?.name === wanted) return;
        if (wanted === null) {
            stopBed();
            return;
        }

        const ctx = ensureContext();
        if (ctx === null || master === null) return;

        const buffer = beds.get(wanted);
        if (buffer === undefined) {
            void decode(ctx, AMBIENCE[wanted]).then(loaded => {
                if (loaded === null) return;
                beds.set(wanted, loaded);
                // Re-entered rather than started directly: the download is slow
                // enough that the player may have left this screen, and starting
                // it here would drop a lobby bed onto a live table.
                reconcileBed();
            });
            return;
        }

        stopBed();
        startBed(ctx, master, wanted, buffer);
    }

    return {
        play(name) {
            if (silenced) return;

            const ctx = ensureContext();
            if (ctx === null || master === null) return;

            const spec = soundSpec(name);

            // Restraint as data (`SoundSpec.minIntervalMs`): a player tapping a
            // dead card hears one refusal, not nine.
            const nowMs = ctx.currentTime * 1000;
            const previous = lastStart.get(name);
            if (previous !== undefined && nowMs - previous < spec.minIntervalMs) return;

            // The recording wins whenever one has arrived. The recipe below is
            // what plays until then — and forever, if it never does.
            const sample = samples.get(name);
            if (sample !== undefined) {
                // One voice, where the synthesised Mule is four. The budget is
                // about how much can sound at once, and a mixdown is one thing.
                if (voices + 1 > MAX_VOICES) return;
                lastStart.set(name, nowMs);
                playSample(ctx, master, spec, sample);
                return;
            }

            const varied = varySpec(spec, deps.random);

            // Dropped whole, and before the throttle is recorded: a sound that
            // never sounded must not suppress the next one that could.
            if (voices + varied.voices.length > MAX_VOICES) return;

            lastStart.set(name, nowMs);
            for (const voice of varied.voices) startVoice(ctx, master, varied, voice);
        },

        setAmbience(name) {
            desiredBed = name;
            reconcileBed();
        },

        setMuted(next) {
            silenced = next;
            remember(next ? '1' : '0');

            // Before the early return below: a player who mutes before the
            // context exists still has a desired bed, and unmuting later must
            // start it. Reconciling only after that guard would leave the bed
            // permanently off for exactly that player.
            reconcileBed();

            if (context === null || master === null) return;
            // Whatever is already in flight is faded rather than cut. A step
            // through a sounding voice is a click, which is precisely the
            // artefact every envelope in this file is shaped to avoid.
            const at = context.currentTime;
            // Cancelled first, because the timeline is processed in TIME order
            // rather than insertion order: a toggle inside the fade window would
            // otherwise leave the earlier ramp standing, and the master gain
            // would still dive to zero on its way back up.
            master.gain.cancelScheduledValues(at);
            master.gain.setValueAtTime(master.gain.value, at);
            master.gain.linearRampToValueAtTime(next ? 0 : 1, at + MUTE_FADE_MS / 1000);
        },

        muted() {
            return silenced;
        }
    };
}
