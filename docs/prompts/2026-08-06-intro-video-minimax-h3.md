# Intro video — MiniMax H3 (text-to-video)

Prompts for the game's opening title sequence, written for **MiniMax H3** text-to-video
through ComfyUI. Kept here for the same reason `PORTRAIT_PROMPTS.md` and `SFX_PROMPTS.md`
sit beside it: so a result can be reproduced, and so the next attempt starts from the last
one rather than from nothing.

**Written:** 2026-08-06. **Not yet generated** — no take from either prompt has been run.

## What these are built from

Both prompts are derived from the project rather than invented beside it:

- **The premise is the shot.** `README.md` opens with it — "every player believes they act
  independently, but all have been emotionally converted." That is a visual idea, not a
  mechanical one: four people deciding freely, then one reveal that the decision was never
  theirs. Both storyboards end on that reveal. An intro that merely shows cards being
  played sells a card game; this sells *this* card game.
- **The palette is fixed and quoted literally.** Black `#000000`, nebula red `#ef4444`,
  nebula purple `#a855f7` — the base palette in `VISUAL_SHOWCASE.md`, held as integers in
  `src/client/tokens/tokens.ts` and mirrored in `src/client/styles/tokens.css`. Naming the
  hex values is what makes the intro cut against the live playfield instead of near it.
- **The art register is a real fork.** `PORTRAIT_PROMPTS.md` puts `photorealistic` in the
  *negative* prompt of every character portrait, so the deck is painted, not photographic.
  Prompt A ignores that deliberately and shoots live-action; prompt B matches the deck.
  Both are defensible and they are different films.

## Prompt A — live-action cinematic

The register the supplied ComfyUI example prompt already proved out. Photographic, patient,
dread rather than action.

```
Realistic live-action cinematic look, science-fiction title sequence: practical film photography style, anamorphic lens, shallow depth of field, fine film grain, deep black interior lit only by a low round table and a distant nebula through a tall window, restrained grading — near-black blacks, one deep violet key (#a855f7) and one dull ember red (#ef4444), nothing else colored, volumetric haze, slow deliberate camera, retro-futurist production design: brushed metal, heavy fabric, no screens, no visible technology.

Scene overview: a windowless court chamber in a decaying galactic empire. Four figures in dark high-collared coats sit evenly spaced around a low circular table, faces half in shadow, playing a card game in silence. Each believes they are choosing freely. Above and behind them, unseen by any of them, a thin motionless silhouette watches from a raised chair. This is the cold open of a psychological science-fiction thriller — not action, dread: still, composed, and building to one reveal.

Storyboard (each shot a separate scene, hard cuts, timed to a slow rising drone):
[0s-1.2s] Shot 1: extreme close-up, macro: a plain dark card slides face-down across black lacquer, violet light raking across its surface, a gloved hand withdrawing. Very shallow focus.
[1.2s-2.4s] Shot 2: slow low dolly-in at table height: four seated silhouettes around the round table, ember light glowing up into their jaws from below, faces still unreadable, haze between the camera and them.
[2.4s-3.6s] Shot 3: close-up on one player's face as they decide — eyes lowered to their two cards, a long breath, absolute stillness, the certainty of someone making up their own mind.
[3.6s-4.8s] Shot 4: the camera lifts and cranes back over the table to reveal a raised chair in the dark behind them, a gaunt narrow-shouldered silhouette seated in it, motionless, never turning.
[4.8s-6s] Shot 5: cut back, wide and symmetrical: all four players raise their heads in perfect unison and look into camera, and the same violet light catches every pair of eyes at the same instant. Hold on the freeze.

Camera: each shot its own angle, cuts clean and hard, no dissolves. Shots 1-3 locked or barely moving; shot 4 the only crane; shot 5 dead symmetrical and still. Slow, heavy, patient — no handheld shake.

Audio: room tone and a low sub-bass drone underneath, a single card sliding, one distant metallic bell at 2.4s, the drone swelling and thinning out at 3.6s into near-silence, one deep hit landing exactly on the unison look at 4.8s, silence to the end.

No text, subtitles, titles, logos, watermarks or user interface of any kind, no legible symbols or numbers on the cards, no animation or cartoon rendering, no overly-CG look, no modern clothing, no smiling, no bright or saturated colors outside the violet and ember, no crowd, keep the live-action texture.
```

