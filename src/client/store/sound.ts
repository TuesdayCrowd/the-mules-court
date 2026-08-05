/**
 * What the table sounds like, as data.
 *
 * The same split `diff.ts` → `motion.ts` → `ui/beats.ts` already draws, one
 * layer over: **this module decides what sound an event makes; a `ui/` module
 * knows how to make it.** A frequency written beside an oscillator is a
 * frequency no test can read, so every frequency, cutoff, envelope time and
 * gain in the whole vocabulary lives here, in a plain object, under Node.
 *
 * Every sound has **two** voicings, and this file names both. Each spec is a
 * complete recipe for synthesis — oscillators, filters, envelopes, all of it —
 * and also carries the path of a recorded take under `public/assets/sfx/`. The
 * layer that owns the audio graph prefers the recording and falls back to the
 * recipe.
 *
 * The fallback is the point. A sample can fail to arrive for reasons that have
 * nothing to do with this game — a cold cache on a bad connection, a codec a
 * browser will not decode, a player who opened the tab offline — and a table
 * that answers any of those with silence has lost something a synthesised
 * table would not have lost. Synthesis costs zero bytes and cannot 404, so it
 * stays as the floor rather than being deleted once the files existed.
 *
 * The two voicings are matched in level rather than merely coexisting; see
 * `SAMPLE_GAIN` for the arithmetic that makes them interchangeable.
 *
 * ## The design brief
 *
 * The `designing-an-effect` skill asks two questions of anything added to this
 * table, and sound has to answer both:
 *
 * **Does it survive being heard 200 times?** A match is many rounds and a round
 * is many turns, so the sounds a player hears most are the quietest, the
 * shortest and the most varied — `deal` is 110 ms at gain 0.16 and may shift
 * 12% in pitch on every single play. The ones they hear rarely may ring.
 *
 * **Spend boldness in one place.** The Mule is the game's signature moment and
 * it keeps that role here: `mule` is both the loudest and the longest sound in
 * the set, by construction and by test. Everything else stays out of its way.
 *
 * Direction comes from the subject rather than from the default. Foundation is
 * psychohistory and minds converted without their knowledge, so elimination is
 * a sub-bass sinking under a filtered noise bed, and the Mule adds a pair of
 * detuned tones a semitone apart whose beating *is* the interference. No
 * buzzers, and — checked by `sound.test.ts` — no square or sawtooth waveform
 * anywhere in the palette. Nothing here should ever be harsh.
 */

import type { PlayerId, RedactedView } from '../../game/engine';
import type { ErrorCode } from '../../server/protocol';
import type { PresentationEvent } from './diff';
import type { Screen } from './types';

// ------------------------------------------------------------------ vocabulary

/**
 * Every sound the game can make.
 *
 * Named after `BeatName` in `motion.ts` where the two coincide, so a reader
 * holding one file open can find the other half. Three names have no beat:
 * `your-turn` and `refused` answer things that are not diffed events at all
 * (see `soundForTurnStart` and `soundForNotice`), and `reveal` is what the beat
 * called `peek` sounds like — a snap, not a peek.
 */
export type SoundName =
    | 'deal'
    | 'play'
    | 'reveal'
    | 'your-turn'
    | 'token-award'
    | 'elimination'
    | 'mule'
    | 'victory'
    | 'refused';

/**
 * Deliberately missing `square` and `sawtooth`.
 *
 * Both are rich in odd harmonics and both are what a refusal sound reaches for
 * when nobody is watching. The refusal here is a soft triangle falling a minor
 * third instead, and keeping the harsh two out of the *type* means the next
 * sound added cannot quietly reintroduce them.
 */
export type Waveform = 'sine' | 'triangle';

export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';

/**
 * A voice's raw material.
 *
 * `noise` is unpitched and takes its character entirely from its filter, which
 * is why the pitch jitter below moves cutoffs as well as frequencies — without
 * that, a swish would be the one sound in the set that never varied.
 */
export type SoundSource =
    | { readonly kind: 'noise' }
    | {
          readonly kind: 'tone';
          readonly wave: Waveform;
          readonly frequencyHz: number;
          /** Pitch slides here across the voice's life. Omitted means steady. */
          readonly glideToHz?: number;
      };

