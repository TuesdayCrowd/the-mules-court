import { describe, expect, it } from 'vitest';
import { createPresentationQueue } from './presentationQueue';

/** Let every already-queued microtask and timer callback run. */
function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/** A promise plus the handles to settle it from the outside. */
function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function spyQueue() {
    const spoken: string[] = [];
    return { spoken, queue: createPresentationQueue({ announce: line => spoken.push(line) }) };
}

describe('createPresentationQueue', () => {
    it('never announces before the matching animation resolves', async () => {
        const { spoken, queue } = spyQueue();
        const first = deferred();

        queue.enqueue({ animate: () => first.promise, announce: 'first' });
        queue.enqueue({ animate: () => Promise.resolve(), announce: 'second' });

        await flush();
        expect(spoken).toEqual([]); // interface rule 8: the accessible channel never runs ahead

        first.resolve();
        await queue.drained();
        expect(spoken).toEqual(['first', 'second']);
    });

    it('still announces when an animation throws — a failed tween must not silence the screen reader', async () => {
        const { spoken, queue } = spyQueue();

        queue.enqueue({
            animate: () => Promise.reject(new Error('tween died')),
            announce: 'the elimination still happened'
        });

        await queue.drained();
        expect(spoken).toEqual(['the elimination still happened']);
    });

    it('keeps running after a step throws synchronously', async () => {
        const { spoken, queue } = spyQueue();

        queue.enqueue({
            animate: () => {
                throw new Error('no such texture');
            },
            announce: 'first'
        });
        queue.enqueue({ announce: 'second' });

        await queue.drained();
        expect(spoken).toEqual(['first', 'second']);
    });

    it('runs animations one at a time', async () => {
        const { queue } = spyQueue();
        const started: number[] = [];
        const gates = [deferred(), deferred(), deferred()];

        gates.forEach((gate, index) => {
            queue.enqueue({
                animate: () => {
                    started.push(index);
                    return gate.promise;
                }
            });
        });

        await flush();
        expect(started).toEqual([0]);

        gates[0].resolve();
        await flush();
        expect(started).toEqual([0, 1]);

        gates[1].resolve();
        gates[2].resolve();
        await queue.drained();
        expect(started).toEqual([0, 1, 2]);
    });

    it('announces a step with no animation, in its turn', async () => {
        const { spoken, queue } = spyQueue();
        const first = deferred();

        queue.enqueue({ animate: () => first.promise, announce: 'animated' });
        queue.enqueue({ announce: 'silent beat' });

        await flush();
        expect(spoken).toEqual([]); // it waits its turn rather than jumping the animation

        first.resolve();
        await queue.drained();
        expect(spoken).toEqual(['animated', 'silent beat']);
    });

    it('runs an animation that has nothing to announce', async () => {
        const { spoken, queue } = spyQueue();
        let ran = false;

        queue.enqueue({
            animate: async () => {
                ran = true;
            }
        });

        await queue.drained();
        expect(ran).toBe(true);
        expect(spoken).toEqual([]);
    });

    it('is not wedged by an announce that throws', async () => {
        // One bad sink must not stop the table animating for the rest of the match.
        let announced = 0;
        const queue = createPresentationQueue({
            announce: () => {
                announced++;
                if (announced === 1) throw new Error('detached aria-live node');
            }
        });

        queue.enqueue({ announce: 'first' });
        queue.enqueue({ announce: 'second' });

        await queue.drained();
        expect(announced).toBe(2);
    });

    it('resolves drained immediately when nothing is queued', async () => {
        await expect(spyQueue().queue.drained()).resolves.toBeUndefined();
    });

    it('awaits work enqueued before the call', async () => {
        const { spoken, queue } = spyQueue();
        const gate = deferred();
        queue.enqueue({ animate: () => gate.promise, announce: 'slow' });

        let settled = false;
        const drained = queue.drained().then(() => {
            settled = true;
        });

        await flush();
        expect(settled).toBe(false);

        gate.resolve();
        await drained;
        expect(spoken).toEqual(['slow']);
    });
});

describe('who a line is about', () => {
    it('defaults to narration, so every existing step is unchanged', async () => {
        const seen: Array<[string, string]> = [];
        const queue = createPresentationQueue({ announce: (line, kind) => seen.push([line, kind]) });

        queue.enqueue({ announce: 'Han Pritcher played Informant.' });
        await queue.drained();

        expect(seen).toEqual([['Han Pritcher played Informant.', 'narration']]);
    });

    it('carries a personal line through to the surface that renders it', async () => {
        const seen: Array<[string, string]> = [];
        const queue = createPresentationQueue({ announce: (line, kind) => seen.push([line, kind]) });

        queue.enqueue({ announce: 'Han Pritcher looked at your hand.', announceKind: 'personal' });
        await queue.drained();

        expect(seen).toEqual([['Han Pritcher looked at your hand.', 'personal']]);
    });

    it('still releases a personal line only after its beat has played', async () => {
        const order: string[] = [];
        const queue = createPresentationQueue({ announce: (_line, kind) => order.push(`announce:${kind}`) });

        queue.enqueue({
            animate: () => {
                order.push('animate');
            },
            announce: 'Han Pritcher made you discard your hand.',
            announceKind: 'personal'
        });
        await queue.drained();

        expect(order).toEqual(['animate', 'announce:personal']);
    });
});
