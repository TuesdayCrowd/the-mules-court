/**
 * The cinematic beats (UIX §8), reimplemented on the Web Animations API.
 *
 * Replaces `src/game/scenes/beats.ts`. **What plays is decided elsewhere** —
 * `motionPlan` in `src/client/store/motion.ts` is pure, tested, and reused
 * here untouched: it owns the staging order, the durations, and the
 * reduced-motion collapse. This file only knows how to draw a step.
 *
 * **Beats own their own layer**, exactly as the Phaser version's header says:
 * `table.ts#draw()` rebuilds the table's DOM on every state update
 * (`planLayer.replaceChildren()`), so a beat animating a live table element
 * would have its target ripped out from under it mid-animation. Every element
 * created below is transient, appended to the `layer` this module is handed
 * (never the table's own DOM), and removed when its animation finishes.
 *
 * **`await element.animate(keyframes, options).finished` is the whole
 * mechanism.** No tween manager, no scene, no render loop to keep awake — a
 * WAAPI `Animation` runs on the compositor and resolves its own promise, so
 * `run()` below can `await` a step exactly the way `Court.playBeat` awaited a
 * Phaser tween. A step that throws is still swallowed by `run()`'s own
 * try/catch (mirroring `beats.ts:264-271`): the announcement this beat is
 * attached to describes something that already happened on the server, and a
 * broken animation must never be what stops that from surfacing.
 *
 * **No ambient globals.** `reducedMotion`, `viewport`, and `tableRoot` all
 * arrive through `BeatRunnerDeps`, read at play time rather than cached — the
 * same policy `store/motion.ts` documents for `matchMedia` and that every
 * other DOM surface in this client already follows for `window`.
 *
 * ---
 *
 * ## Why the Mule's `ripple` is not a literal port
 *
 * The Phaser original (`beats.ts:127-144`) warps the actual rendered table: a
 * `Displacement` filter on the main camera, because Phaser owns both the
 * table's content and its compositing surface. A DOM table grants no such
 * thing — there is no cheap way to rasterize live HTML into something a
 * filter can distort (`html2canvas` is slow, taints on cross-origin images,
 * and is a real new dependency; reimplementing the table's draw logic inside
 * a canvas just to have something of its own to distort would resurrect the
 * ~900 LOC of glue this rewrite is removing).
 *
 * `docs/plans/2026-07-30-renderer-architecture-research.md` §8 works through
 * this and lands on the substitute implemented below, in its own words: *"warp
 * the Mule's portrait — which is already an image — over a full-viewport wash
 * and a compositor-safe shudder on the table root."* That is deliberate, not
 * a shortfall — **do not "restore" a displacement/distortion filter here
 * thinking this was lost by accident.** `shaders/distortion_map.png` stays
 * unused by design; only `rainbow_gradient.png` (shimmer) and
 * `sparkle_pattern.png` (burst) are still loaded.
 *
 * The three parts, run concurrently:
 *
 * 1. **The Mule's own portrait shudders.** `ctx.portraitKey` is already
 *    resolved to the Mule's art for the whole `mule` sequence by the time
 *    `ripple` runs first (the caller assembles one `BeatContext` for the
 *    entire beat, same as `Court.ts`'s `beatContext()` does today) — so this
 *    is a transient image *this beat creates in its own layer*, warped with a
 *    small alternating translate/rotate/skew, never a reach into the live
 *    table DOM. Reaching into the table would repeat exactly the failure mode
 *    "beats own their own layer" exists to prevent.
 * 2. **A full-viewport wash** fades in and out under it.
 * 3. **The table root itself** (injected as `deps.tableRoot`, distinct from
 *    the transient beat `layer`) gets a small `translate3d` shudder.
 *
 * All three animate only `transform`/`opacity` — never a layout-affecting
 * property — so, same as the render-pump discipline `AGENTS.md` documents for
 * the Phaser table, this substitute never touches layout.
 */

import type { BeatName, MotionStep } from '../store/motion';
import { motionPlan } from '../store/motion';
import type { Rect } from '../layout/types';
import { FONT_DISPLAY, FONT_UI } from '../tokens/fonts';
import { hex, TOKENS } from '../tokens/tokens';

/** `/assets/…` is the loader root every asset reference in this client uses (see AGENTS.md). */
function assetUrl(pathUnderAssets: string): string {
    return `/assets/${pathUnderAssets}`;
}

