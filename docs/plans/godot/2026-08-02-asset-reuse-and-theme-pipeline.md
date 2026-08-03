# Asset Reuse & Theme Pipeline — Implementation Plan

**Date:** 2026-08-02
**Status:** Plan. Stage 2 of `2026-08-02-godot-full-rewrite-master-plan.md`, run in parallel with Stage 0–1 (§7 of that document — it shares no code with the corpus or the RNG port).
**Scope:** Copy `public/assets/` into `godot/assets/` verbatim, wire the `.import` and `.gdignore` pipeline around it, port `src/client/content/portraits.ts` as the curation module, and generate a Godot `Theme` resource from the same integer palette `tokens.ts` defines. This document is deliberately short — "reuse image assets" (master plan §1) is a hard scope boundary, not a design problem.
For Claude: REQUIRED SUB-SKILL: use `superpowers:executing-plans` to execute this plan task-by-task.

---

## 1. The reuse plan

`public/assets/` is 7.3 MB, 11 character-slug directories plus three support directories, one PNG per leaf (shaders/ holds three). It is copied into `godot/assets/` **byte-for-byte, unmodified** — no recompression, no resizing, no format conversion. The only new files this stage adds are Godot's own `.import` sidecars (§3) and one `.gdignore` (§4).

```
godot/assets/
├── informant/portrait_0.png        (310K)  — value 1
├── han-pritcher/portrait_0.png                — value 2
├── bail-channis/portrait_0.png                — value 2
├── ebling-mis/portrait_0.png                  — value 3
├── magnifico/portrait_0.png                   — value 3
├── shielded-mind/portrait_0.png               — value 4
├── bayta-darell/portrait_0.png                — value 5
├── toran-darell/portrait_0.png                — value 5
├── mayor-indbur/portrait_0.png                — value 6
├── first-speaker/portrait_0.png               — value 7
├── mule/portrait_0.png              (299K) — value 8
├── card-back/card_back_2.png        (1.49M — largest single asset)
├── shaders/
│   ├── rainbow_gradient.png         (299K) — devotion-token shimmer
│   ├── sparkle_pattern.png          (273K) — victory burst
│   └── distortion_map.png           (230K) — unused on the DOM client; see §2
└── misc/
    ├── devotion_token.png           (350K)
    └── playfield_background_space.png (368K)
```

Every character directory follows the identical layout `assets/<slug>/portrait_0.png` — confirmed uniform across all 11 (research: A925047f6aa3a4145.md §A), so the port can glob rather than hand-list. The slug → card → value table (README, AGENTS.md, confirmed against the directory listing):

| Card | Asset dir | Value |
| --- | --- | --- |
| Informant | `informant/` | 1 |
| Han Pritcher | `han-pritcher/` | 2 |
| Bail Channis | `bail-channis/` | 2 |
| Ebling Mis | `ebling-mis/` | 3 |
| Magnifico Giganticus | `magnifico/` | 3 |
| Shielded Mind | `shielded-mind/` | 4 |
| Bayta Darell | `bayta-darell/` | 5 |
| Toran Darell | `toran-darell/` | 5 |
| Mayor Indbur | `mayor-indbur/` | 6 |
| The First Speaker | `first-speaker/` | 7 |
| The Mule | `mule/` | 8 |