export interface SoundFilter {
    readonly kind: FilterKind;
    readonly cutoffHz: number;
    /** Resonance. Kept near 1 throughout: a high Q rings, and a ringing filter is a whistle. */
    readonly q: number;
    /** Cutoff sweeps here across the voice's life. Omitted means static. */
    readonly sweepToHz?: number;
}

/**
 * ADSR in milliseconds, except `sustain`, which is a level in 0..1.
 *
 * `attack + decay + release <= durationMs` for every voice, asserted in the
 * test: a release that outlives its voice is a click, and a click is the one
 * artefact a player will notice on all 200 hearings.
 */
export interface Envelope {
    readonly attackMs: number;
    readonly decayMs: number;
    readonly sustain: number;
    readonly releaseMs: number;
}

export interface SoundVoice {
    readonly source: SoundSource;
    readonly filter?: SoundFilter;
    readonly envelope: Envelope;
    /** Relative level within the sound. The spec's `gain` scales the mix. */
    readonly gain: number;
    /** How long after the sound starts this voice does — the chord's stagger. */
    readonly delayMs: number;
    readonly durationMs: number;
}

/**
 * How much a sound may differ from itself, as a ± ratio.
 *
 * **This is the part that decides whether the table reads as a table.** A real
 * deck never sounds the same twice; a byte-identical sample on every deal is
 * the single loudest signal that a player is looking at software. So the range
 * is data here and `varySpec` applies it with an injected random, which means
 * the variation is deterministic under test and different on every real play.
 *
 * The ratios are not uniform, and the rule is worth stating: **the more often a
 * sound is heard, the more it varies, except where variation would read as a
 * mistake.** `deal` fires many times a round and moves 12% in pitch. The chime
 * and the victory chord move less than 1%, because those are tuned intervals
 * and a reward that lands out of tune reads as a bug rather than as life.
 */
export interface Jitter {
    /** Multiplies every frequency and cutoff in the sound, together, so intervals hold. */
    readonly pitchRatio: number;
    /** Multiplies every duration, delay and envelope time. */
    readonly durationRatio: number;
    /** Multiplies the master gain only, so the internal balance is never disturbed. */
    readonly gainRatio: number;
}

export interface SoundSpec {
    readonly name: SoundName;
    /**
     * The recorded voicing, as a path under `public/assets/`.
     *
     * A path rather than a URL because this layer has no business knowing where
     * the app is mounted; the layer that fetches it resolves the URL. Required
     * rather than optional, so a new `SoundName` cannot ship with a recipe and
     * no recording without the type checker saying so.
     */
    readonly samplePath: string;
    readonly voices: readonly SoundVoice[];
    /** Wall time of the whole sound, tail included. Never shorter than its longest voice. */
    readonly durationMs: number;
    /** Master level, 0..1. Nothing here exceeds `MAX_GAIN`. */
    readonly gain: number;
    /**
     * Refuse to retrigger this sound within this window.
     *
     * Restraint expressed as data rather than as a rule someone has to remember.
     * `RATE_LIMITED` arrives in a burst when a player taps a dead card repeatedly
     * and nine refusal chirps is worse feedback than one; a staggered deal, by
     * contrast, is *supposed* to be several swishes, so `deal` sits below the
     * 40 ms `DEAL_STAGGER_MS` and lets every card sound.
     */
    readonly minIntervalMs: number;
    readonly jitter: Jitter;
}

/**
 * The ceiling every sound is written under.
 *
 * Quiet is the whole brief: this is meant to feel like a table in a room, and a
 * card game is not a place where anything should approach full scale. The
 * headroom also means the ui layer's master control starts from a sane place
 * rather than having to attenuate the design.
 */
export const MAX_GAIN = 0.4;

/**
 * The level every sampled cue plays at — one number for all nine, by construction.
 *
 * The files under `public/assets/sfx/` were mastered by peak-normalising each
 * one to its own `spec.gain / MAX_GAIN`: `deal.mp3` peaks at 0.4 of full scale,
 * `mule.mp3` at 0.85. Multiplying any of them by `MAX_GAIN` therefore lands
 * exactly on that spec's `gain` — 0.4 x 0.4 = 0.16 for the deal, 0.85 x 0.4 =
 * 0.34 for the Mule. The balance this file spends so many words arguing for is
 * baked into the audio itself, so the player needs no per-sound table.
 *
 * The consequence worth stating plainly: **a sample and its synthesised twin
 * play at the same level.** Falling back is not a quieter game or a louder one,
 * which is what makes the fallback safe to take silently. `sound.test.ts`
 * checks that arithmetic rather than trusting this comment.
 */