const RAINBOW_SRC = assetUrl('shaders/rainbow_gradient.png');
const SPARKLE_SRC = assetUrl('shaders/sparkle_pattern.png');

export interface BeatContext {
    /** Where the beat happens — a seat chip or a card. Defaults to the viewport. */
    readonly rect?: Rect;
    /**
     * Card art for the beats that show a face.
     *
     * In the Phaser original this was a texture key looked up in a
     * `Preloader`-owned atlas; here it is a ready-to-use `<img src>` URL (an
     * `assetUrl(portraitPath(cardId))` built by whoever assembles the
     * context). The field keeps its name — deliberately — so the eventual
     * `main.ts` cutover (Stage 5) is a change to what value is passed, not to
     * this file's shape.
     */
    readonly portraitKey?: string;
    /** Words for the banner, and for the reveal's "only you see this". */
    readonly label?: string;
}

export interface BeatRunnerDeps {
    /**
     * Read at play time, never cached: a player can change the system setting
     * mid-session and the next beat has to obey it. Single source of truth,
     * shared with `ui.css`'s own `prefers-reduced-motion` media query — see
     * `store/motion.ts`'s own comment on this.
     */
    readonly reducedMotion: () => boolean;
    /** Live viewport, for beats with no `ctx.rect` (mirrors `table.ts`'s `TableDeps.viewport`). */
    readonly viewport: () => { readonly w: number; readonly h: number };
    /**
     * The actual table root (`table.ts#createTable`'s `container`) — distinct
     * from the transient `layer` this runner draws into. Only the mule
     * beat's `ripple` substitute uses it, for the compositor-safe shudder
     * described in this file's header. `null` is a legitimate answer before
     * the table has mounted; that part of the substitute is simply skipped.
     */
    readonly tableRoot: () => HTMLElement | null;
}

export interface BeatRunner {
    run(beat: BeatName, context?: BeatContext): Promise<void>;
    /**
     * Clears every transient element this runner has added to its `layer`.
     * Does not touch the table itself. Whatever is mid-flight is abandoned,
     * not cancelled — matching `Court.ts`'s `beats.destroy()`, which calls
     * `layer.removeAll(true)` rather than stopping in-flight tweens one by one.
     */
    destroy(): void;
}

// ------------------------------------------------------------ CSS easing
//
// Phaser eases approximated as WAAPI easing strings. Where the render spec
// this file was built from gives an exact `cubic-bezier`, that value is used
// verbatim; `Sine.easeInOut` has no single canonical bezier quoted anywhere
// in this project's docs, so it keeps the native `ease-in-out` keyword rather
// than inventing precision nothing asked for.

const EASE_SINE_OUT = 'cubic-bezier(0.39, 0.575, 0.565, 1)';
const EASE_SINE_INOUT = 'ease-in-out';
const EASE_BACK_OUT = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const EASE_CUBIC_OUT = 'cubic-bezier(0.215, 0.61, 0.355, 1)';
const EASE_LINEAR = 'linear';

// ------------------------------------------------------------------ helpers

function px(n: number): string {
    return `${n}px`;
}

function centreOf(rect: Rect): { readonly x: number; readonly y: number } {
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** `Animation.finished` settles to the `Animation` itself in most engines; normalised to `void` so callers never care. */
function finished(animation: Animation): Promise<void> {
    return animation.finished.then(() => undefined);
}

/**
 * Waits for an `<img>` to actually have decoded pixels before its beat
 * animates it — interface rule 8: the accessible channel (the announcement
 * this beat is attached to) must never run ahead of the visible one. Setting
 * `.src` and starting a WAAPI animation in the same tick decouples the
 * animation's fixed duration from the fetch/decode, so on a cold cache — a
 * freshly eliminated opponent's card nobody has seen yet — the element could
 * be created, animated over a blank box, and removed before the browser ever
 * painted it.
 *
 * The rejection is swallowed on purpose: `decode()` rejects for a broken or
 * cross-origin image (and, in this project's own jsdom test environment,
 * simply does not exist at all — calling it throws synchronously, which this
 * `try` catches exactly the same way). A beat must degrade to "animated
 * without art," never abort the announcement it is attached to.
 */
async function decodeQuietly(img: HTMLImageElement): Promise<void> {
    try {
        await img.decode();
    } catch {
        // Broken/cross-origin image, or no `decode` support at all — proceed
        // and animate without having confirmed pixels.
    }
}

function baseEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.style.position = 'absolute';
    el.style.pointerEvents = 'none';
    return el;
}

