import { describe, expect, it } from 'vitest';
import type { PublicLogEntry } from '../../game/engine';
import type { ErrorCode } from '../../server/protocol';
import type { PresentationEvent } from './diff';
import type { SoundName, SoundSpec, SoundVoice } from './sound';
import {
    MAX_GAIN,
    MUTE_FADE_MS,
    SOUNDS,
    soundForEvent,
    soundForNotice,
    soundForTurnStart,
    soundSpec,
    varySpec
} from './sound';
import { DEAL_STAGGER_MS } from './motion';
import { makeView } from './__fixtures__/view';

const ALL: SoundName[] = ['deal', 'play', 'reveal', 'your-turn', 'token-award', 'elimination', 'mule', 'victory', 'refused'];

/** Every kind of thing `diffSnapshots` can emit, one representative each. */
const EVERY_EVENT: readonly PresentationEvent[] = [
    { kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' } },
    { kind: 'peek-lost', subjectId: 'p2' },
    { kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' },
    { kind: 'card-drawn', seatId: 'p1', cardTypeId: 'informant' },
    { kind: 'card-drawn', seatId: 'p2' },
    { kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } },
    { kind: 'match-over', winnerId: 'p1' }
];

/** Every variant of `PublicLogEntry`, so a new one cannot slip past the mapping unexamined. */
const EVERY_LOG_ENTRY: readonly PublicLogEntry[] = [
    { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' },
    { kind: 'GUESS', turn: 1, actorId: 'p1', targetId: 'p2', guessedValue: 5, hit: true },
    { kind: 'COMPARE', turn: 1, actorId: 'p1', targetId: 'p2', result: 'tie' },
    { kind: 'PROTECTED', turn: 1, actorId: 'p1' },
    { kind: 'TRADED', turn: 1, actorId: 'p1', targetId: 'p2' },
    { kind: 'REDREW', turn: 1, actorId: 'p1', targetId: 'p2', drewFrom: 'deck' },
    { kind: 'FIZZLE', turn: 1, actorId: 'p1', cardId: 'informant' },
    { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'guard' },
    { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'baron' },
    { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'mule-voluntary' },
    { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause: 'mule-forced' },
    { kind: 'ROUND_END', turn: 1, reason: 'deck-out', winners: ['p1'] }
];

const EVERY_ERROR_CODE: readonly ErrorCode[] = [
    'MALFORMED',
    'ROOM_NOT_FOUND',
    'SEAT_TAKEN',
    'ROOM_FULL',
    'ALREADY_SEATED',
    'BAD_TOKEN',
    'NOT_YOUR_SEAT',
    'NOT_HOST',
    'CANNOT_START',
    'PAUSED',
    'MATCH_OVER',
    'RATE_LIMITED',
    'INTERNAL'
];

/** The last moment a voice makes any sound. */
function voiceEndMs(voice: SoundVoice): number {
    return voice.delayMs + voice.durationMs;
}

function envelopeMs(voice: SoundVoice): number {
    return voice.envelope.attackMs + voice.envelope.decayMs + voice.envelope.releaseMs;
}

function frequencies(spec: SoundSpec): number[] {
    return spec.voices.flatMap(voice => (voice.source.kind === 'tone' ? [voice.source.frequencyHz] : []));
}

describe('the palette is well-formed', () => {
    it('has a spec for every name, keyed by its own name', () => {
        for (const name of ALL) {
            expect(soundSpec(name).name, name).toBe(name);
        }
        expect(Object.keys(SOUNDS).sort()).toEqual([...ALL].sort());
    });

    it('makes every sound out of at least one voice', () => {
        for (const name of ALL) {
            expect(soundSpec(name).voices.length, name).toBeGreaterThan(0);
        }
    });

    it('stays under the gain ceiling, because this is a table in a room', () => {
        for (const name of ALL) {
            const spec = soundSpec(name);
            expect(spec.gain, name).toBeGreaterThan(0);
            expect(spec.gain, name).toBeLessThanOrEqual(MAX_GAIN);
        }
    });

    it('never lets a voice outlive the sound that contains it', () => {
        // Otherwise the ui layer tears down the graph mid-tail, which is a click.
        for (const name of ALL) {
            const spec = soundSpec(name);
            for (const voice of spec.voices) {
                expect(voiceEndMs(voice), `${name} voice`).toBeLessThanOrEqual(spec.durationMs);
            }
        }
    });

    it('never gives a voice an envelope longer than the voice', () => {
        // A release that has not finished when the voice is stopped is the one
        // artefact a player will notice on all 200 hearings.
        for (const name of ALL) {
            for (const voice of soundSpec(name).voices) {
                expect(envelopeMs(voice), `${name} voice`).toBeLessThanOrEqual(voice.durationMs);
            }
        }
    });

    it('keeps every level, sustain and interval a sane number', () => {
        for (const name of ALL) {
            const spec = soundSpec(name);
            expect(spec.minIntervalMs, name).toBeGreaterThanOrEqual(0);
            expect(spec.durationMs, name).toBeGreaterThan(0);
            for (const voice of spec.voices) {
                expect(voice.gain, name).toBeGreaterThan(0);
                expect(voice.gain, name).toBeLessThanOrEqual(1);
                expect(voice.envelope.sustain, name).toBeGreaterThanOrEqual(0);
                expect(voice.envelope.sustain, name).toBeLessThanOrEqual(1);
                expect(voice.delayMs, name).toBeGreaterThanOrEqual(0);
            }
        }
    });

    it('keeps every frequency and cutoff inside human hearing', () => {
        for (const name of ALL) {
            for (const voice of soundSpec(name).voices) {
                if (voice.source.kind === 'tone') {
                    for (const hz of [voice.source.frequencyHz, voice.source.glideToHz ?? voice.source.frequencyHz]) {
                        expect(hz, name).toBeGreaterThanOrEqual(20);
                        expect(hz, name).toBeLessThanOrEqual(20_000);
                    }
                }
                if (voice.filter) {
                    for (const hz of [voice.filter.cutoffHz, voice.filter.sweepToHz ?? voice.filter.cutoffHz]) {
                        expect(hz, name).toBeGreaterThanOrEqual(20);
                        expect(hz, name).toBeLessThanOrEqual(20_000);
                    }
                    // A resonant filter rings, and a ringing filter is a whistle.
                    expect(voice.filter.q, name).toBeGreaterThan(0);
                    expect(voice.filter.q, name).toBeLessThanOrEqual(2);
                }
            }
        }
    });

    it('reaches for no harsh waveform anywhere, not even the refusal', () => {
        // The type already excludes square and sawtooth; this is the guard for
        // the day someone widens the type to get "just one" buzzer.
        for (const name of ALL) {
            for (const voice of soundSpec(name).voices) {
                if (voice.source.kind === 'tone') {
                    expect(['sine', 'triangle'], `${name} uses ${voice.source.wave}`).toContain(voice.source.wave);
                }
            }
        }
    });
});

describe('the two rules of taste', () => {
    it('spends the boldness on the Mule: loudest of anything on the table', () => {
        for (const name of ALL) {
            if (name === 'mule') continue;
            expect(soundSpec('mule').gain, name).toBeGreaterThan(soundSpec(name).gain);
        }
    });

    it('spends it there in length too, the victory chord included', () => {
        for (const name of ALL) {
            if (name === 'mule') continue;
            expect(soundSpec('mule').durationMs, name).toBeGreaterThan(soundSpec(name).durationMs);
        }
    });

    it('keeps everything heard many times a round short', () => {
        // The "does it survive 200 hearings" test, as arithmetic. A long sound
        // is affordable only where it is rare.
        for (const name of ['deal', 'play', 'reveal', 'your-turn', 'refused'] as const) {
            expect(soundSpec(name).durationMs, name).toBeLessThan(500);
        }
    });

    it('keeps them quiet as well as short', () => {
        for (const name of ['deal', 'play', 'reveal', 'your-turn', 'refused'] as const) {
            expect(soundSpec(name).gain, name).toBeLessThan(soundSpec('token-award').gain);
        }
    });

    it('lets every card of a staggered deal sound', () => {
        // The retrigger floor is restraint, not a mute: a deal is *supposed* to
        // be several swishes 40ms apart.
        expect(soundSpec('deal').minIntervalMs).toBeLessThan(DEAL_STAGGER_MS);
    });

    it('refuses to stutter when a player taps a dead card repeatedly', () => {
        expect(soundSpec('refused').minIntervalMs).toBeGreaterThanOrEqual(200);
    });
});

describe('the mute fade', () => {
    it('is data here, with every other envelope time', () => {
        // It lived beside the ramp that schedules it, in the layer whose own
        // header forbids exactly that. A number the audio layer keeps to itself
        // is a number no test can read.
        expect(MUTE_FADE_MS).toBeGreaterThan(0);
    });

    it('is a fade rather than a step, and still instant to the player who wanted it', () => {
        // Below roughly one cycle of the lowest tone in the vocabulary it stops
        // being a fade and becomes the click every envelope here avoids; much
        // above this it stops being the "stop now" a mute button promises.
        expect(MUTE_FADE_MS).toBeGreaterThanOrEqual(10);
        expect(MUTE_FADE_MS).toBeLessThanOrEqual(60);
    });

    it('is shorter than the shortest sound it has to cut through', () => {
        for (const name of ALL) {
            expect(MUTE_FADE_MS, name).toBeLessThan(soundSpec(name).durationMs);
        }
    });
});

describe('jitter', () => {
    it('gives every sound some room to breathe on every axis', () => {
        // A byte-identical sound on every play is the loudest signal that this
        // is software rather than a table.
        for (const name of ALL) {
            const { jitter } = soundSpec(name);
            expect(jitter.pitchRatio, `${name} pitch`).toBeGreaterThan(0);
            expect(jitter.durationRatio, `${name} duration`).toBeGreaterThan(0);
            expect(jitter.gainRatio, `${name} gain`).toBeGreaterThan(0);
        }
    });

    it('keeps every range short of the point where a sound stops being itself', () => {
        for (const name of ALL) {
            const { jitter } = soundSpec(name);
            for (const [axis, ratio] of Object.entries(jitter)) {
                expect(ratio, `${name} ${axis}`).toBeLessThan(0.5);
            }
        }
    });

    it('varies the most-heard sound the most', () => {
        for (const name of ALL) {
            if (name === 'deal') continue;
            expect(soundSpec('deal').jitter.pitchRatio, name).toBeGreaterThanOrEqual(soundSpec(name).jitter.pitchRatio);
        }
    });

    it('barely detunes the tuned sounds, because an out-of-tune reward reads as a bug', () => {
        for (const name of ['token-award', 'victory', 'your-turn'] as const) {
            expect(soundSpec(name).jitter.pitchRatio, name).toBeLessThanOrEqual(0.01);
        }
    });
});

describe('varySpec', () => {
    const mid = () => 0.5;
    const low = () => 0;
    const high = () => 1;

    it('changes nothing at the centre of the range', () => {
        for (const name of ALL) {
            expect(varySpec(soundSpec(name), mid), name).toEqual(soundSpec(name));
        }
    });

    it('bounds the swing by the declared ratio, at both ends', () => {
        const spec = soundSpec('deal');
        const { pitchRatio, durationRatio, gainRatio } = spec.jitter;

        expect(varySpec(spec, low).gain).toBeCloseTo(spec.gain * (1 - gainRatio), 10);
        expect(varySpec(spec, high).gain).toBeCloseTo(spec.gain * (1 + gainRatio), 10);
        expect(varySpec(spec, low).durationMs).toBeCloseTo(spec.durationMs * (1 - durationRatio), 10);

        const cutoff = (s: SoundSpec) => s.voices[0].filter!.cutoffHz;
        expect(cutoff(varySpec(spec, high))).toBeCloseTo(cutoff(spec) * (1 + pitchRatio), 10);
    });

    it('moves a noise voice, which has no frequency of its own, through its filter', () => {
        // Without this the swish would be the one sound that never varied.
        const varied = varySpec(soundSpec('deal'), low);
        expect(varied.voices[0].filter!.cutoffHz).toBeLessThan(soundSpec('deal').voices[0].filter!.cutoffHz);
        expect(varied.voices[0].filter!.sweepToHz!).toBeLessThan(soundSpec('deal').voices[0].filter!.sweepToHz!);
    });

    it('transposes a chord without detuning it', () => {
        const spec = soundSpec('token-award');
        const before = frequencies(spec);
        const after = frequencies(varySpec(spec, high));

        expect(after.length).toBe(before.length);
        expect(after[1] / after[0]).toBeCloseTo(before[1] / before[0], 10);
        expect(after[2] / after[0]).toBeCloseTo(before[2] / before[0], 10);
    });

    it("keeps the Mule's semitone a semitone, since the beating is the effect", () => {
        const before = frequencies(soundSpec('mule'));
        const after = frequencies(varySpec(soundSpec('mule'), low));
        expect(after[2] / after[1]).toBeCloseTo(before[2] / before[1], 10);
    });

    it('leaves the designed mix alone, scaling only the master gain', () => {
        for (const name of ALL) {
            const spec = soundSpec(name);
            expect(varySpec(spec, high).voices.map(v => v.gain), name).toEqual(spec.voices.map(v => v.gain));
        }
    });

    it('leaves sustain alone, which is a level and not a time', () => {
        for (const name of ALL) {
            const spec = soundSpec(name);
            expect(
                varySpec(spec, low).voices.map(v => v.envelope.sustain),
                name
            ).toEqual(spec.voices.map(v => v.envelope.sustain));
        }
    });

    it('never produces a duration or a frequency a graph cannot play', () => {
        for (const name of ALL) {
            for (const random of [low, high, mid, () => 0.13, () => 0.87]) {
                const varied = varySpec(soundSpec(name), random);
                expect(varied.durationMs, name).toBeGreaterThan(0);
                expect(varied.gain, name).toBeGreaterThan(0);
                for (const voice of varied.voices) {
                    expect(voice.durationMs, name).toBeGreaterThan(0);
                    expect(envelopeMs(voice), name).toBeLessThanOrEqual(voice.durationMs + 1e-9);
                    expect(voiceEndMs(voice), name).toBeLessThanOrEqual(varied.durationMs + 1e-9);
                    if (voice.source.kind === 'tone') expect(voice.source.frequencyHz, name).toBeGreaterThan(0);
                    if (voice.filter) expect(voice.filter.cutoffHz, name).toBeGreaterThan(0);
                }
            }
        }
    });

    it('clamps a random source that does not honour [0, 1)', () => {
        const spec = soundSpec('deal');
        expect(varySpec(spec, () => 5)).toEqual(varySpec(spec, high));
        expect(varySpec(spec, () => -3)).toEqual(varySpec(spec, low));
    });
});

describe('soundForEvent', () => {
    it('answers every kind of presentation event without throwing', () => {
        for (const event of EVERY_EVENT) {
            const name = soundForEvent(event);
            expect(name === null || ALL.includes(name), event.kind).toBe(true);
        }
    });

    it('answers every kind of log entry', () => {
        for (const entry of EVERY_LOG_ENTRY) {
            const name = soundForEvent({ kind: 'log', entry });
            expect(name === null || ALL.includes(name), entry.kind).toBe(true);
        }
    });

    it('swishes a card out of the deck and taps one onto the table', () => {
        expect(soundForEvent({ kind: 'card-drawn', seatId: 'p1', cardTypeId: 'mule' })).toBe('deal');
        expect(soundForEvent({ kind: 'card-drawn', seatId: 'p2' })).toBe('deal');
        expect(soundForEvent({ kind: 'log', entry: { kind: 'PLAY', turn: 1, actorId: 'p1', cardId: 'informant' } })).toBe('play');
    });

    it('snaps on learning something', () => {
        expect(soundForEvent({ kind: 'peek-gained', subjectId: 'p2', cardTypeId: 'mule' })).toBe('reveal');
    });

    it.each(['guard', 'baron'] as const)('darkens on an elimination caused by %s', cause => {
        expect(soundForEvent({ kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause } })).toBe('elimination');
    });

    it.each(['mule-voluntary', 'mule-forced'] as const)('gives the Mule its own sound when %s', cause => {
        expect(soundForEvent({ kind: 'log', entry: { kind: 'ELIMINATED', turn: 1, playerId: 'p2', cause } })).toBe('mule');
    });

    it('chimes a devotion token and rolls a chord on the match', () => {
        expect(soundForEvent({ kind: 'round-over', result: { reason: 'deck-out', winnerIds: ['p1'] } })).toBe('token-award');
        expect(soundForEvent({ kind: 'match-over', winnerId: 'p1' })).toBe('victory');
    });

    it('stays silent for everything whose consequence speaks for it', () => {
        // A table where every log line makes a noise is a table with no sound
        // that means anything.
        expect(soundForEvent({ kind: 'peek-lost', subjectId: 'p2' })).toBeNull();
        for (const entry of EVERY_LOG_ENTRY) {
            if (entry.kind === 'PLAY' || entry.kind === 'ELIMINATED') continue;
            expect(soundForEvent({ kind: 'log', entry }), entry.kind).toBeNull();
        }
    });

    it('returns a name this file knows how to synthesise', () => {
        for (const event of [...EVERY_EVENT, ...EVERY_LOG_ENTRY.map(entry => ({ kind: 'log', entry }) as const)]) {
            const name = soundForEvent(event);
            if (name !== null) expect(soundSpec(name).voices.length, name).toBeGreaterThan(0);
        }
    });

    it('leaves no sound in the palette that nothing can ever select', () => {
        // The shimmer and the burst were both fully implemented and both
        // unreachable in `motion.ts` for exactly this reason. Silence is even
        // harder to notice than a missing animation.
        const selectable = new Set<SoundName>();
        for (const event of [...EVERY_EVENT, ...EVERY_LOG_ENTRY.map(entry => ({ kind: 'log', entry }) as const)]) {
            const name = soundForEvent(event);
            if (name !== null) selectable.add(name);
        }
        selectable.add(soundForNotice('RATE_LIMITED'));
        const cued = soundForTurnStart(makeView({ currentPlayerId: 'p2' }), makeView());
        if (cued !== null) selectable.add(cued);

        for (const name of ALL) {
            expect(selectable.has(name), `${name} is synthesised but unreachable`).toBe(true);
        }
    });
});

describe('soundForNotice', () => {
    it('answers every error code with the refusal', () => {
        for (const code of EVERY_ERROR_CODE) {
            expect(soundForNotice(code), code).toBe('refused');
        }
    });
});

describe('soundForTurnStart', () => {
    const theirs = makeView({ currentPlayerId: 'p2' });
    const yours = makeView({ currentPlayerId: 'p1' });

    it('cues when the turn passes to you', () => {
        expect(soundForTurnStart(theirs, yours)).toBe('your-turn');
    });

    it('stays quiet while it is still your turn', () => {
        expect(soundForTurnStart(yours, yours)).toBeNull();
    });

    it('stays quiet when the turn passes to someone else', () => {
        expect(soundForTurnStart(yours, theirs)).toBeNull();
    });

    it('stays quiet on first load and on reconnect', () => {
        // `diffSnapshots` makes the same choice for the same reason: a player
        // who was away should see the table as it stands, not be chimed at.
        expect(soundForTurnStart(null, yours)).toBeNull();
    });

    it('stays quiet during the round-over reveal, when the turn cannot be taken', () => {
        const revealing = makeView({ currentPlayerId: 'p1', roundResult: { reason: 'deck-out', winnerIds: ['p1'] } });
        expect(soundForTurnStart(theirs, revealing)).toBeNull();
    });

    it('stays quiet once the match is over', () => {
        expect(soundForTurnStart(theirs, makeView({ currentPlayerId: 'p1', matchWinnerId: 'p1' }))).toBeNull();
    });

    it('cues again when a new round deals to the seat that was already current', () => {
        // The boundary case: `currentPlayerId` never changes across it, so a
        // plain transition test goes silent exactly when the player most needs
        // telling.
        const ended = makeView({ currentPlayerId: 'p1', roundResult: { reason: 'deck-out', winnerIds: ['p2'] } });
        expect(soundForTurnStart(ended, yours)).toBe('your-turn');
    });

    it('stays quiet for a seat that is out of the round', () => {
        const dead = makeView({
            currentPlayerId: 'p1',
            players: [{ ...makeView().players[0], alive: false }, makeView().players[1]]
        });
        expect(soundForTurnStart(theirs, dead)).toBeNull();
    });
});