export const SAMPLE_GAIN = MAX_GAIN;

/**
 * How long the master level takes to reach silence when a player mutes.
 *
 * An envelope time, so it lives here with every other envelope time rather than
 * beside the ramp that schedules it — that is this module's whole brief, and a
 * fade written in the layer that owns the graph is a fade no test can read.
 *
 * Short enough that mute is instant to a player who wanted it *now*, long enough
 * that cutting through a sounding voice is a fade and not the click every
 * envelope above is shaped to avoid. Twenty milliseconds is roughly one cycle of
 * the lowest tone in the vocabulary, which is the floor for "not a step".
 */
export const MUTE_FADE_MS = 20;

// --------------------------------------------------------------- the palette

/**
 * A card leaving the deck for a hand: a swish, not a click.
 *
 * The most-heard sound in the game, so it is the quietest, the shortest and by
 * far the most varied. Bandpassed noise sweeping downward is a card moving
 * through air; the same noise with a static filter is a hiss.
 */
const DEAL: SoundSpec = {
    name: 'deal',
    samplePath: 'sfx/deal.mp3',
    voices: [
        {
            source: { kind: 'noise' },
            filter: { kind: 'bandpass', cutoffHz: 1600, q: 0.9, sweepToHz: 600 },
            envelope: { attackMs: 4, decayMs: 60, sustain: 0, releaseMs: 45 },
            gain: 1,
            delayMs: 0,
            durationMs: 110
        }
    ],
    durationMs: 110,
    gain: 0.16,
    minIntervalMs: 25,
    jitter: { pitchRatio: 0.12, durationRatio: 0.15, gainRatio: 0.15 }
};

/**
 * A card laid onto the table: lower and softer than the deal.
 *
 * Two voices, because card-on-felt is two things at once — the rustle, which is
 * lowpassed noise, and the small thud of the card's own mass, which is a sine
 * near the bottom of what a phone speaker can even reproduce. On a device that
 * cannot, the rustle alone still reads correctly.
 */
const PLAY: SoundSpec = {
    name: 'play',
    samplePath: 'sfx/play.mp3',
    voices: [
        {
            source: { kind: 'noise' },
            filter: { kind: 'lowpass', cutoffHz: 600, q: 0.7, sweepToHz: 240 },
            envelope: { attackMs: 2, decayMs: 90, sustain: 0, releaseMs: 60 },
            gain: 1,
            delayMs: 0,
            durationMs: 155
        },
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 96, glideToHz: 72 },
            envelope: { attackMs: 3, decayMs: 110, sustain: 0, releaseMs: 50 },
            gain: 0.45,
            delayMs: 0,
            durationMs: 165
        }
    ],
    durationMs: 175,
    gain: 0.2,
    minIntervalMs: 40,
    jitter: { pitchRatio: 0.08, durationRatio: 0.12, gainRatio: 0.12 }
};

/**
 * A card turning face-up: a snap.
 *
 * Crisper and higher than either of the above — highpassed noise with a 1 ms
 * attack — because this one carries information. It is the sound of learning
 * something, and it has to cut through a deal happening beside it.
 */
const REVEAL: SoundSpec = {
    name: 'reveal',
    samplePath: 'sfx/reveal.mp3',
    voices: [
        {
            source: { kind: 'noise' },
            filter: { kind: 'highpass', cutoffHz: 2400, q: 0.7 },
            envelope: { attackMs: 1, decayMs: 30, sustain: 0, releaseMs: 30 },
            gain: 1,
            delayMs: 0,
            durationMs: 70
        },
        {
            source: { kind: 'tone', wave: 'triangle', frequencyHz: 1400, glideToHz: 900 },
            envelope: { attackMs: 1, decayMs: 25, sustain: 0, releaseMs: 25 },
            gain: 0.25,
            delayMs: 0,
            durationMs: 60
        }
    ],
    durationMs: 90,
    gain: 0.18,
    minIntervalMs: 40,
    jitter: { pitchRatio: 0.09, durationRatio: 0.12, gainRatio: 0.12 }
};