The slug does **not** always match the display name — `magnifico/` for Magnifico Giganticus, `first-speaker/` for The First Speaker — so any code that resolves a path reads the slug from the catalog (`CARD_CATALOG[id].assetSlug` on the TS side; the GDScript engine's card catalog, doc 4, carries the same field) rather than deriving it from the display name or the id string.

**R1.1** The copy SHALL be a straight file copy (`cp -R public/assets godot/assets`, or the git-tracked equivalent), never a re-export through an image editor or a Godot re-save — a re-save changes bytes even at identical quality settings and would make `git diff` on `godot/assets/` meaningless for future audits.

**R1.2** `godot/assets/` SHALL NOT include `PORTRAIT_PROMPTS.md` or `VISUAL_SHOWCASE.md` — those describe the generation pipeline and are documentation, not shipped assets. Keep them at the repo root where they already are.

---

## 2. `distortion_map.png` — an open door, not a default

`shaders/distortion_map.png` is unused by design on the current DOM client. Three separate skills say so and say why: `svg-filters-and-gradients` and `animating-with-waapi` both record, as a **do-not-undo-this**, that the Mule's ripple is deliberately not a displacement filter — a DOM table grants no surface to warp, the alternatives were considered and rejected in writing, and this file has stayed on disk unused since.

That reasoning was scoped to a DOM table. It does not survive the rewrite unexamined. `2026-08-02-godot-client-ui.md` §6 designs the Mule beat around a `SubViewport` — and a `SubViewport` **is** a real rendered surface a `canvas_item` shader can sample and displace, which is exactly the capability the DOM table was rejected for lacking (research a315258f2d48ce88e.md §7, "general feasibility is verified": SubViewport-texture-as-shader-input is a standard, well-established Godot technique; the specific 2D worked recipe is plausible-but-not-verbatim-confirmed).

So: this rewrite **may** finally wire `distortion_map.png` into the Mule beat's SubViewport displacement, where the DOM client structurally could not. This is **gate 3** in the master plan (§11) — "does the Mule SubViewport displacement read as dread rather than as effect" — and it is an **art-direction option to be decided by building it and looking**, not a default this document mandates. Doc 7 §6 owns the decision; this document's only obligation is:

**R2.1** `distortion_map.png` SHALL be copied into `godot/assets/shaders/` along with its two siblings (§1) regardless of whether gate 3 chooses to use it — leaving it out of the copy would make the gate 3 spike start by re-copying a file, which is needless friction for a decision that should cost an afternoon, not a checkout.

**R2.2** If gate 3 rejects the displacement (the effect reads as "effect" rather than "dread"), `distortion_map.png` stays in the tree unused — exactly its status today — and the rejection is recorded in doc 7 §6, not silently reversed by deleting the file. An unused asset with a documented reason it exists is not clutter; a *second* silent yes/no with no record is how this kind of decision rots.

---

## 3. The `.import` pipeline

Every asset Godot's editor touches gets a sidecar `.import` file recording import settings and the resource's UID. Project convention — and this project's convention — is to **commit every `.import` file**, gitignoring only `.godot/` (the regenerable cache directory), so a fresh clone reuses import settings and UIDs rather than the importer silently reassigning them on next open [verified via github.com/godotengine/godot-docs issue #11875 and corroborating sources, research a6ab832128517f332.md §9].

**R3.1** `godot/.gitignore` SHALL ignore `.godot/` and nothing under `assets/` — no blanket `*.import` ignore. A blanket ignore is the mistake this rule exists to prevent: it looks harmless locally (the importer regenerates the file on open) and then produces spurious re-import diffs, or worse, a CI checkout that imports every asset fresh on first headless run and pays the cost every job.

**R3.2** PNG import mode SHALL be **Lossless**, not VRAM Compressed, for every file under `godot/assets/`. Godot's own documented default for 2D is Lossless; VRAM Compressed is Godot's own stated default for 3D and its docs say to **avoid it for 2D** — it artifacts, and does so worse at low resolution [verified via docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html, research a6ab832128517f332.md §9]. This project's art is entirely 2D character/UI illustration; using the 3D-oriented compressed mode here would be choosing the wrong default against the engine's own stated guidance, not a neutral choice.

Concretely, an `.import` sidecar for a portrait PNG under Lossless carries `compress/mode=0` (Lossless) rather than `compress/mode=2` (VRAM Compressed) in its `[params]` section — set this via the Import dock when first bringing the assets in, or by writing the sidecar directly if scripting the import (Task 2).

**R3.3** The `.import` sidecars SHALL be generated by actually opening the project in the Godot editor (or running the importer headless) against the copied assets — not hand-written. A hand-written sidecar risks a UID collision or a stale format version; the importer is the only thing that knows the current sidecar schema for 4.7.1.

### Task 1: Copy and import

**Step 1** — `cp -R public/assets godot/assets`.
**Step 2** — Open `godot/` in the Godot 4.7.1 editor once, or run `godot --headless --editor --path godot --quit` to force a full import pass. Confirm every PNG produced an `.import` sidecar with `compress/mode=0`.
**Step 3** — `git add godot/assets` — this SHALL include the `.png` files and their `.import` sidecars together in one commit, so the pair is never split across history.
**Step 4** — Commit: `feat(assets): reuse public/assets/ verbatim under godot/assets/, lossless import`.

---

## 4. `.gdignore` — the ported variants directory

`art/portraits/` (13 MB, tracked but never built) holds the three unshipped thematic variants per character — `portrait_1` (alien/evolved), `portrait_2` (ethnic-diverse), `portrait_3` (gender-diverse) — documented in `public/assets/PORTRAIT_PROMPTS.md`. On the Vite side this stays unshipped for free: Vite copies only `public/` verbatim, and `art/portraits/` sits outside that root.

Godot's importer has no equivalent "only this root ships" rule — it walks the whole project tree looking for importable files unless told otherwise. The direct analog of Vite's `public/`-only copy is an empty `.gdignore` file: dropping one into a directory tells Godot's importer to skip that directory entirely, and nothing under it becomes an import target [verified via github.com/godotengine/godot-docs issue #11875, research a6ab832128517f332.md §9].

**R4.1** The ported variants directory (`godot/art/portraits/`, mirroring `art/portraits/`) SHALL contain an empty `godot/art/portraits/.gdignore` before any variant PNG is copied into it — so the importer never touches the 13 MB of unshipped art, exactly as `public/`-only copying keeps it out of the Vite bundle today.

**R4.2** This is flagged, not silently trusted: `.gdignore` is **community-documented but working** — Godot's own docs have an open tracking issue (#11875) asking for it to be documented on the official Import-process page. It is real and functions as described, but has no first-party doc page to point to if it stops working in a future engine version [verified as an open documentation gap via the same issue thread, research a6ab832128517f332.md §9]. Treat a future upgrade that silently starts importing `art/portraits/` as a regression to check against this exact behavior, since there is no first-party contract guaranteeing it.

**R4.3** Whether `art/portraits/` itself ports (i.e., whether the unshipped variants are copied into `godot/art/portraits/` at all in v1.0, or left for a later curation pass) is not this document's call — it is orthogonal to shipping the game. If they are not copied yet, the `.gdignore` still SHALL exist (R4.1) so the directory is inert the moment any variant *is* added, rather than requiring someone to remember the ignore file at the same time as the first variant copy.

### Task 2: `.gdignore` and (optionally) the variant copy

**Step 1** — `mkdir -p godot/art/portraits && touch godot/art/portraits/.gdignore`.
**Step 2** — If copying the variants now: `cp -R art/portraits/* godot/art/portraits/`. Re-run the editor's import pass (Task 1 Step 2) and confirm **no** `.import` sidecars appear under `godot/art/portraits/` — that is the test that `.gdignore` worked.
**Step 3** — Commit: `chore(assets): .gdignore the unshipped portrait variants, mirroring public/-only copy`.

---

## 5. The portrait curation point

`src/client/content/portraits.ts` is the **single** place in the TS client that names a chosen variant (its own docstring says so: "This file is the only place in the client that names one, so a curation decision is a one-line edit here and nothing downstream has to be found and changed"). It exports:

- `PORTRAIT_CHOICE: Readonly<Record<CardTypeId, PortraitVariant>>` — every character currently mapped to `'portrait_0'`.
- `portraitPath(id): string` — `${CARD_CATALOG[id].assetSlug}/${PORTRAIT_CHOICE[id]}.png`, reading the slug from the catalog rather than the id (portraits.ts:47–49).
- `portraits.test.ts` enforces the two-sided guard this document must preserve: `PORTRAIT_CHOICE` names one of `portrait_0`..`portrait_3` for every catalog id (regex `^portrait_[0-3]$`), names no id the catalog doesn't have, resolves `magnifico`/`first-speaker` correctly (the non-matching-slug cases), and — critically — **every resolved path exists on disk** (`existsSync('public/assets/' + portraitPath(id))`), so a curation edit without the matching file move fails loudly rather than shipping a missing texture.

**R5.1** This ports as a single GDScript module, e.g. `godot/client/content/portraits.gd`, carrying the same two exports in GDScript's terms:

```gdscript
class_name Portraits

const PORTRAIT_CHOICE := {
    "informant": "portrait_0",
    "han-pritcher": "portrait_0",
    "bail-channis": "portrait_0",
    "ebling-mis": "portrait_0",
    "magnifico": "portrait_0",
    "shielded-mind": "portrait_0",
    "bayta-darell": "portrait_0",
    "toran-darell": "portrait_0",
    "mayor-indbur": "portrait_0",
    "first-speaker": "portrait_0",
    "mule": "portrait_0",
}

# card_catalog is the GDScript catalog from doc 4 — read the slug from it,
# never from the id string, for the same reason portraits.ts does: the slug
# is not always the display name (magnifico, first-speaker).
static func portrait_path(id: String, card_catalog: Dictionary) -> String:
    var slug: String = card_catalog[id]["asset_slug"]
    return "%s/%s.png" % [slug, PORTRAIT_CHOICE[id]]
```

**R5.2** Choosing a different variant means moving the file into `godot/assets/<slug>/` **and** editing `PORTRAIT_CHOICE` in this module — the identical two-sided obligation `portraits.test.ts` enforces today. The headless GDScript test suite (doc 9 §3) SHALL carry the same guard: every id maps to a `portrait_[0-3]` value, every id in the catalog is covered and no extra ids appear, the known non-matching-slug cases (`magnifico`, `first-speaker`) resolve correctly, and — the load-bearing assertion — every resolved path exists under `res://assets/`, checked via `FileAccess.file_exists("res://assets/" + portrait_path(id, catalog))`. Skipping the existence check is the one way to port this module and still ship a missing texture with a green suite; it is not optional.

**R5.3** `CARD_BACK_ASSET` (the chosen card stock, `card-back/card_back_2.png` — portraits.ts documents it as 768×1024, matching the 0.75 aspect ratio the layout gives every card, and the reason the square alternate wasn't chosen) ports as a sibling constant in the same module, with the same existence check.

---

## 6. The theme, generated from the token source

`src/client/tokens/tokens.ts` is the single palette both `styles/tokens.css` and every canvas draw call read from — a drift test keeps the two in sync today. The Godot port needs the same discipline in reverse: **one `.theme`/`.tres` resource, generated from the same integer values**, so the two clients (while both exist, and the one Godot client afterward) cannot drift in colour the way two independently-hand-authored stylesheets could.

The palette (`tokens.ts:6–27`), unchanged:

```
colorBg               0x000000
colorNebulaRed         0xef4444
colorNebulaPurple      0xa855f7
colorTextPrimary       0xf5f5f5

colorSeatCurrent       0xef4444
colorSeatOther         0x6b7280
colorSeatProtected     0x22d3ee
colorSeatEliminated    0x9ca3af
colorSeatDisconnected  0x6b7280

colorStateYourTurn     0xc084fc
colorStateWaiting      0x9ca3af
colorStateRoundOver    0x4ade80
colorStatePaused       0xfbbf24
colorStateMatchOver    0xfbbf24

colorDeckFull          0x9333ea
colorDeckLow           0xb45309
colorDeckEmpty         0x991b1b
```

**R6.1** The values above SHALL be transcribed exactly once, into a GDScript constants module (`godot/client/tokens/tokens.gd`), and every other GDScript reference to a palette colour — theme generation, the beats, any raw draw call — SHALL read from that module rather than repeating a literal `Color(...)`. This is the same rule `tokens.ts` enforces for the TS side, restated in the new language: one source, everything else derives.

**R6.2** A generated Godot `Theme` resource SHALL be built by a `@tool` script (e.g. `godot/tools/generate_theme.gd`, run from the editor or headless via `godot --headless --script`), not hand-assembled in the editor's Theme UI. Hand-editing a `.tres` in the inspector is exactly the drift risk this section exists to close — a designer nudges one swatch, and the theme and `tokens.gd` disagree with no test able to catch it until it's visibly wrong.

The generation shape, per Godot's documented `Theme` API — `Theme.new()`, then `set_color`/`set_font_size`/`set_stylebox` per `(theme_type, item_name)` pair, then `ResourceSaver.save()` [verified for the general pattern via docs.godotengine.org's theming/skinning tutorial, research a315258f2d48ce88e.md §4; individual method spellings corroborated but not re-fetched verbatim this session — treat as high-confidence, not directly re-quoted]:

```gdscript
@tool
extends EditorScript

const Tokens = preload("res://client/tokens/tokens.gd")

func _run() -> void:
    var theme := Theme.new()

    # Seat-state colours, one Label/StyleBox variation per named state —
    # doc 7 defines which Control types actually consume each of these;
    # this script only has to place the colour where doc 7 says to read it.
    theme.set_color("font_color", "SeatCurrentLabel", Tokens.color(Tokens.COLOR_SEAT_CURRENT))
    theme.set_color("font_color", "SeatOtherLabel", Tokens.color(Tokens.COLOR_SEAT_OTHER))
    theme.set_color("font_color", "SeatProtectedLabel", Tokens.color(Tokens.COLOR_SEAT_PROTECTED))
    theme.set_color("font_color", "SeatEliminatedLabel", Tokens.color(Tokens.COLOR_SEAT_ELIMINATED))
    theme.set_color("font_color", "SeatDisconnectedLabel", Tokens.color(Tokens.COLOR_SEAT_DISCONNECTED))

    theme.set_color("font_color", "StateYourTurnLabel", Tokens.color(Tokens.COLOR_STATE_YOUR_TURN))
    theme.set_color("font_color", "StateWaitingLabel", Tokens.color(Tokens.COLOR_STATE_WAITING))
    theme.set_color("font_color", "StateRoundOverLabel", Tokens.color(Tokens.COLOR_STATE_ROUND_OVER))
    theme.set_color("font_color", "StatePausedLabel", Tokens.color(Tokens.COLOR_STATE_PAUSED))
    theme.set_color("font_color", "StateMatchOverLabel", Tokens.color(Tokens.COLOR_STATE_MATCH_OVER))

    # Deck-depth colours as StyleBox fills rather than font colours — the deck
    # is a filled shape, not text.
    var deck_full := StyleBoxFlat.new()
    deck_full.bg_color = Tokens.color(Tokens.COLOR_DECK_FULL)
    theme.set_stylebox("panel", "DeckFullPanel", deck_full)
    # ... deck_low, deck_empty, same shape.

    theme.set_color("font_color", "Label", Tokens.color(Tokens.COLOR_TEXT_PRIMARY))
    theme.set_font_size("font_size", "Label", 16)  # placeholder — doc 7 owns real type scale

    var err := ResourceSaver.save(theme, "res://theme/generated.tres")
    assert(err == OK, "theme generation failed: %s" % err)
```

`Tokens.color(int)` is a one-line helper turning a packed `0xRRGGBB` integer into a `Color` — Godot's `Color` constructor from a hex string (`Color("#ef4444")`) or from floats both exist; using `hex()` (§8) to build the string keeps exactly one code path responsible for the integer-to-string step, mirroring how `tokens.ts`'s `hex()` is the one place that formats a colour for anything that wants a string.

**R6.3** The theme type names above (`SeatCurrentLabel`, `DeckFullPanel`, etc.) are placeholders for this document — doc 7 owns the actual scene tree and the real `theme_type_variation` names each Control uses (theming/skinning docs confirm `Control.theme_type_variation` is exactly the mechanism for "a subset of nodes picks a different visual profile from the same Theme resource," research a315258f2d48ce88e.md §4). This document's obligation is only that **whatever names doc 7 settles on, the generator script is the single place they are populated from `tokens.gd`** — never a literal `Color(0xef4444)` typed directly into a scene file or a second script.

**R6.4** `generated.tres` SHALL be committed (it is a build output in the sense that it's produced by a script, but it is also the runtime asset every scene loads — same logic as `embeddedAssets.generated.ts` on the TS side being committed despite being generated: a clone without it fails to theme anything). Regenerate it whenever `tokens.gd` changes; a stale `generated.tres` after a token edit is the direct GDScript analogue of the stale-embedded-manifest failure mode AGENTS.md documents for the TS build.

### Task 3: Generate the theme

**Step 1 — Write the failing test.** A headless GDScript test that loads `res://theme/generated.tres` and asserts a handful of known colours resolve to the token values, e.g. `theme.get_color("font_color", "SeatProtectedLabel") == Tokens.color(Tokens.COLOR_SEAT_PROTECTED)`.
**Step 2 — Run it, confirm it fails** (no `generated.tres` yet).
**Step 3 — Implement** `tokens.gd` (R6.1) and `generate_theme.gd` (R6.2), matching doc 7's real type-variation names once that document exists — until then, use the placeholders above and revisit when doc 7 lands.
**Step 4 — Run the generator, commit `generated.tres`, re-run the test, confirm it passes.**
**Step 5 — Commit:** `feat(theme): generate Theme resource from the shared token source`.

---

## 7. Contrast, asserted arithmetically

`src/client/tokens/contrast.ts` is pure WCAG 2.1 sRGB arithmetic — "Arithmetic rather than measured, because the accessibility gate runs under jsdom, which has no layout and therefore no computed colours. axe-core's colour-contrast rule is silently skipped there; this file is what covers it" (contrast.ts:1–7). It owes nothing to a renderer, which is exactly why it ports without adaptation:

```
channelLuminance(srgb):                      # srgb in [0,255]
    c = srgb / 255
    return c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4

relativeLuminance(hex):                      # hex = 0xRRGGBB
    r = channelLuminance((hex >> 16) & 0xFF)
    g = channelLuminance((hex >> 8) & 0xFF)
    b = channelLuminance(hex & 0xFF)
    return 0.2126*r + 0.7152*g + 0.0722*b

contrastRatio(a, b):
    la, lb = relativeLuminance(a), relativeLuminance(b)
    hi, lo = max(la,lb), min(la,lb)
    return (hi + 0.05) / (lo + 0.05)
```

**R7.1** This ports as `godot/client/tokens/contrast.gd`:

```gdscript
class_name Contrast

static func channel_luminance(srgb: int) -> float:
    var c := srgb / 255.0
    return c / 12.92 if c <= 0.04045 else pow((c + 0.055) / 1.055, 2.4)

static func relative_luminance(colour: int) -> float:
    var r := channel_luminance((colour >> 16) & 0xFF)
    var g := channel_luminance((colour >> 8) & 0xFF)
    var b := channel_luminance(colour & 0xFF)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

static func contrast_ratio(a: int, b: int) -> float:
    var la := relative_luminance(a)
    var lb := relative_luminance(b)
    var hi := max(la, lb)
    var lo := min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
```

This needs none of doc 2's 32-bit-wraparound care — every operation here is ordinary float math and a `>>`/`&` on values already known non-negative and small (at most 24 bits), never near the `int64` boundary that made the RNG port hazardous.

**R7.2** The headless suite SHALL assert real ratios from the actual palette, not just that the functions run — port `contrast.test.ts`'s cases: the pairs the DOM client actually uses as foreground/background (e.g. `colorTextPrimary` on `colorBg`, `colorStateYourTurn` on `colorBg`) meet WCAG AA (4.5:1 for normal text, 3:1 for large text/UI components) where the design claims they do. This is the substitute for axe's disabled `color-contrast` rule (§C of the research: jsdom has no layout, so axe skips it there too) — Godot's headless test runner has no rendered colour either (no display driver under `--headless`), so the arithmetic is not a stopgap here, it is the *only* mechanism available in both eras.

### Task 4: Port and assert contrast

**Step 1 — Write the failing test** — transcribe `contrast.test.ts`'s known-good vectors (a pure-math reference, e.g. black-on-white = 21:1, and the project's real foreground/background pairs) into `godot/test/tokens/test_contrast.gd`.
**Step 2 — Run it, confirm it fails.**
**Step 3 — Implement** `contrast.gd` per R7.1.
**Step 4 — Run it, confirm it passes.**
**Step 5 — Commit:** `feat(tokens): WCAG contrast arithmetic, the axe color-contrast substitute`.

---

## 8. `hex()`, zero-padded

`tokens.ts`'s `hex()` exists because `0x000000` formatted as `(0).toString(16)` is `'0'`, not `'000000'` — a two-character (or shorter) colour string that some parsers read as transparent black and others reject outright. The padding is not cosmetic; `colorBg` is exactly the value this bites (tokens.ts:36–41).

**R8.1** The GDScript port SHALL preserve the zero-pad:

```gdscript
static func hex(colour: int) -> String:
    return "#%06x" % colour
```

GDScript's `%06x` format specifier zero-pads to 6 hex digits by construction, so `hex(0x000000)` returns `"#000000"`, never `"#0"`. Add one test pinning exactly this case — `Contrast`/`Tokens`'s test suite is the wrong place for a formatting test, so this lives alongside `tokens.gd`'s own tests (Task 3's suite, or a small dedicated one) rather than folded into Task 4.

