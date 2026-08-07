# Card flip — MiniMax H3 (reference-to-video)

A prompt for the `reference_to_video_minimax_h3_r2v` ComfyUI workflow, which runs the
`MiniMaxH3ReferenceToVideo` node. Filed here for the same reason as
`2026-08-06-intro-video-minimax-h3.md`: so a take can be reproduced, and so the next
attempt starts from the last one.

**Written:** 2026-08-06. **Not yet generated.**

## Wiring

The workflow tags references **in the order they were connected**, so the two `LoadImage`
nodes are not interchangeable:

| Workflow node | File | Tag in the prompt |
| --- | --- | --- |
| `LoadImage` **137** → `ref_images.ref_image_0` | `public/assets/card-back/card_back_2.png` | `<Picture 1>` |
| `LoadImage` **139** → `ref_images.ref_image_1` | `art/card-front/card_front_3.png` | `<Picture 2>` |

Prompt text goes in node **138** (`Input Text (Prompt)`), which feeds `136.prompt`.
Setting `136.prompt` directly is refused — the graph drives it from 138.

## Settings that matter for this shot

| Node | Set to | Why |
| --- | --- | --- |
| `136.ref_image_size` | **`max`** (default `match`) | The whole job is reproducing two pieces of existing ornament. `max` keeps a 2048px short edge so the filigree survives; `match` downscales the references to output resolution and the gold turns to mush. Costs speed — reference tokens ride every sampling step. |
| `124.scheduler` | **`beta`** or `normal` (default `simple`) | The workflow's own note says `simple` underperforms on reference-heavy prompts, and this is one. |
| `132` duration | **5** (the default) | The beat below is written to 5s. `131` rounds it to a legal frame count. |
| `115.megapixels` | `0.4` → 864×480 for drafts, `0.98` → 1344×768 for a keeper | Two card designs at 864×480 is enough to judge the *motion*; judge the *ornament* at the higher setting. |

## The prompt

```
Use <Picture 1> as the card's face-down back and <Picture 2> as the card's front frame. Reproduce both designs exactly — the same gold filigree, the same proportions, the same ornament, the same corner rays. <Picture 2> is supplied as a flat template on a plain grey backing: use only its black-and-gold frame, never its grey background, and fill its two blank white panels as described below.

Style: painted science-fiction concept art in motion, Isaac Asimov Foundation retro-futurism. One ornate playing card on black lacquer in a dark chamber. Near-black throughout, gold leaf, deep nebula purple (#a855f7) and one dull ember red (#ef4444) — no other colour. Low raking light, volumetric haze, fine dust drifting in the beam, chiaroscuro: the card is the only lit thing in the frame. Macro lens, shallow depth of field, slow and deliberate.

[0.0s-1.5s] The card from <Picture 1> lies face-down and dead centre on black lacquer, its gold filigree and purple orbs catching a slow rake of violet light. The camera pushes in by a hand's width. Dust drifts across the beam.
[1.5s-2.2s] A gloved hand in a heavy dark sleeve enters from the lower right, sets two fingers on the card's edge, and lifts it.
[2.2s-3.2s] The card turns over in the air, once, filling the frame — its thin gold edge flaring white as it passes through the light, the back's ornament sweeping away out of view.
[3.2s-4.2s] It lands face-up: the black lacquer frame of <Picture 2>, gold art-deco corner rays exactly as shown. Its upper window now holds a painted portrait — a gaunt, narrow-shouldered man with a long nose and sunken eyes, half in shadow, staring straight out. Its lower panel holds a plain gold flourish and nothing else.
[4.2s-5.0s] The camera holds still on the landed card. The light rakes once more across the gold, the portrait's eyes catch the violet, and everything settles.

Camera: one slow push, one flip, then locked off. No handheld shake, no whip pans, no dissolves.

Audio: room tone under a low sub-bass drone; the dry scrape of card stock lifting off lacquer at 1.5s; a soft rush of air through the turn; one clean slap as it lands at 3.2s with a single deep resonant bell struck underneath it; the drone thinning to near-silence by the end.

Add no text, letters, numbers, titles, logos, watermarks or user interface anywhere in the frame — the lettering at the centre of <Picture 1> is ornament, so reproduce it as an unreadable gold flourish and do not spell out or invent any words. No grey background, no tabletop clutter, no second card, no hand visible after 2.2s, no face on the card back, no photorealism, no bright or saturated colour outside the gold, violet and ember, no cartoon or 3D-render look, no smiling.
```

## Two things this prompt is defending against

**The grey backing.** `card_front_3.png` is a template photographed against flat grey. A
reference model will happily import that grey as the scene's background — which is why the
grey is named and refused twice, once in the opening instruction and once in the negatives.

**The blank panels.** The same file's portrait window and text panel are pure white
placeholders. Left undescribed, they render as white. The portrait fills the window with the
Mule as the repo already describes him elsewhere — gaunt, narrow-shouldered, long-nosed —
and the lower panel gets a flourish rather than a caption, because MiniMax garbles lettering
and the deck's real card copy lives in `src/client/content/` anyway.

## Knobs worth turning between takes, one at a time

| Knob | Alternative | Cost |
| --- | --- | --- |
| The portrait | Any other character from the mapping table in `AGENTS.md` — "a stern uniformed officer in indigo, eyes forward" for Han Pritcher | Pritcher is the safer render; the Mule is the better image |
| The flip | Card slides face-down into frame, then a *second* hand turns it — a play, not a reveal | Two hands is more story and more for the model to hold together |
| The hold | End on the card's own gold catching a slow shimmer instead of the eyes | Loses the stare, which is the shot's only human moment |
| Duration | 8s at node `132`, adding a beat before the flip | More room to earn the turn; more chance of drift |