/**
 * Your turn has begun.
 *
 * The highest quality-of-life sound in the set and the reason to build any of
 * this: a player who looked away knows it is on them without reading anything.
 * Two soft sines rising a fifth — a question rather than a fanfare — and both
 * lowpassed, because a bright cue you hear forty times in a match is a bright
 * cue you come to dread.
 *
 * Almost no pitch jitter. This is the one sound whose *identity* matters: it
 * has to be recognisable from another room, and a cue that wanders is a cue
 * that has to be listened to rather than noticed.
 */
const YOUR_TURN: SoundSpec = {
    name: 'your-turn',
    samplePath: 'sfx/your-turn.mp3',
    voices: [
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 523.25 },
            filter: { kind: 'lowpass', cutoffHz: 2400, q: 0.6 },
            envelope: { attackMs: 16, decayMs: 110, sustain: 0, releaseMs: 130 },
            gain: 0.8,
            delayMs: 0,
            durationMs: 260
        },
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 783.99 },
            filter: { kind: 'lowpass', cutoffHz: 2600, q: 0.6 },
            envelope: { attackMs: 16, decayMs: 130, sustain: 0, releaseMs: 170 },
            gain: 0.6,
            delayMs: 100,
            durationMs: 320
        }
    ],
    durationMs: 430,
    gain: 0.17,
    minIntervalMs: 600,
    jitter: { pitchRatio: 0.006, durationRatio: 0.05, gainRatio: 0.08 }
};

/**
 * A devotion token awarded — the reward sound, and the one players will play
 * for.
 *
 * A struck chime: A5 with its fifth a beat later and a quiet harmonic on top,
 * all three decaying at different rates the way a real strike does. The tail
 * outlasts the shimmer beat on purpose; a chime cut off at 300 ms is a beep.
 *
 * Tuned, so it barely varies. Everything else on this table may breathe.
 */
const TOKEN_AWARD: SoundSpec = {
    name: 'token-award',
    samplePath: 'sfx/token-award.mp3',
    voices: [
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 880 },
            envelope: { attackMs: 6, decayMs: 260, sustain: 0, releaseMs: 620 },
            gain: 0.9,
            delayMs: 0,
            durationMs: 890
        },
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 1318.51 },
            envelope: { attackMs: 6, decayMs: 200, sustain: 0, releaseMs: 520 },
            gain: 0.5,
            delayMs: 55,
            durationMs: 760
        },
        {
            source: { kind: 'tone', wave: 'triangle', frequencyHz: 2637.02 },
            filter: { kind: 'lowpass', cutoffHz: 5200, q: 0.6 },
            envelope: { attackMs: 4, decayMs: 90, sustain: 0, releaseMs: 220 },
            gain: 0.14,
            delayMs: 0,
            durationMs: 320
        }
    ],
    durationMs: 890,
    gain: 0.24,
    minIntervalMs: 300,
    jitter: { pitchRatio: 0.005, durationRatio: 0.05, gainRatio: 0.08 }
};

/**
 * A player eliminated: dread, not a buzzer.
 *
 * The subject is a mind converted without its knowledge, so this sinks rather
 * than stings — a sine sliding an octave down under a lowpassed noise bed that
 * fades in behind it. A slow 45 ms attack, which is the whole difference
 * between something arriving and something being triggered.
 */
const ELIMINATION: SoundSpec = {
    name: 'elimination',
    samplePath: 'sfx/elimination.mp3',
    voices: [
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 110, glideToHz: 58 },
            filter: { kind: 'lowpass', cutoffHz: 320, q: 0.9 },
            envelope: { attackMs: 45, decayMs: 420, sustain: 0.25, releaseMs: 420 },
            gain: 1,
            delayMs: 0,
            durationMs: 890
        },
        {
            source: { kind: 'noise' },
            filter: { kind: 'lowpass', cutoffHz: 220, q: 0.6, sweepToHz: 90 },
            envelope: { attackMs: 120, decayMs: 400, sustain: 0.15, releaseMs: 320 },
            gain: 0.35,
            delayMs: 40,
            durationMs: 840
        }
    ],
    durationMs: 890,
    gain: 0.22,
    minIntervalMs: 200,
    jitter: { pitchRatio: 0.05, durationRatio: 0.08, gainRatio: 0.1 }
};