## Prompt B — painted, matching the card art

Use this if the intro should look like the deck. Everything the portraits already are is in
here: `retro futurism`, obscured faces, dark atmospheric lighting, and the deliberate
absence of photorealism.

```
Painted science-fiction concept-art look in motion, Isaac Asimov Foundation aesthetic, retro-futurism: illustrated rather than photographic, visible brushwork and canvas grain, dark atmospheric lighting, deep purple and red nebula palette (#a855f7, #ef4444) over black, distant stars, gold-leaf and dull bronze accents, chiaroscuro — most of every frame in shadow, slow stately camera moves across painted planes with parallax depth.

Scene overview: a throne chamber adrift in a purple and red nebula. Four hooded and high-collared figures sit around a circular table of dark stone, cards face-down before them, faces obscured or turned away. Above them hangs a medallion of an all-seeing eye in red and purple. The sequence moves from the small human choice to the vast thing that made it — a card, a hand, a court, an eye.

Storyboard (each shot a separate scene, hard cuts, one slow beat each):
[0s-1.2s] Shot 1: macro on a painted card back — an ornate dark sigil in deep purple — as a hand in a heavy sleeve slides it forward, starfield reflected in the stone table.
[1.2s-2.4s] Shot 2: slow push-in on the round table from above, four hooded figures evenly spaced, cards glowing faintly, long shadows thrown outward.
[2.4s-3.6s] Shot 3: a card turns face-up: a painted portrait of a stern uniformed officer in indigo and blue, eyes forward, expression fixed. Light rakes across the paint.
[3.6s-4.8s] Shot 4: the camera cranes up off the table toward a red and purple medallion above — an all-seeing eye — which slowly opens, its iris a nebula.
[4.8s-6s] Shot 5: reverse: seen from behind the eye, looking down on the four figures, all four lift their heads at once. Hold.

Camera: slow push, slow crane, one reveal, no whip pans, no dissolves, gentle parallax between painted layers.

Audio: low nebula drone, one soft card placement, a swelling choral pad from 3.6s, a single deep resonant strike on the eye opening at 4.8s, decaying to silence.

No text, subtitles, titles, logos or watermarks, no legible numbers or symbols on the cards, no photorealism, no modern clothing, no bright cheerful colors, no clutter, no visible user interface.
```

Prompt B's shot 4 is the one asset both halves of the project already own: the devotion
token is *an all-seeing eye in a red and purple medallion*
(`public/assets/misc/devotion_token.png`), earned one per round won. Opening the intro's eye
and awarding a token are the same image, which is worth protecting in any revision.

## Using them

**Leave the title out of the generation.** MiniMax garbles lettering, and the closing freeze
in shot 5 is deliberately a clean symmetrical plate. Composite **THE MULE'S COURT** on
afterward in Exo 2 — the display face is already self-hosted in
`src/client/styles/fonts.css` — so the typography matches the game exactly rather than
merely being accepted from the model.

**If the model yields 5 seconds rather than 6,** cut shot 3 and stretch the crane:
`[0-1.2] [1.2-2.6] [2.6-3.8] [3.8-5]`. Shot 3 is the most expendable; the unison look at the
end does the same work with more force.

**Knobs worth turning between takes, one at a time:**

| Knob | Alternative | Cost |
| --- | --- | --- |
| Player count | Two figures facing each other instead of four | More intimate, and less for the model to hold together — but four is the game's fullest table |
| The silhouette (A, shot 4) | "gaunt, narrow-shouldered, long-nosed, in a jester's motley under a heavy coat" | Closer to Asimov's Mule and to `magnifico/`; risks reading as comic |
| The unison beat | One face, plus "behind them three more pairs of eyes open in the dark at the same instant" | Fallback if the model animates four heads out of sync |

## Scope note

Both prompts sell the **premise**, not the **rules** — no gameplay, no targeting, no
deduction, no interface. An intro that sells gameplay is a different piece with a different
structure, and would want its own file here rather than an edit to this one.
