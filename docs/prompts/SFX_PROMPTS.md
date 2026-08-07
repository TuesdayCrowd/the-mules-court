# Sound Effect Generation Prompts

Every ComfyUI prompt behind the audio in this directory, so the set is
reproducible. Companion to `PORTRAIT_PROMPTS.md`, which does the same job for
the portrait art.

## Where these fit

`src/client/store/sound.ts` already defines the game's nine cues as **synthesis
recipes** — oscillators, filters and envelopes built live in Web Audio, loading
nothing. These files do **not** replace that. They are an alternative sampled
voicing of the same nine cues, plus four ambience beds the synthesis layer
deliberately cannot produce.

Nothing in the client loads them yet: `ui/sound.ts` knows how to build an
oscillator graph and has no buffer-playing path. Wiring that up is a separate
change.

## Generation settings

| Setting | Value |
| --- | --- |
| Model | `stable_audio_3_medium.safetensors` |
| Text encoder | `t5gemma_b_b_ul2.safetensors` (type `stable_audio`) |
| Steps | 8 |
| CFG | 1 |
| Sampler / scheduler | `lcm` / `simple` |
| Denoise | 1.0 |
| Workflow | `audio_stable_audio_3_medium_flac` |

The workflow is a copy of `api_audio_stable_audio_3_medium.json` with its
deprecated `SaveAudioMP3` node swapped for `SaveAudioAdvanced` set to **flac**.
Two reasons that swap is load-bearing:

- **MP3 renders lie about their own level.** Decoding the MP3 versions of
  `deal` and `amb-vault` showed peaks *above* full scale with samples reading as
  clipped. The FLAC masters of the identical seeds peak at −1.93 and −1.28 dBFS
  with nothing clipped at all — the overshoot was a decode artefact, not the
  model. Mastering against it would have meant attenuating files that were fine.
- **One lossy generation instead of two.** The shipped MP3s are encoded once
  from the lossless master rather than re-encoded from a 320k render.

**The built-in Qwen prompt enhancer is switched off** (`52/35.value = false`),
so the prompts below reach the text encoder verbatim. The design intent in
`store/sound.ts` is already specified down to filter cutoffs and envelope times,
and paraphrasing it through a 2B model would blur exactly the detail worth
keeping.

> **Gotcha:** a **colon** anywhere in a prompt value breaks `comfy workflow
> set-slot` — it writes a corrupt temp workflow, which then surfaces as the
> unrelated-sounding error `workflow_not_found`. So none of the prompts below
> use the `Length: N seconds` convention; duration is set by `52/36.value`
> instead. Firing four runs concurrently also trips a race in the same CLI;
> submit at most three at a time.

## Post-processing

Raw renders are not shippable as they arrive, and `art/sfx/*.flac` holds them
untouched. Three passes produce what is in this directory:

1. **Trim.** Every render fills its requested duration with silence once the
   sound is over — `token-award` spent 1.8 of its 3 s doing nothing, the Mule
   bed 6.7 of 25. Leading silence is trimmed to 5 ms before the first transient,
   since 39 ms of dead air ahead of `deal` is 39 ms of latency between a card
   moving and a card sounding.
2. **Level.** The set arrived spanning 23 dB. Each cue is peak-normalised to
   `SoundSpec.gain / MAX_GAIN` taken straight from `src/client/store/sound.ts`,
   so the samples inherit the balance that file already argues for — `deal`
   quietest because it is heard most, `mule` loudest because that is the one
   place boldness is spent. Beds sit at −18 dBFS, well under every cue.
3. **Loop.** Each bed is crossfaded head-to-tail over 3 s, so it wraps without
   a seam. Cues are summed to mono; beds keep their stereo.

One corrective filter, on `deal` and `reveal` only: a 200 Hz and 300 Hz
high-pass. `deal` came back with 55% of its energy below 200 Hz while its spec
is a bandpass sweeping 1600 → 600 Hz — a card skimming felt has no low end.
`play` is deliberately **not** filtered, because its ~96 Hz thud is the card's
own weight and is in the design on purpose.

---

## Cues

Nine sounds matching the `SoundName` union in `src/client/store/sound.ts`.

### deal.mp3

The most-heard sound in the game — a card leaving the deck. Seed `200101`,
requested 2 s.

```
A single playing card sliding off the top of a deck and skimming across green felt. Close-up dry foley, no reverb, crisp papery friction with a soft downward whoosh, sharp attack and quick decay, recorded in a quiet still room.
```

### play.mp3

A card laid onto the table — rustle plus the card's own mass. Seed `200202`,
requested 2 s.

```
A playing card laid down flat onto a felt-topped card table. Close dry foley with no reverb, a soft papery rustle together with the small muffled low thud of the card's own weight settling, intimate and quiet, fast decay.
```

### reveal.mp3

A card turning face-up. This one carries information, so it is crisper and
higher than either of the above. Seed `200303`, requested 2 s.