/**
 * The Mule turns face-up. The one place the boldness is spent.
 *
 * Four voices, each answering a step of the visual beat rather than piling on:
 * noise swelling upward through a bandpass is the **ripple**; a sub-bass
 * sliding from 55 Hz to 31 Hz over most of two seconds is the **loom**; and a
 * pair of triangles a semitone apart — B♭3 against B3, both drifting downward —
 * beat against each other at a few hertz, which is what mentalic interference
 * sounds like and what no other sound in this set is allowed to do.
 *
 * Loudest and longest in the vocabulary, asserted rather than intended. If a
 * future sound outgrows it, one of the two is wrong, and it is not this one.
 */
const MULE: SoundSpec = {
    name: 'mule',
    samplePath: 'sfx/mule.mp3',
    voices: [
        {
            source: { kind: 'noise' },
            filter: { kind: 'bandpass', cutoffHz: 300, q: 1.4, sweepToHz: 2600 },
            envelope: { attackMs: 600, decayMs: 200, sustain: 0.4, releaseMs: 500 },
            gain: 0.5,
            delayMs: 0,
            durationMs: 1300
        },
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 55, glideToHz: 31 },
            filter: { kind: 'lowpass', cutoffHz: 180, q: 0.8 },
            envelope: { attackMs: 200, decayMs: 700, sustain: 0.3, releaseMs: 700 },
            gain: 1,
            delayMs: 200,
            durationMs: 1600
        },
        {
            source: { kind: 'tone', wave: 'triangle', frequencyHz: 233.08, glideToHz: 220 },
            filter: { kind: 'lowpass', cutoffHz: 700, q: 0.7 },
            envelope: { attackMs: 350, decayMs: 500, sustain: 0.2, releaseMs: 600 },
            gain: 0.35,
            delayMs: 300,
            durationMs: 1450
        },
        {
            source: { kind: 'tone', wave: 'triangle', frequencyHz: 246.94, glideToHz: 233 },
            filter: { kind: 'lowpass', cutoffHz: 700, q: 0.7 },
            envelope: { attackMs: 350, decayMs: 500, sustain: 0.2, releaseMs: 600 },
            gain: 0.3,
            delayMs: 330,
            durationMs: 1450
        }
    ],
    durationMs: 1800,
    gain: 0.34,
    minIntervalMs: 0,
    jitter: { pitchRatio: 0.03, durationRatio: 0.06, gainRatio: 0.06 }
};

/**
 * The match is won.
 *
 * A warm major triad rolled rather than struck — the token chime's bigger
 * sibling, and deliberately still smaller than the Mule. It happens once,
 * with nothing else competing for attention, which is the only reason a
 * 1.2-second sound is affordable at all.
 */
const VICTORY: SoundSpec = {
    name: 'victory',
    samplePath: 'sfx/victory.mp3',
    voices: [
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 440 },
            envelope: { attackMs: 12, decayMs: 300, sustain: 0.15, releaseMs: 700 },
            gain: 0.9,
            delayMs: 0,
            durationMs: 1150
        },
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 554.37 },
            envelope: { attackMs: 12, decayMs: 300, sustain: 0.12, releaseMs: 650 },
            gain: 0.6,
            delayMs: 90,
            durationMs: 1060
        },
        {
            source: { kind: 'tone', wave: 'sine', frequencyHz: 659.25 },
            envelope: { attackMs: 12, decayMs: 320, sustain: 0.1, releaseMs: 700 },
            gain: 0.5,
            delayMs: 180,
            durationMs: 1040
        }
    ],
    durationMs: 1230,
    gain: 0.26,
    minIntervalMs: 0,
    jitter: { pitchRatio: 0.005, durationRatio: 0.04, gainRatio: 0.06 }
};

/**
 * The action was refused.
 *
 * Brief, low, and unmistakably negative without being a punishment: a single
 * triangle falling a minor third (G3 to E♭3) behind a lowpass, which is the
 * shape of "no" in almost every language and none of the shape of a klaxon.
 * The 250 ms floor on retriggering is the important half — a player tapping a
 * card that cannot be played must hear one refusal, not a stutter.
 */