/** A full-rect overlay — the shape every wash beat (`fade`, `desaturate`, the ripple's viewport wash) shares. */
function appendWash(layer: HTMLElement, rect: Rect, colour: number): HTMLDivElement {
    const el = baseEl('div');
    el.style.left = px(rect.x);
    el.style.top = px(rect.y);
    el.style.width = px(rect.w);
    el.style.height = px(rect.h);
    el.style.background = hex(colour);
    el.style.opacity = '0';
    layer.appendChild(el);
    return el;
}

/** Text centred on a point — `translate(-50%, -50%)` rather than a computed box, since its final width is unknown until laid out. */
function appendCentredText(
    layer: HTMLElement,
    at: { readonly x: number; readonly y: number },
    text: string,
    font: string,
    sizePx: number,
    colour: string
): HTMLSpanElement {
    const el = baseEl('span');
    el.textContent = text;
    el.style.left = px(at.x);
    el.style.top = px(at.y);
    el.style.transform = 'translate(-50%, -50%)';
    el.style.fontFamily = font;
    el.style.fontSize = px(sizePx);
    el.style.color = colour;
    el.style.whiteSpace = 'nowrap';
    el.style.opacity = '0';
    layer.appendChild(el);
    return el;
}

/** An image centred on a point at its own natural size — the shape `loom`, `ripple`'s portrait, `reveal`, and `burst` all share. */
function appendCentredImage(layer: HTMLElement, at: { readonly x: number; readonly y: number }, src: string): HTMLImageElement {
    const el = baseEl('img');
    el.src = src;
    el.alt = '';
    el.style.left = px(at.x);
    el.style.top = px(at.y);
    layer.appendChild(el);
    return el;
}

// -------------------------------------------------------------------- beats

async function banner(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    const at = centreOf(ctx.rect ?? viewportRect());
    const text = appendCentredText(layer, at, ctx.label ?? '', FONT_DISPLAY, 28, hex(TOKENS.colorTextPrimary));

    await finished(
        text.animate([{ opacity: 0 }, { opacity: 1 }], { duration: step.durationMs, easing: EASE_SINE_OUT, fill: 'forwards' })
    );
    text.remove();
}

async function desaturate(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // A grey wash into the dimmed state `buildRenderPlan`/`table.ts` already
    // draw persistently. The transition is this beat's job; the resting look
    // belongs to the ordinary render, and neither has to know about the other.
    const rect = ctx.rect ?? viewportRect();
    const wash = appendWash(layer, rect, TOKENS.colorSeatEliminated);

    await finished(
        wash.animate([{ opacity: 0 }, { opacity: 0.55 }], { duration: step.durationMs, easing: EASE_SINE_INOUT, fill: 'forwards' })
    );
    wash.remove();
}

async function flip(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // The flip IS the information (UIX §8.2), so it lands last and biggest:
    // the card turns from edge-on to full width. Explicitly sized to 80% of
    // the target rect — unlike `loom`, this one has a rect to fit.
    if (ctx.portraitKey === undefined) return;

    const rect = ctx.rect ?? viewportRect();
    const w = rect.w * 0.8;
    const h = rect.h * 0.8;
    const at = centreOf(rect);

    const img = baseEl('img');
    img.src = ctx.portraitKey;
    img.alt = '';
    img.style.left = px(at.x - w / 2);
    img.style.top = px(at.y - h / 2);
    img.style.width = px(w);
    img.style.height = px(h);
    img.style.transformOrigin = 'center';
    layer.appendChild(img);

    // The flip IS the information — of every beat here, this is the one that
    // must never animate ahead of its own art (interface rule 8).
    await decodeQuietly(img);

    await finished(
        img.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
            duration: step.durationMs,
            easing: EASE_BACK_OUT,
            fill: 'forwards'
        })
    );
    img.remove();
}

