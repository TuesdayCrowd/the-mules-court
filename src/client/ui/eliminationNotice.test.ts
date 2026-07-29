// @vitest-environment jsdom
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EliminationReason } from '../content/elimination';
import { makeView } from '../store/__fixtures__/view';
import { loadRealStyles, makeState, makeTable, makeUiRootElement } from './__fixtures__/dom';
import { createEliminationNotice } from './eliminationNotice';

beforeEach(() => {
    loadRealStyles();
});

const REASON: EliminationReason = {
    headline: 'You are out of the round.',
    detail: 'Bayta compared hands with you. You held 3 · Ebling Mis; they held 5 · Bayta Darell. The lower card is out.'
};

const COMPARISON_LOG = [
    { kind: 'PLAY', turn: 3, actorId: 'p2', cardId: 'ebling-mis' },
    { kind: 'COMPARE', turn: 3, actorId: 'p2', targetId: 'p1', result: 'target-eliminated' },
    { kind: 'ELIMINATED', turn: 3, playerId: 'p1', cause: 'baron' }
] as never;

function seatState(
    alive: boolean,
    screen: 'table' | 'lobby' = 'table',
    log: unknown = [],
    roundResult: unknown = null
) {
    const base = makeView();
    return makeState({
        screen,
        seat: { seat: 0, playerId: 'p1' },
        table: makeTable({
            view: makeView({
                roundResult: roundResult as never,
                publicLog: log as never,
                revealed: [{ subjectId: 'p2', cardTypeId: 'bayta-darell' }] as never,
                players: [
                    {
                        ...base.players[0],
                        alive,
                        discardPile: [{ cardId: 'ebling-mis', value: 3 }] as never
                    },
                    base.players[1]
                ]
            })
        })
    });
}

/** Eliminated, with the log that explains it — the ordinary case. */
const OUT = () => seatState(false, 'table', COMPARISON_LOG);

function mounted() {
    const root = makeUiRootElement();
    const notice = createEliminationNotice();
    notice.mount(root);

    const q = <T extends Element>(s: string) => root.querySelector(s) as T | null;
    return {
        root,
        notice,
        dialog: () => q<HTMLElement>('[data-role="elimination-notice"]'),
        detail: () => q<HTMLElement>('[data-role="elimination-detail"]')?.textContent ?? '',
        dismiss: () => q<HTMLButtonElement>('[data-action="close-elimination"]')
    };
}

describe('showing why', () => {
    it('shows nothing until it is told to', () => {
        expect(mounted().dialog()).toBeNull();
    });

    it('states the fact first, then the reason', () => {
        const ui = mounted();
        ui.notice.show(REASON);

        expect(ui.dialog()!.textContent).toContain('You are out of the round.');
        expect(ui.detail()).toBe(REASON.detail);
    });

    it('renders the reason as text, never as markup', () => {
        // The sentence carries other players' nicknames, which are free text.
        const ui = mounted();
        ui.notice.show({ headline: 'You are out of the round.', detail: '<img src=x onerror=alert(1)>' });

        expect(ui.root.querySelector('img')).toBeNull();
    });

    it('ignores a second show while one is already up', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        ui.notice.show({ headline: 'Other', detail: 'Other' });

        expect(ui.detail()).toBe(REASON.detail);
    });
});

/** The whole request: close it and go on watching. */
describe('dismissing it', () => {
    it('offers a button that says what dismissing is for', () => {
        const ui = mounted();
        ui.notice.show(REASON);

        expect(ui.dismiss()!.textContent!.toLowerCase()).toContain('watch');
    });

    it('goes away when pressed', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        ui.dismiss()!.click();

        expect(ui.dialog()).toBeNull();
        expect(ui.notice.showing()).toBeNull();
    });

    it('stays away — nothing re-opens it while the round runs on', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        ui.dismiss()!.click();

        // Several more state pushes, as the round plays out around them.
        for (let i = 0; i < 5; i++) ui.notice.update(seatState(false, 'table', COMPARISON_LOG));

        expect(ui.dialog()).toBeNull();
    });

    it('returns focus where the player left it', () => {
        const ui = mounted();
        const before = document.createElement('button');
        ui.root.appendChild(before);
        before.focus();

        ui.notice.show(REASON);
        expect(document.activeElement).toBe(ui.dialog());

        ui.dismiss()!.click();
        expect(document.activeElement).toBe(before);
    });
});