const REFUSED: SoundSpec = {
    name: 'refused',
    samplePath: 'sfx/refused.mp3',
    voices: [
        {
            source: { kind: 'tone', wave: 'triangle', frequencyHz: 196, glideToHz: 155.56 },
            filter: { kind: 'lowpass', cutoffHz: 900, q: 0.8 },
            envelope: { attackMs: 8, decayMs: 90, sustain: 0.2, releaseMs: 110 },
            gain: 1,
            delayMs: 0,
            durationMs: 210
        }
    ],
    durationMs: 220,
    gain: 0.16,
    minIntervalMs: 250,
    jitter: { pitchRatio: 0.02, durationRatio: 0.06, gainRatio: 0.08 }
};

/** Every sound, by name. Total over `SoundName` — a missing entry is a compile error. */
export const SOUNDS: Readonly<Record<SoundName, SoundSpec>> = {
    deal: DEAL,
    play: PLAY,
    reveal: REVEAL,
    'your-turn': YOUR_TURN,
    'token-award': TOKEN_AWARD,
    elimination: ELIMINATION,
    mule: MULE,
    victory: VICTORY,
    refused: REFUSED
};

export function soundSpec(name: SoundName): SoundSpec {
    return SOUNDS[name];
}

// ------------------------------------------------------------------ selection

/**
 * Which sound a presentation event makes, if any.
 *
 * Mirrors `beatForEvent` in `motion.ts` deliberately, exhaustive `never` and
 * all: an event that computes a sound and then gets dropped is silent, which is
 * indistinguishable from a design decision and is exactly how the peek beat
 * once shipped doing nothing.
 *
 * `null` is a real answer, and most of the log gets it. Every entry kind is a
 * toast already; giving each one a noise is how a table stops having any sound
 * that means anything. `GUESS`, `COMPARE` and `TRADED` are silent because their
 * *consequence* is a separate `ELIMINATED` entry that speaks for them, and
 * `ROUND_END` is silent because `round-over` is about to ring the chime.
 */
export function soundForEvent(event: PresentationEvent): SoundName | null {
    switch (event.kind) {
        case 'log':
            if (event.entry.kind === 'PLAY') return 'play';
            if (event.entry.kind === 'ELIMINATED') {
                // As with the beat (UIX §8.3): a voluntary and a forced Mule
                // discard are identical, because the dread does not depend on
                // who chose it.
                return event.entry.cause === 'mule-voluntary' || event.entry.cause === 'mule-forced' ? 'mule' : 'elimination';
            }
            return null;

        case 'card-drawn':
            return 'deal';

        case 'peek-gained':
            return 'reveal';

        // Knowledge going stale has no moment, so it has no sound.
        case 'peek-lost':
            return null;

        case 'round-over':
            return 'token-award';

        case 'match-over':
            return 'victory';

        default: {
            const exhaustive: never = event;
            return exhaustive;
        }
    }
}

/**
 * Whether the turn just passed to this viewer, and therefore whether to cue.
 *
 * Not a `PresentationEvent`, and that is a decision rather than an oversight.
 * `diffSnapshots` emits what *happened at the table* — things every seat would
 * describe the same way. "It is your turn now" is true of exactly one viewer,
 * so it belongs beside the sound that answers it rather than in a shared event
 * union where every consumer would have to remember to ignore it.
 *
 * This derives no rule. `currentPlayerId` and `alive` are public board state
 * pushed by the server; comparing two of them is the same work `diff.ts`
 * already does.
 *
 * Three conditions, each of which was a wrong cue before it was a clause:
 *
 * - **`prev === null` is silent.** That is first load and reconnect, and
 *   `diffSnapshots` makes the same choice for the same reason — a player who
 *   was away should see the table as it stands, not be chimed at by it.
 * - **A finished round is silent.** `currentPlayerId` still names someone
 *   during the reveal window, and cueing a turn nobody can take is worse than
 *   saying nothing.
 * - **A new round re-cues even if you were already current.** Round two dealing
 *   to the same starting seat leaves `currentPlayerId` unchanged across the
 *   whole boundary, so a plain transition test would go quiet in precisely the
 *   moment the player most needs telling.
 */