```
A single stiff playing card snapped over face-up in one quick flick of the thumb. Bright crisp papery snap with a thin high transient, very fast attack, short dry decay, close-miked in a dead room with no reverb at all.
```

### your-turn.mp3

The quality-of-life cue — a player who looked away learns it is on them without
reading anything. A question, not a fanfare. Seed `200505`, requested 3 s.

```
A gentle two-note notification chime, two soft muted sine bell tones sounding one after the other and rising a perfect fifth apart, warm and dark with the bright harmonics filtered away, slow soft attack, short clean tail, calm and unhurried, quiet and never shrill.
```

### token-award.mp3

A devotion token awarded — the reward sound. Seed `200606`, requested 3 s.

```
A single small struck metal chime, like a tuned brass bell rod tapped once with a soft mallet. Clear bell-like fundamental with a quiet shimmering overtone above it, immediate strike then a long clean ringing decay that fades naturally to silence, warm and rewarding, recorded close in a small room with a little air around it.
```

### elimination.mp3

Dread, not a buzzer. The subject is a mind converted without its knowledge, so
this sinks rather than stings. Seed `200707`, requested 3 s.

```
A feeling of dread arriving rather than a hit. A deep sine sub-bass tone sliding slowly downward through an octave, with a dark low-pass filtered noise bed swelling in quietly behind it and sinking away. Slow soft fade-in with no transient and no impact, no percussion, cinematic and ominous, heavy and muffled as if heard through a wall.
```

### mule.mp3

The Mule turns face-up — the one place the boldness is spent, and by
construction the loudest and longest cue in the set. Seed `200808`, requested
4 s.

```
The sound of a mind being taken over without its knowledge. A dark science-fiction sound design swell built from three layers, a filtered noise ripple rising slowly upward in pitch, a vast sub-bass drone looming and sliding downward beneath it, and a pair of detuned low tones a semitone apart beating slowly against one another to create a wavering psychic interference. Slow menacing build, no impact and no percussion, deeply unsettling but never harsh or distorted.
```

### victory.mp3

The match is won. Rolled rather than struck, and deliberately still smaller than
the Mule. Seed `200909`, requested 4 s.

```
A warm major triad rolled gently on glass bells, the three notes arriving one shortly after another rather than struck together. Soft rounded bell tones with a long shared ringing tail, glowing and generous but restrained and quiet, no brass and no fanfare, recorded in a small warm room.
```

### refused.mp3

The action was refused — negative without being a punishment. Seed `200404`,
requested 2 s.

```
A soft low electronic refusal tone for a quiet user interface, one warm muted triangle-wave note bending downward a minor third, rounded and dark with the harsh upper harmonics filtered away, absolutely no buzzer and no distortion, gentle attack and short dry decay.
```

---

## Ambience beds

Long-form texture, seamlessly looping, at −18 dBFS. These have no counterpart in
`store/sound.ts` — synthesising a convincing room is exactly what the pure
oscillator vocabulary cannot do, which is why they are files.

### amb-table.mp3

Room tone for the table itself. Seed `300101`, requested 20 s.

```
Quiet interior room tone of a small windowless chamber deep inside a starship, the kind of room four people sit in to play cards. A very low steady ventilation hum far below hearing, faint air movement, a distant almost inaudible electrical drone, and nothing else. No music, no voices, no footsteps, no melody. Still, warm, private and unchanging, a background bed meant to loop unnoticed.
```

### amb-lobby.mp3

The pre-match lobby — calm and expectant. Seed `300303`, requested 20 s.

```
The waiting hall of a retro-futuristic galactic transit terminal, heard from a quiet corner. Soft wide air, a gentle warm electrical hum, faint distant unintelligible murmur far too low to make out words, occasional muted mechanical tick from somewhere far away, and a spacious reverberant emptiness. Calm and expectant, nobody nearby. No music and no melody.
```

### amb-mule-presence.mp3

Mentalic pressure — the sensation of another mind in the room. The beating pair
of detuned tones *is* the interference, the same trick the `mule` cue uses.
Seed `300202`, requested 25 s.

```
A dark ambient drone of psychic pressure, the sensation of another mind in the room bending your own. Two deep detuned tones a semitone apart beating slowly and endlessly against each other, a vast sub-bass floor beneath them, and faint metallic overtones drifting in and out of phase. Slow, patient, oppressive and inhuman. No rhythm, no percussion, no melody, no impact, never harsh or distorted.
```

The only render in the set with genuine clipping — 46 samples at full scale out
of ~2.2 million, or 0.002%, which the −18 dBFS bed level makes moot.

### amb-vault.mp3

The Second Foundation's hall — vast, reverent, and the widest stereo image in
the set (channel correlation 0.33). Seed `300404`, requested 20 s.

```
A vast empty stone chamber holding a long silence, the meeting hall of a hidden order of mentalists. Enormous slow reverberant space with a deep architectural resonance, a barely-there low drone that seems to come from the walls themselves, and a faint high shimmer at the edge of hearing like many minds held very still. Reverent, ancient and immense. No voices, no footsteps, no music and no melody.
```