**R8.2** Any GDScript code that needs a colour as a string (theme generation, if it goes through `Color("#rrggbb")` rather than a direct float constructor; any debug output) SHALL call this function rather than reimplementing the format — same single-source-of-truth argument as R6.1, applied to formatting instead of the raw values.

---

## Definition of done for Stage 2

- `godot/assets/` exists, is byte-identical to `public/assets/` at copy time, and every PNG has a committed `.import` sidecar with `compress/mode=0` (Lossless).
- `godot/art/portraits/.gdignore` exists; if the variant art is copied in, a full editor import pass produces zero `.import` sidecars under that directory.
- `godot/client/content/portraits.gd` exists, matches `PORTRAIT_CHOICE`/`portraitPath` one-for-one, and its test suite fails if a chosen path does not resolve to a file on disk — the two-sided guard `portraits.test.ts` enforces today.
- `godot/client/tokens/tokens.gd` carries every value from `tokens.ts:6–27` verbatim; `godot/theme/generated.tres` is committed, produced only by `generate_theme.gd`, and a headless test confirms known theme-type/item pairs resolve to those token values.
- `godot/client/tokens/contrast.gd` ports `contrast.ts` exactly; a headless test asserts WCAG AA on the palette pairs the client actually uses, standing in for axe's disabled `color-contrast` rule.
- `hex()` zero-pads to 6 digits; a test pins `hex(0x000000) == "#000000"`.
- `distortion_map.png` is copied (R2.1) and its use in the Mule beat remains an open, explicitly-flagged decision for gate 3 (doc 7 §6) — not decided by this document.

This stage runs alongside Stage 0–1 and blocks nothing but itself; doc 7 (client scenes) is the first consumer of everything built here, per the master plan's stage table (§7, Stage 5/7 blocked by Stage 2's asset import and headless runner).