/** See this file's header for why this is a substitute rather than a port. */
async function ripple(
    step: MotionStep,
    ctx: BeatContext,
    layer: HTMLElement,
    viewportRect: () => Rect,
    tableRoot: () => HTMLElement | null
): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    // (1) the Mule's own portrait shudders — a transient copy in this beat's
    // own layer, never the live table (see header: reaching into the table
    // would repeat the exact failure "beats own their own layer" prevents).
    if (ctx.portraitKey !== undefined) {
        const at = centreOf(ctx.rect ?? viewportRect());
        const portrait = appendCentredImage(layer, at, ctx.portraitKey);
        portrait.style.transform = 'translate(-50%, -50%)';

        tasks.push(
            (async () => {
                await decodeQuietly(portrait);
                await finished(
                    portrait.animate(
                        [
                            { transform: 'translate(-50%, -50%) rotate(0deg) skew(0deg)' },
                            { transform: 'translate(calc(-50% - 4px), -50%) rotate(-1.5deg) skew(-2deg)' },
                            { transform: 'translate(calc(-50% + 5px), calc(-50% + 3px)) rotate(1.5deg) skew(2deg)' },
                            { transform: 'translate(calc(-50% - 3px), calc(-50% - 2px)) rotate(-1deg) skew(-1deg)' },
                            { transform: 'translate(-50%, -50%) rotate(0deg) skew(0deg)' }
                        ],
                        { duration: step.durationMs, easing: EASE_SINE_INOUT }
                    )
                );
            })().finally(() => portrait.remove())
        );
    }

    // (2) a full-viewport wash — the tremor's colour, not its shape.
    const wash = appendWash(layer, viewportRect(), TOKENS.colorNebulaPurple);
    tasks.push(
        finished(
            wash.animate([{ opacity: 0 }, { opacity: 0.25 }, { opacity: 0 }], { duration: step.durationMs, easing: EASE_LINEAR })
        ).finally(() => wash.remove())
    );

    // (3) a compositor-safe shudder on the table root itself — transform
    // only, so it never touches layout.
    const root = tableRoot();
    if (root !== null) {
        tasks.push(
            finished(
                root.animate(
                    [
                        { transform: 'translate3d(0, 0, 0)' },
                        { transform: 'translate3d(-3px, 2px, 0)' },
                        { transform: 'translate3d(4px, -2px, 0)' },
                        { transform: 'translate3d(-2px, -1px, 0)' },
                        { transform: 'translate3d(0, 0, 0)' }
                    ],
                    { duration: step.durationMs, easing: EASE_SINE_INOUT }
                )
            )
        );
    }

    // `allSettled`, not `all`: a rejected task (a cancelled or failed
    // animation) must not make this beat abandon the other two mid-flight —
    // each task's own `.finally` above still has to run so every element this
    // beat created is removed, on every path, not just the happy one.
    await Promise.allSettled(tasks);
}

async function loom(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // The dread is the point. The Mule fills the table, then lets go. Unlike
    // `flip`, there is no rect to fit — the portrait renders at its own
    // natural size, same as the Phaser original left the texture unscaled by
    // `setDisplaySize`.
    if (ctx.portraitKey === undefined) return;

    const at = centreOf(viewportRect());
    const portrait = appendCentredImage(layer, at, ctx.portraitKey);
    portrait.style.opacity = '0';
    portrait.style.transform = 'translate(-50%, -50%) scale(0.6)';

    await decodeQuietly(portrait);

    const alphaIn = portrait.animate([{ opacity: 0 }, { opacity: 0.9 }], {
        duration: step.durationMs * 0.35,
        easing: EASE_SINE_INOUT,
        fill: 'forwards'
    });
    const scaleUp = portrait.animate(
        [{ transform: 'translate(-50%, -50%) scale(0.6)' }, { transform: 'translate(-50%, -50%) scale(1.15)' }],
        { duration: step.durationMs, easing: EASE_SINE_INOUT, fill: 'forwards' }
    );
    await Promise.all([finished(alphaIn), finished(scaleUp)]);

    await finished(
        portrait.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 200, easing: EASE_LINEAR, fill: 'forwards' })
    );
    portrait.remove();
}

async function reveal(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // A private peek (UIX §8.1). The words matter as much as the card: this
    // is the one moment the table shows something only one player may see —
    // whichever caller assembles `context` here must not broadcast it.
    if (ctx.portraitKey === undefined) return;

    const at = centreOf(viewportRect());

    const card = appendCentredImage(layer, { x: at.x, y: at.y - 40 }, ctx.portraitKey);
    card.style.transform = 'translate(-50%, -50%) scale(0.9)';
    card.style.opacity = '0';

    const caption = appendCentredText(
        layer,
        { x: at.x, y: at.y + 140 },
        ctx.label ?? 'Only you see this',
        FONT_UI,
        18,
        hex(TOKENS.colorSeatProtected)
    );

    await decodeQuietly(card);

    const els = [card, caption];
    await Promise.all(
        els.map(el =>
            finished(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: step.durationMs, easing: EASE_SINE_OUT, fill: 'forwards' }))
        )
    );
    await Promise.all(
        els.map(el =>
            finished(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: 900, easing: EASE_LINEAR, fill: 'forwards' }))
        )
    );

    card.remove();
    caption.remove();
}