export function soundForTurnStart(prev: RedactedView | null, next: RedactedView): SoundName | null {
    if (prev === null) return null;
    if (next.roundResult !== null || next.matchWinnerId !== null) return null;

    const you = next.own.playerId;
    if (next.currentPlayerId !== you) return null;
    if (!isAlive(next, you)) return null;

    const turnPassed = prev.currentPlayerId !== you;
    const roundBegan = prev.roundResult !== null;

    return turnPassed || roundBegan ? 'your-turn' : null;
}

function isAlive(view: RedactedView, seatId: PlayerId): boolean {
    return view.players.find(player => player.id === seatId)?.alive ?? false;
}

/**
 * The sound a refused action makes.
 *
 * Total over `ErrorCode` and constant, on purpose. Every code that reaches a
 * player — a rule refusal forwarded from the engine, `RATE_LIMITED`, `PAUSED`,
 * a fatal — means the same thing to their ear: *that did not happen*. Splitting
 * the noise by cause would be teaching the player a second vocabulary to learn
 * nothing extra from, and the toast already carries the words.
 *
 * It stays a function of the code rather than a bare constant so that the day
 * one code genuinely deserves its own sound, there is a place to put it that
 * every call site already routes through.
 */
export function soundForNotice(code: ErrorCode): SoundName {
    void code;
    return 'refused';
}

// ------------------------------------------------------------------ ambience

/**
 * The beds that play under a screen, named for the situation rather than the file.
 *
 * A bed is the one thing the synthesis vocabulary above genuinely cannot do. An
 * oscillator can imitate a struck chime convincingly; nothing built from four
 * oscillators sounds like a *room*, because a room is thousands of uncorrelated
 * reflections and that is exactly what additive synthesis is worst at. So these
 * are files with no fallback — if one fails to load the game simply has no bed,
 * which is what it had before they existed.
 *
 * Named for the moment, not the recording, so re-cutting the audio never
 * reaches a call site.
 */
export type AmbienceName = 'menu' | 'lobby' | 'table' | 'eliminated';

/** Each bed's path under `public/assets/`, resolved to a URL by the layer that fetches it. */
export const AMBIENCE: Readonly<Record<AmbienceName, string>> = {
    menu: 'sfx/amb-vault.mp3',
    lobby: 'sfx/amb-lobby.mp3',
    table: 'sfx/amb-table.mp3',
    eliminated: 'sfx/amb-mule-presence.mp3'
};

/**
 * How loud a bed sits under the table.
 *
 * The files are mastered to a peak of 0.125 (−18 dBFS), so this puts them near
 * 0.06 — well under `deal`, the quietest thing in the cue vocabulary at 0.16.
 * That ordering is the whole design: a bed a player *notices* has stopped being
 * a bed, and one that competes with the deal has started hiding information.
 */
export const AMBIENCE_GAIN = 0.5;

/**
 * How long a bed takes to arrive, leave, or hand over to another.
 *
 * Far longer than `MUTE_FADE_MS`, and for the opposite reason. Mute is a
 * player's own instruction and should feel instant; a bed changing is a
 * consequence of the game moving, and a room tone that snapped in would announce
 * itself as a sound effect. Nobody should ever catch one starting.
 */
export const AMBIENCE_FADE_MS = 800;

/**
 * Which bed belongs under this screen, if any.
 *
 * A pure function of state the server already pushed, deriving no rule — the
 * same standard `soundForTurnStart` is held to. Four decisions, each argued:
 *
 * - **The menu and the join prompt share the vault.** Both are the player
 *   standing outside the game, and a second bed for the two seconds of
 *   `joining` would be a change nobody could hear the reason for.
 * - **A finished match lifts the pressure.** The victory chord is the largest
 *   reward the game gives; ringing it out over a bed of mentalic dread because
 *   the listener happened to lose is a worse table than having no bed at all.
 * - **An eliminated player hears the Mule's room.** They are still watching, and
 *   the subject of this game is a mind that has been taken over and left in the
 *   room. It is the one place a bed carries meaning rather than atmosphere.
 * - **A fatal screen is silent.** Something has gone wrong enough that the
 *   player is being asked to act; scoring that moment would be grotesque.
 */