/**
 * The wiring that matters: driven by state rather than by a diff event.
 * `diffSnapshots` returns nothing when there is no previous view, which is
 * exactly the reconnect path — so a player whose connection blipped as they went
 * out would never have been told why.
 */
describe('finding out for itself', () => {
    it('explains an elimination it was never told about', () => {
        const ui = mounted();
        ui.notice.update(OUT());

        expect(ui.dialog()).not.toBeNull();
        expect(ui.detail()).toContain('3 · Ebling Mis');
        expect(ui.detail()).toContain('5 · Bayta Darell');
    });

    it('shows it on a first push, as a reconnect delivers', () => {
        // No prior state at all — the case a diff-driven design misses.
        const ui = mounted();
        ui.notice.update(OUT());
        expect(ui.notice.showing()).not.toBeNull();
    });

    it('says nothing while the player is still in the round', () => {
        const ui = mounted();
        ui.notice.update(seatState(true, 'table', COMPARISON_LOG));
        expect(ui.dialog()).toBeNull();
    });

    it('does not re-open after being dismissed, however many pushes follow', () => {
        const ui = mounted();
        ui.notice.update(OUT());
        ui.dismiss()!.click();

        for (let i = 0; i < 6; i++) ui.notice.update(OUT());

        expect(ui.dialog()).toBeNull();
    });

    it('arms again for the next round, once the player is dealt back in', () => {
        const ui = mounted();
        ui.notice.update(OUT());
        ui.dismiss()!.click();

        ui.notice.update(seatState(true, 'table', []));
        ui.notice.update(OUT());

        expect(ui.dialog()).not.toBeNull();
    });
});

describe('its lifetime', () => {
    it('survives the state pushes that carry on around it', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        ui.notice.update(seatState(false, 'table', COMPARISON_LOG));

        expect(ui.dialog()).not.toBeNull();
    });

    it('clears when the next round deals the player back in', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        ui.notice.update(seatState(true));

        expect(ui.dialog()).toBeNull();
    });

    it('clears when the table goes away', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        ui.notice.update(seatState(false, 'lobby', COMPARISON_LOG));

        expect(ui.dialog()).toBeNull();
    });
});

/**
 * Reported: "the button asked them to continue watching the round, but the round
 * had actually ended with them going out." Going out is very often what ends the
 * round, so this is the common case rather than the odd one.
 */
describe('when the elimination is what ended the round', () => {
    const ROUND_OVER = { reason: 'last-survivor', winnerIds: ['p2'] };

    it('does not send the player off to watch a round that is over', () => {
        const ui = mounted();
        ui.notice.update(seatState(false, 'table', COMPARISON_LOG, ROUND_OVER));

        expect(ui.dismiss()!.textContent!.toLowerCase()).not.toContain('watch the rest');
    });

    it('offers to show them how it ended instead', () => {
        const ui = mounted();
        ui.notice.update(seatState(false, 'table', COMPARISON_LOG, ROUND_OVER));

        expect(ui.dismiss()!.textContent!.toLowerCase()).toContain('ended');
    });

    it('still says watch while the round genuinely runs on', () => {
        const ui = mounted();
        ui.notice.update(OUT());

        expect(ui.dismiss()!.textContent!.toLowerCase()).toContain('watch');
    });

    it('reveals the round-over overlay beneath once dismissed', () => {
        const ui = mounted();
        ui.notice.update(seatState(false, 'table', COMPARISON_LOG, ROUND_OVER));
        ui.dismiss()!.click();

        expect(ui.dialog()).toBeNull();
    });
});

describe('accessibility', () => {
    it('interrupts, because it is about something that happened to this player', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        expect(ui.dialog()!.getAttribute('role')).toBe('alertdialog');
    });

    it('carries an accessible name', () => {
        const ui = mounted();
        ui.notice.show(REASON);
        const labelledBy = ui.dialog()!.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelledBy)!.textContent!.length).toBeGreaterThan(0);
    });

    it('layers above the round-over overlay it usually arrives with', () => {
        // Going out is very often what ends the round, so both land in one push.
        const ui = mounted();
        ui.notice.show(REASON);

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        ui.root.appendChild(overlay);

        expect(Number(getComputedStyle(ui.dialog()!).zIndex)).toBeGreaterThan(
            Number(getComputedStyle(overlay).zIndex)
        );
    });

    it('has no axe violations', async () => {
        const ui = mounted();
        ui.notice.show(REASON);

        const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(results.violations.map(v => v.id)).toEqual([]);
    });
});
