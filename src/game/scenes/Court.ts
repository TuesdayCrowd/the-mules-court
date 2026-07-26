import { Scene } from 'phaser';
import { buildRenderPlan } from '../../client/layout/renderPlan';
import type { RenderPlan, SeatPlan } from '../../client/layout/renderPlan';
import { computeLayout } from '../../client/layout/tableLayout';
import type { LayoutSpec } from '../../client/layout/types';
import type { ClientState } from '../../client/store/types';
import { cardCopyFor } from '../../client/content/cardCopy';
import { TOKENS } from '../../client/tokens/tokens';
import { TEXTURES } from './Preloader';

/**
 * The table (UIX §2.5, §6).
 *
 * The only gameplay scene. Between matches it idles as the ambient nebula
 * behind the DOM screens; during one it draws the table from a `LayoutSpec`.
 *
 * **It computes no geometry and decides no rule.** Positions arrive from
 * `computeLayout`, which is pure and tested; interface rule 6 gives
 * `STATE_UPDATE` and resize the same single path through `renderView`.
 */
export class Court extends Scene {
    private background: Phaser.GameObjects.Image;
    /** Everything the plan draws. Cleared and rebuilt per render — see `draw`. */
    private table: Phaser.GameObjects.Container;
    private spec: LayoutSpec | null = null;
    private latest: ClientState | null = null;
    private resizeHandle: number | null = null;

    constructor() {
        super('Court');
    }

    create() {
        const { width, height } = this.scale.gameSize;

        this.background = this.add.image(width / 2, height / 2, TEXTURES.playfield);
        this.fitBackground(width, height);
        this.table = this.add.container(0, 0);

        this.scale.on('resize', this.onResize, this);

        // Scenes can restart; a listener that outlives one leaks into the next.
        this.events.once('shutdown', () => {
            this.scale.off('resize', this.onResize, this);
            if (this.resizeHandle !== null) window.clearTimeout(this.resizeHandle);
        });

        this.game.events.emit('court-ready');
    }

    /** The one path. Called by the store subscriber and by resize alike. */
    renderView(state: ClientState): void {
        this.latest = state;

        const { width, height } = this.scale.gameSize;
        this.fitBackground(width, height);

        const table = state.table;
        if (table === null) {
            this.spec = null;
            return;
        }

        this.spec = computeLayout({
            w: width,
            h: height,
            opponentCount: Math.min(3, Math.max(1, table.view.players.length - 1)) as 1 | 2 | 3,
            handCount: Math.min(2, Math.max(1, table.view.own.hand.length)) as 1 | 2,
            showsRemovedCard: table.view.setAsideFaceUp !== null,
            maxDiscards: table.view.players.reduce((worst, p) => Math.max(worst, p.discardPile.length), 0)
        });

        this.draw(
            buildRenderPlan(
                {
                    view: table.view,
                    nicknames: table.nicknames,
                    phase: table.phase,
                    paused: table.paused,
                    missingSeats: table.missingSeats
                },
                this.spec
            )
        );
    }

    /**
     * Walk the plan and draw it.
     *
     * Cleared and rebuilt rather than diffed. A table is a few dozen objects and
     * is redrawn only on a state update or a debounced resize, so a pooling
     * reconciler here would be machinery guarding a cost that does not exist —
     * and the plan it walks is already the thing that decided what changed.
     *
     * Nothing in this method makes a decision. Every colour, caption, position
     * and flag was settled by `buildRenderPlan`, which is pure and tested.
     */
    private draw(plan: RenderPlan): void {
        this.table.removeAll(true);

        for (const seat of plan.seats) this.drawSeat(seat);

        const deck = this.add
            .rectangle(plan.deck.rect.x, plan.deck.rect.y, plan.deck.rect.w, plan.deck.rect.h, plan.deck.colour, 0.85)
            .setOrigin(0, 0);
        const deckCount = this.add
            .text(plan.deck.rect.x + plan.deck.rect.w / 2, plan.deck.rect.y + plan.deck.rect.h / 2, String(plan.deck.count), {
                fontFamily: 'Exo 2, sans-serif',
                fontSize: `${Math.round(plan.deck.rect.h * 0.32)}px`,
                color: '#f5f5f5'
            })
            .setOrigin(0.5);
        this.table.add([deck, deckCount]);

        const banner = this.add
            .text(plan.banner.rect.x + plan.banner.rect.w / 2, plan.banner.rect.y + plan.banner.rect.h / 2, plan.banner.text, {
                fontFamily: 'Exo 2, sans-serif',
                fontSize: `${Math.round(plan.banner.rect.h * 0.7)}px`,
                color: hex(plan.banner.colour)
            })
            .setOrigin(0.5);
        this.table.add(banner);

        if (plan.removedCard !== null) {
            const burn = this.add
                .image(plan.removedCard.rect.x, plan.removedCard.rect.y, cardCopyFor(plan.removedCard.cardId).portraitKey)
                .setOrigin(0, 0)
                .setDisplaySize(plan.removedCard.rect.w, plan.removedCard.rect.h);
            this.table.add(burn);
        }

        for (const card of plan.hand) {
            const face = this.add
                .image(card.rect.x, card.rect.y, cardCopyFor(card.cardId).portraitKey)
                .setOrigin(0, 0)
                .setDisplaySize(card.rect.w, card.rect.h)
                // Dimming is real, not decorative: it says a rule denied this
                // card, and `caption` on the plan says which.
                .setAlpha(card.dimmed ? 0.4 : 1);
            this.table.add(face);

            if (card.playable) {
                const border = this.add
                    .rectangle(card.rect.x, card.rect.y, card.rect.w, card.rect.h)
                    .setOrigin(0, 0)
                    .setStrokeStyle(2, TOKENS.colorStateYourTurn);
                this.table.add(border);

                /**
                 * A dedicated hit target, sized from the LayoutSpec.
                 *
                 * Deliberately not `face.setInteractive()`: that derives its hit
                 * area from the texture frame, so a card whose art failed to
                 * load would take taps over a 32x32 placeholder instead of the
                 * card. That is not hypothetical — it is exactly what the
                 * missing-texture bug alongside this one produced. A rectangle
                 * built from the same numbers that placed the card cannot
                 * disagree with where the card appears.
                 */
                const hit = this.add
                    .rectangle(card.rect.x, card.rect.y, card.rect.w, card.rect.h, 0x000000, 0)
                    .setOrigin(0, 0)
                    .setInteractive({ useHandCursor: true });
                hit.on('pointerdown', () => this.events.emit(CARD_SELECTED, card.cardInstanceId));
                this.table.add(hit);
            }
        }
    }