async function shimmer(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // `rainbow_gradient.png`, assigned to the devotion-token award (UIX §8.5).
    // The real texture, not a reinvented CSS gradient — same asset the Phaser
    // original drew, so a future curation change to the art needs one edit.
    const rect = ctx.rect ?? viewportRect();
    const sheen = baseEl('img') as HTMLImageElement;
    sheen.src = RAINBOW_SRC;
    sheen.alt = '';
    sheen.style.left = px(rect.x);
    sheen.style.top = px(rect.y);
    sheen.style.width = px(rect.w);
    sheen.style.height = px(rect.h);
    sheen.style.objectFit = 'cover';
    sheen.style.opacity = '0';
    layer.appendChild(sheen);

    await decodeQuietly(sheen);

    await finished(
        sheen.animate([{ opacity: 0 }, { opacity: 0.7 }, { opacity: 0 }], { duration: step.durationMs, easing: EASE_LINEAR })
    );
    sheen.remove();
}

async function burst(step: MotionStep, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // `sparkle_pattern.png`, assigned to match victory (UIX §8.5).
    const at = centreOf(viewportRect());
    const sparkle = appendCentredImage(layer, at, SPARKLE_SRC);
    sparkle.style.opacity = '0.9';
    sparkle.style.transform = 'translate(-50%, -50%) scale(0.4)';

    await decodeQuietly(sparkle);

    await finished(
        sparkle.animate(
            [
                { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0.9 },
                { transform: 'translate(-50%, -50%) scale(2.2)', opacity: 0 }
            ],
            { duration: step.durationMs, easing: EASE_CUBIC_OUT, fill: 'forwards' }
        )
    );
    sparkle.remove();
}

async function fade(step: MotionStep, ctx: BeatContext, layer: HTMLElement, viewportRect: () => Rect): Promise<void> {
    // Every beat's reduced-motion form. Movement goes; the fact does not.
    const rect = ctx.rect ?? viewportRect();
    const wash = appendWash(layer, rect, TOKENS.colorNebulaPurple);

    await finished(
        wash.animate([{ opacity: 0 }, { opacity: 0.4 }, { opacity: 0 }], { duration: step.durationMs, easing: EASE_LINEAR })
    );
    wash.remove();
}

// ------------------------------------------------------------------- runner

export function createBeatRunner(layer: HTMLElement, deps: BeatRunnerDeps): BeatRunner {
    const viewportRect = (): Rect => {
        const { w, h } = deps.viewport();
        return { x: 0, y: 0, w, h };
    };

    async function runStep(step: MotionStep, ctx: BeatContext): Promise<void> {
        switch (step.kind) {
            case 'fade':
                return fade(step, ctx, layer, viewportRect);
            case 'banner':
                return banner(step, ctx, layer, viewportRect);
            case 'desaturate':
                return desaturate(step, ctx, layer, viewportRect);
            case 'flip':
                return flip(step, ctx, layer, viewportRect);
            case 'ripple':
                return ripple(step, ctx, layer, viewportRect, deps.tableRoot);
            case 'loom':
                return loom(step, ctx, layer, viewportRect);
            case 'reveal':
                return reveal(step, ctx, layer, viewportRect);
            case 'shimmer':
                return shimmer(step, ctx, layer, viewportRect);
            case 'burst':
                return burst(step, layer, viewportRect);
            // Information, not decoration — the countdown redraws itself
            // through the ordinary state-update path, not through a beat.
            case 'tick':
                return Promise.resolve();
            default: {
                const exhaustive: never = step.kind;
                return exhaustive;
            }
        }
    }

    return {
        async run(beat, context = {}) {
            const plan = motionPlan({ beat, reducedMotion: deps.reducedMotion() });

            for (const step of plan.steps) {
                try {
                    await runStep(step, context);
                } catch {
                    // A beat that throws must not wedge the presentation queue.
                    // The announcement still has to come out — the thing being
                    // described happened on the server whether or not it drew.
                }
            }
        },

        destroy() {
            layer.replaceChildren();
        }
    };
}
