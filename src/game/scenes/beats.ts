/**
 * The cinematic beats (UIX §8).
 *
 * Each step returns a `Promise<void>` that resolves when it has finished
 * playing, which is what makes UIX §8.4's sequencing rule real rather than
 * aspirational: the presentation queue awaits the animation before it lets the
 * announcement out, so `aria-live` can never describe a result the table has not
 * shown yet.
 *
 * **What plays is decided elsewhere.** `motionPlan` in `src/client/store/motion.ts`
 * is pure and tested — it owns the staging order, the durations, and the
 * reduced-motion collapse. This file only knows how to draw a step.
 *
 * **Beats own their own layer.** `Court.draw()` clears and rebuilds the table on
 * every state update, so a beat animating a table object would have its target
 * destroyed mid-tween. Everything here is transient and lives in a container the
 * reconciler never touches.
 */

import { Scene } from 'phaser';
import type { MotionStep } from '../../client/store/motion';
import { motionPlan } from '../../client/store/motion';
import type { BeatName } from '../../client/store/motion';
import type { Rect } from '../../client/layout/types';
import { FONT_DISPLAY, FONT_UI } from '../../client/tokens/fonts';
import { TOKENS } from '../../client/tokens/tokens';
import { TEXTURES } from './Preloader';

export interface BeatContext {
    /** Where the beat happens — a seat chip or a card. Defaults to the viewport. */
    readonly rect?: Rect;
    /** Card art for the beats that show a face. */
    readonly portraitKey?: string;
    /** Words for the banner, and for the reveal's "only you see this". */
    readonly label?: string;
}

export interface BeatRunnerDeps {
    /**
     * Read at play time, never cached: a player can change the system setting
     * mid-session and the next beat has to obey it.
     *
     * Injected rather than read here so the policy has one source — `ui.css`
     * uses the same media query for its own transitions.
     */
    readonly reducedMotion: () => boolean;
}

export interface BeatRunner {
    run(beat: BeatName, context?: BeatContext): Promise<void>;
    destroy(): void;
}

/** Resolves when the tween finishes, whatever else happens to the scene. */
function tweenPromise(scene: Scene, config: Phaser.Types.Tweens.TweenBuilderConfig): Promise<void> {
    return new Promise(resolve => {
        scene.tweens.add({ ...config, onComplete: () => resolve() });
    });
}