    private drawSeat(seat: SeatPlan): void {
        const border = this.add
            .rectangle(seat.rect.x, seat.rect.y, seat.rect.w, seat.rect.h)
            .setOrigin(0, 0)
            .setStrokeStyle(2, SEAT_COLOURS[seat.state]);
        // Eliminated seats dim; nothing else does. The skull and the caption
        // carry the same fact in shape and in words.
        border.setAlpha(seat.state === 'eliminated' ? 0.5 : 1);

        const name = this.add.text(seat.rect.x + 6, seat.rect.y + 6, seat.nickname, {
            fontFamily: 'Inter, sans-serif',
            fontSize: '14px',
            color: '#f5f5f5'
        });

        // Interface rule 7: every value, never a truncation. The pip geometry
        // was sized for the worst case the engine can actually produce.
        const pips = seat.discardValues
            .map((value, index) => {
                const perRow = Math.max(1, Math.floor(seat.rect.w / 18));
                return this.add.text(
                    seat.rect.x + 6 + (index % perRow) * 18,
                    seat.rect.y + seat.rect.h - 34 + Math.floor(index / perRow) * 16,
                    String(value),
                    { fontFamily: 'Inter, sans-serif', fontSize: '12px', color: '#9ca3af' }
                );
            });

        this.table.add([border, name, ...pips]);

        if (seat.caption !== null) {
            const caption = this.add.text(seat.rect.x + 6, seat.rect.y + seat.rect.h - 16, seat.caption, {
                fontFamily: 'Inter, sans-serif',
                fontSize: '11px',
                color: hex(SEAT_COLOURS[seat.state])
            });
            this.table.add(caption);
        }
    }

    /** The spec the table was last drawn from, for the accessibility twin's hand proxies. */
    currentLayout(): LayoutSpec | null {
        return this.spec;
    }

    private fitBackground(width: number, height: number): void {
        this.background.setPosition(width / 2, height / 2);
        // Cover, so no edge of the viewport is ever unpainted.
        const source = this.background.texture.getSourceImage();
        this.background.setScale(Math.max(width / source.width, height / source.height));
    }

    private onResize(): void {
        // UIX §2.1: debounced, and skipped entirely while a text input holds
        // focus. A focused input means the viewport is mid-keyboard-animation on
        // iOS Safari — re-laying out there costs a frame and gains nothing the
        // next real resize will not.
        if (document.activeElement?.matches('input, textarea')) return;

        if (this.resizeHandle !== null) window.clearTimeout(this.resizeHandle);
        this.resizeHandle = window.setTimeout(() => {
            this.resizeHandle = null;
            this.cameras.resize(this.scale.gameSize.width, this.scale.gameSize.height);
            if (this.latest !== null) this.renderView(this.latest);
        }, RESIZE_DEBOUNCE_MS);
    }
}

/** Emitted on the scene when a playable card is raised. `main.ts` opens the sheet. */
export const CARD_SELECTED = 'card-selected';

/** Long enough to ride out a toolbar collapse, short enough to feel immediate. */
const RESIZE_DEBOUNCE_MS = 100;

/** UIX §6.3, straight from the palette — the plan chose the state, this maps it. */
const SEAT_COLOURS: Record<SeatPlan['state'], number> = {
    current: TOKENS.colorSeatCurrent,
    protected: TOKENS.colorSeatProtected,
    eliminated: TOKENS.colorSeatEliminated,
    disconnected: TOKENS.colorSeatDisconnected,
    idle: TOKENS.colorSeatOther
};

/** Phaser text takes CSS colours; the palette is integers for everything else. */
function hex(colour: number): string {
    return `#${colour.toString(16).padStart(6, '0')}`;
}