export function ambienceFor(screen: Screen, view: RedactedView | null): AmbienceName | null {
    switch (screen) {
        case 'menu':
        case 'joining':
            return 'menu';

        case 'lobby':
            return 'lobby';

        case 'table': {
            if (view === null) return 'table';
            if (view.matchWinnerId !== null) return 'table';
            return isAlive(view, view.own.playerId) ? 'table' : 'eliminated';
        }

        case 'fatal':
            return null;

        default: {
            const exhaustive: never = screen;
            return exhaustive;
        }
    }
}

// -------------------------------------------------------------------- jitter

/** `random()` is expected in [0, 1); anything outside is clamped rather than trusted. */
function factor(ratio: number, random: () => number): number {
    const draw = Math.min(Math.max(random(), 0), 1);
    return 1 + (draw * 2 - 1) * ratio;
}

/**
 * One play's worth of a sound: the spec with its jitter actually applied.
 *
 * Here rather than in the audio layer for this module's whole reason. The layer
 * that owns the graph should walk numbers, not invent them, and a variation
 * computed beside an oscillator is a variation no test can pin down. With this,
 * a test supplies `() => 0` and `() => 1` and reads the extremes of what a
 * player can ever hear.
 *
 * Three draws, not one per voice. The whole sound transposes and stretches
 * together, so the chime's fifth is still a fifth and the Mule's semitone is
 * still a semitone — jittering voices independently would detune the intervals
 * that carry the meaning. Gain is applied to the master only, leaving the mix
 * exactly as designed.
 */
export function varySpec(spec: SoundSpec, random: () => number): SoundSpec {
    const pitch = factor(spec.jitter.pitchRatio, random);
    const time = factor(spec.jitter.durationRatio, random);
    const level = factor(spec.jitter.gainRatio, random);

    return {
        ...spec,
        gain: spec.gain * level,
        durationMs: spec.durationMs * time,
        voices: spec.voices.map(voice => varyVoice(voice, pitch, time))
    };
}

function varyVoice(voice: SoundVoice, pitch: number, time: number): SoundVoice {
    return {
        ...voice,
        source: varySource(voice.source, pitch),
        // Cutoffs move with pitch too. Noise has no frequency of its own, so
        // without this the swish — the most-heard sound in the game — would be
        // the one thing that sounded identical every time.
        filter: voice.filter && {
            ...voice.filter,
            cutoffHz: voice.filter.cutoffHz * pitch,
            ...(voice.filter.sweepToHz === undefined ? {} : { sweepToHz: voice.filter.sweepToHz * pitch })
        },
        envelope: {
            attackMs: voice.envelope.attackMs * time,
            decayMs: voice.envelope.decayMs * time,
            sustain: voice.envelope.sustain,
            releaseMs: voice.envelope.releaseMs * time
        },
        delayMs: voice.delayMs * time,
        durationMs: voice.durationMs * time
    };
}

/** One play's worth of variation for a *recording*, which varies differently. */
export interface SampleVariation {
    /**
     * Playback speed, and therefore pitch.
     *
     * On a buffer these are the same knob: playing a recording 5% fast makes it
     * 5% higher *and* 5% shorter, and prising them apart needs a time-stretcher
     * this project is not going to grow. So `jitter.durationRatio` — which
     * `varySpec` honours independently — has no counterpart here, and a sample
     * breathes on two axes where its synthesised twin breathes on three.
     */
    readonly playbackRate: number;
    /** Absolute gain to play the buffer at, jitter already applied. */
    readonly gain: number;
}

/**
 * One play's worth of a sampled cue.
 *
 * Two draws rather than `varySpec`'s three, in the same order it draws its
 * first two, so a test that fixes the random reads the same pitch factor out of
 * both paths. The gain starts from `SAMPLE_GAIN` — see that constant for why
 * one number covers all nine sounds.
 */
export function varySample(spec: SoundSpec, random: () => number): SampleVariation {
    return {
        playbackRate: factor(spec.jitter.pitchRatio, random),
        gain: SAMPLE_GAIN * factor(spec.jitter.gainRatio, random)
    };
}

function varySource(source: SoundSource, pitch: number): SoundSource {
    if (source.kind === 'noise') return source;
    return {
        ...source,
        frequencyHz: source.frequencyHz * pitch,
        ...(source.glideToHz === undefined ? {} : { glideToHz: source.glideToHz * pitch })
    };
}