export function createBeatRunner(scene: Scene, layer: Phaser.GameObjects.Container, deps: BeatRunnerDeps): BeatRunner {
    const viewport = (): Rect => {
        const { width, height } = scene.scale.gameSize;
        return { x: 0, y: 0, w: width, h: height };
    };

    /** Adds a transient object to the beat layer and removes it when the beat ends. */
    function transient<T extends Phaser.GameObjects.GameObject>(object: T): T {
        layer.add(object);
        return object;
    }

    function centreOf(rect: Rect) {
        return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    }

    async function banner(step: MotionStep, ctx: BeatContext): Promise<void> {
        const at = centreOf(ctx.rect ?? viewport());
        const text = transient(
            scene.add
                .text(at.x, at.y, ctx.label ?? '', {
                    fontFamily: FONT_DISPLAY,
                    fontSize: '28px',
                    color: '#f5f5f5'
                })
                .setOrigin(0.5)
                .setAlpha(0)
        );

        await tweenPromise(scene, { targets: text, alpha: 1, duration: step.durationMs, ease: 'Sine.easeOut' });
        text.destroy();
    }

    async function desaturate(step: MotionStep, ctx: BeatContext): Promise<void> {
        // A grey wash into the dimmed state the render plan already draws
        // persistently. The transition is this beat's job; the resting look is
        // `buildRenderPlan`'s, and neither has to know about the other.
        const rect = ctx.rect ?? viewport();
        const wash = transient(
            scene.add
                .rectangle(rect.x, rect.y, rect.w, rect.h, TOKENS.colorSeatEliminated, 1)
                .setOrigin(0, 0)
                .setAlpha(0)
        );

        await tweenPromise(scene, { targets: wash, alpha: 0.55, duration: step.durationMs, ease: 'Sine.easeInOut' });
        wash.destroy();
    }

    async function flip(step: MotionStep, ctx: BeatContext): Promise<void> {
        // The flip IS the information (UIX §8.2), so it lands last and biggest:
        // the card turns from edge-on to full width.
        const rect = ctx.rect ?? viewport();
        const at = centreOf(rect);
        if (ctx.portraitKey === undefined) return;

        const card = transient(
            scene.add.image(at.x, at.y, ctx.portraitKey).setDisplaySize(rect.w * 0.8, rect.h * 0.8)
        );
        const full = card.scaleX;
        card.scaleX = 0;

        await tweenPromise(scene, { targets: card, scaleX: full, duration: step.durationMs, ease: 'Back.easeOut' });
        card.destroy();
    }

    async function ripple(step: MotionStep): Promise<void> {
        // The Mule's table-wide displacement (UIX §8.5 assigns distortion_map
        // here and nowhere else). Phaser 4 Filters, not v3 FX — and the amounts
        // are very small floats, per the Displacement filter's own docs.
        const camera = scene.cameras.main;
        const filter = camera.filters.internal.addDisplacement(TEXTURES.distortion, 0, 0);

        await tweenPromise(scene, {
            targets: filter,
            x: 0.02,
            y: 0.02,
            duration: step.durationMs / 2,
            yoyo: true,
            ease: 'Sine.easeInOut'
        });

        camera.filters.internal.remove(filter);
    }

    async function loom(step: MotionStep, ctx: BeatContext): Promise<void> {
        // The dread is the point. The Mule fills the table, then lets go.
        const at = centreOf(viewport());
        if (ctx.portraitKey === undefined) return;

        const portrait = transient(
            scene.add.image(at.x, at.y, ctx.portraitKey).setAlpha(0).setScale(0.6)
        );

        await tweenPromise(scene, {
            targets: portrait,
            alpha: { value: 0.9, duration: step.durationMs * 0.35 },
            scale: 1.15,
            duration: step.durationMs,
            ease: 'Sine.easeInOut'
        });
        await tweenPromise(scene, { targets: portrait, alpha: 0, duration: 200 });
        portrait.destroy();
    }

    async function reveal(step: MotionStep, ctx: BeatContext): Promise<void> {
        // A private peek (UIX §8.1). The words matter as much as the card: this
        // is the one moment the table shows something only one player may see.
        const at = centreOf(viewport());
        if (ctx.portraitKey === undefined) return;

        const card = transient(scene.add.image(at.x, at.y - 40, ctx.portraitKey).setScale(0.9).setAlpha(0));
        const caption = transient(
            scene.add
                .text(at.x, at.y + 140, ctx.label ?? 'Only you see this', {
                    fontFamily: FONT_UI,
                    fontSize: '18px',
                    color: '#22d3ee'
                })
                .setOrigin(0.5)
                .setAlpha(0)
        );

        await tweenPromise(scene, { targets: [card, caption], alpha: 1, duration: step.durationMs, ease: 'Sine.easeOut' });
        await tweenPromise(scene, { targets: [card, caption], alpha: 0, duration: 200, delay: 900 });
        card.destroy();
        caption.destroy();
    }

    async function shimmer(step: MotionStep, ctx: BeatContext): Promise<void> {
        // rainbow_gradient, assigned to the devotion-token award (UIX §8.5).
        const rect = ctx.rect ?? viewport();
        const at = centreOf(rect);
        const sheen = transient(
            scene.add.image(at.x, at.y, TEXTURES.rainbow).setDisplaySize(rect.w, rect.h).setAlpha(0)
        );

        await tweenPromise(scene, { targets: sheen, alpha: 0.7, duration: step.durationMs / 2, yoyo: true });
        sheen.destroy();
    }

    async function burst(step: MotionStep): Promise<void> {
        // sparkle_pattern, assigned to match victory (UIX §8.5). A scaling,
        // fading sheet rather than a ParticleEmitter: one texture, one tween,
        // and nothing to tune — the emitter can come later if it earns its keep.
        const at = centreOf(viewport());
        const sparkle = transient(scene.add.image(at.x, at.y, TEXTURES.sparkle).setScale(0.4).setAlpha(0.9));

        await tweenPromise(scene, {
            targets: sparkle,
            scale: 2.2,
            alpha: 0,
            duration: step.durationMs,
            ease: 'Cubic.easeOut'
        });
        sparkle.destroy();
    }

    async function fade(step: MotionStep, ctx: BeatContext): Promise<void> {
        // Every beat's reduced-motion form. Movement goes; the fact does not.
        const rect = ctx.rect ?? viewport();
        const wash = transient(
            scene.add.rectangle(rect.x, rect.y, rect.w, rect.h, TOKENS.colorNebulaPurple, 1).setOrigin(0, 0).setAlpha(0)
        );

        await tweenPromise(scene, { targets: wash, alpha: 0.4, duration: step.durationMs, yoyo: true });
        wash.destroy();
    }

    async function runStep(step: MotionStep, ctx: BeatContext): Promise<void> {
        switch (step.kind) {
            case 'fade':
                return fade(step, ctx);
            case 'banner':
                return banner(step, ctx);
            case 'desaturate':
                return desaturate(step, ctx);
            case 'flip':
                return flip(step, ctx);
            case 'ripple':
                return ripple(step);
            case 'loom':
                return loom(step, ctx);
            case 'reveal':
                return reveal(step, ctx);
            case 'shimmer':
                return shimmer(step, ctx);
            case 'burst':
                return burst(step);
            // Information, not decoration — the countdown redraws itself.
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
            layer.removeAll(true);
        }
    };
}
