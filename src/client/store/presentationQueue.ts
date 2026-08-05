/**
 * The animation/announcement queue (UIX §8.4, interface rule 8).
 *
 * One rule, enforced structurally: **the accessible channel never runs ahead of
 * the visible one.** A step's `announce` fires only after its `animate` settles,
 * and steps run strictly in order, so `aria-live` can never describe a result the
 * table has not shown yet.
 *
 * The chain is the same fifteen-line shape as `Room.enqueue` in
 * `src/server/room.ts` — deliberately, because that is already the codebase's
 * answer to "serialise this" and a second idiom would be one to learn twice.
 */

/**
 * Who a queued line is about.
 *
 * `personal` means it happened TO the viewer — a card played on them, told in
 * the second person. It travels with the line rather than being worked out at
 * the far end, because by the time the line is a string the only thing that
 * knew whose seat it concerned is long gone.
 *
 * Declared here, in the pure layer, so the queue and the surface that renders
 * its lines cannot drift apart about the vocabulary.
 */
export type AnnounceKind = 'narration' | 'personal';

export interface PresentationStep {
    /** The canvas beat. Resolves when it has finished playing. */
    readonly animate?: () => Promise<void> | void;
    /** The `aria-live` line, spoken only once `animate` has settled. */
    readonly announce?: string;
    /** Defaults to `narration` — the running commentary about the table. */
    readonly announceKind?: AnnounceKind;
}

export interface PresentationQueueDeps {
    readonly announce: (line: string, kind: AnnounceKind) => void;
}

export interface PresentationQueue {
    enqueue(step: PresentationStep): void;
    /** Resolves once everything queued *so far* has run. */
    drained(): Promise<void>;
}

export function createPresentationQueue(deps: PresentationQueueDeps): PresentationQueue {
    let tail: Promise<void> = Promise.resolve();

    async function run(step: PresentationStep): Promise<void> {
        try {
            await step.animate?.();
        } catch {
            // A dead tween must not silence the screen reader: the thing being
            // announced happened on the server whether or not it drew.
        }

        if (step.announce === undefined) return;
        try {
            deps.announce(step.announce, step.announceKind ?? 'narration');
        } catch {
            // One bad sink must not wedge the table for the rest of the match.
        }
    }

    return {
        enqueue(step) {
            tail = tail.then(() => run(step));
        },

        // Read at call time, so a caller awaits the work it knows about rather
        // than chasing steps enqueued after it asked.
        drained: () => tail
    };
}
