/**
 * When the game is allowed to stop drawing (interface rule 9's sibling: the
 * layers share tokens, and neither should burn a GPU saying nothing).
 *
 * **Phaser renders every frame, unconditionally.** `Game.step` runs
 * `renderer.preRender()`, `scene.render()`, `renderer.postRender()` on every
 * animation frame with no dirty check anywhere in the path. That is the right
 * default for a game with a simulation; this one is a turn-based card game whose
 * table is a still image between actions, and no scene here even defines
 * `update()`. So the renderer was redrawing an unchanged picture sixty or a
 * hundred and twenty times a second, forever, for as long as the tab was open.
 *
 * The decision lives here rather than in `main.ts` for the reason `POINTER_POLICY`
 * does: it can then be asserted without constructing a `Game`, and the reasoning
 * sits with the value instead of in a config literal someone would reasonably
 * tidy away.
 *
 * **It fails awake.** Every branch that cannot prove the game is idle returns
 * "keep drawing". A frame drawn needlessly costs power; a frame withheld
 * wrongly is a frozen table, and those are not comparable.
 *
 * ---
 *
 * ## Why this exists, and why it stayed when its reason evaporated
 *
 * It was written for a report that the GPU sat at 80% with the game open. That
 * report turned out to be **Edge's "Transparency effects" setting**, under
 * Appearance — a full-screen backdrop blur on the browser's own chrome,
 * recomposited continuously against whatever is behind it. Turning it off fixed
 * it. Measured in the same window afterwards, this game idling cost 5.0% GPU
 * against a blank page's 7.3%: indistinguishable, and already so *before* this
 * module existed in the build under test.
 *
 * So the problem it was built to solve was never this codebase's. It is kept
 * anyway, deliberately, for two reasons that never depended on that report:
 *
 *  1. **The waste was real and is arithmetic, not a hypothesis.** Measured in a
 *     visible browser window: sixty to a hundred and twenty full redraws a
 *     second of a picture that had not changed, now zero. Nothing about that
 *     number came from the misdiagnosis.
 *  2. **This design is touch-first** (UIX line 15). A phone holding its GPU at
 *     refresh rate to display a still image spends battery for nothing, and a
 *     player on a phone has no Appearance setting that would help them.
 *
 * Deleting it as "complexity that solved a non-problem" would restore a known
 * waste to fix nothing. That is the reading this paragraph exists to prevent —
 * the provenance is genuinely embarrassing, and it is written down precisely so
 * nobody has to re-derive whether the machinery is load-bearing.
 *
 * **The obligation it creates:** nothing on the table may animate forever.
 * `Court.isAnimating()` is what permits sleep, so an endless tween pins the loop
 * awake and quietly undoes all of this — which is exactly what the deck's
 * warning pulse did for a round, until `courtContract.test.ts` grew a guard
 * against `repeat: -1`.
 */

/**
 * How long the loop keeps running after the last thing that needed drawing.
 *
 * Not zero. A state update often *starts* a tween a frame or two later — the
 * presentation queue awaits one beat before releasing the next — and a pump that
 * slept the instant a frame was drawn would have to be woken again immediately.
 * Long enough to ride over that, short enough that an idle table settles before
 * a player notices anything.
 */
export const IDLE_GRACE_MS = 500;

/** How often the watchdog asks whether it may sleep. Cheap: five times a second. */
export const IDLE_CHECK_MS = 200;

export interface IdleInput {
    /** Milliseconds since the last `wake()`. */
    readonly sinceWakeMs: number;
    /**
     * Whether anything on the scene is still moving — a tween, a pending timer,
     * a beat mid-flight.
     *
     * Sleeping through any of these is the failure mode that matters: Phaser's
     * clock and tween manager are both driven by the loop, so a slept loop does
     * not merely pause an animation, it prevents the tween from ever completing.
     * `beats.ts` resolves its promise from a tween's `onComplete`, and the
     * presentation queue awaits that promise before releasing the next
     * announcement — so one missed tween stalls the whole table permanently.
     */
    readonly animating: boolean;
    /**
     * False until the gameplay scene is up.
     *
     * Boot and Preloader need the loop: `document.fonts.ready` and the loader's
     * progress both advance on it. Sleeping before `Court` starts would hang the
     * game on its loading bar.
     */
    readonly ready: boolean;
}

/** Whether the render loop may stop. */
export function mayIdle(input: IdleInput): boolean {
    if (!input.ready) return false;
    if (input.animating) return false;
    return input.sinceWakeMs >= IDLE_GRACE_MS;
}

export interface RenderPumpDeps {
    /** Start the render loop. Idempotent — Phaser's `wake()` returns early if running. */
    readonly startLoop: () => void;
    readonly stopLoop: () => void;
    readonly animating: () => boolean;
    readonly ready: () => boolean;
    readonly now: () => number;
    readonly schedule: (fn: () => void, ms: number) => number;
    readonly cancel: (handle: number) => void;
}

export interface RenderPump {
    /** Something happened that must be drawn. Safe to call on every pointer move. */
    wake(): void;
    /** The watchdog's decision point. Exposed so a test can drive it without a clock. */
    tick(): void;
    /** True while the loop is running, for tests and diagnostics. */
    running(): boolean;
    destroy(): void;
}

/**
 * Runs the loop while there is anything to draw, and stops it when there is not.
 *
 * The watchdog is a plain `setInterval`, deliberately: Phaser's own clock stops
 * with the loop, so a pump timed by `scene.time` could never wake itself back up.
 */
export function createRenderPump(deps: RenderPumpDeps): RenderPump {
    let lastWake = deps.now();
    let awake = true;
    let watchdog: number | null = null;

    function startWatchdog(): void {
        if (watchdog === null) watchdog = deps.schedule(() => pump.tick(), IDLE_CHECK_MS);
    }

    const pump: RenderPump = {
        wake() {
            lastWake = deps.now();
            startWatchdog();
            if (awake) return;
            awake = true;
            deps.startLoop();
        },

        tick() {
            if (!awake) return;
            if (!mayIdle({ sinceWakeMs: deps.now() - lastWake, animating: deps.animating(), ready: deps.ready() })) {
                return;
            }
            awake = false;
            deps.stopLoop();
        },

        running() {
            return awake;
        },

        destroy() {
            if (watchdog !== null) deps.cancel(watchdog);
            watchdog = null;
        }
    };

    startWatchdog();
    return pump;
}

/**
 * DOM events that must wake the loop.
 *
 * Phaser's mouse and touch managers bind to the canvas and *queue* what they
 * receive; the queue is drained in the loop's pre-step. So while the loop is
 * stopped a tap is still captured and simply never processed — the card does
 * nothing. These are the events that have to bring the loop back before that
 * queue matters.
 *
 * `pointermove` is included on purpose even though a bare cursor crossing the
 * table changes nothing: hover is what raises a card's hint, and the hit-test
 * that decides it runs on the loop.
 *
 * **The touch four are not redundant with the pointer four.** Phaser's
 * `TouchManager` binds `touchstart`/`touchmove`/`touchend`/`touchcancel` to the
 * canvas directly — those, not pointer events, are what a finger is queued
 * from. Browsers do also emit pointer events for touch, so listing only the
 * pointer names happened to work on a handset; it worked by coincidence, and it
 * left the loop deaf to a touch that arrived without one. Cover what Phaser
 * actually binds.
 */
export const WAKE_EVENTS = [
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointercancel',
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
    'wheel',
    'keydown'
] as const;
