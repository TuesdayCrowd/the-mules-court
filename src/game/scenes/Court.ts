import { Scene } from 'phaser';
import { buildRenderPlan, medallionPlan } from '../../client/layout/renderPlan';
import type { RenderPlan, SeatPlan } from '../../client/layout/renderPlan';
import { fitOverline } from '../../client/layout/overline';
import { computeLayout } from '../../client/layout/tableLayout';
import type { LayoutSpec, Rect } from '../../client/layout/types';
import type { ClientState } from '../../client/store/types';
import { cardCopyFor, cardLabel } from '../../client/content/cardCopy';
import type { CardTypeId } from '../../game/engine';
import { TOKENS } from '../../client/tokens/tokens';
import type { BeatRunner } from './beats';
import { createBeatRunner } from './beats';
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
    /**
     * The beat layer, above the table and never cleared by `draw`.
     *
     * A beat animating a table object would have its target destroyed by the
     * next state update mid-tween, which is both a visual glitch and a promise
     * that resolves early — and an early promise breaks the sequencing rule the
     * whole queue exists to keep.
     */
    private beatLayer: Phaser.GameObjects.Container;
    private beats: BeatRunner;
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
        this.beatLayer = this.add.container(0, 0);
        this.beats = createBeatRunner(this, this.beatLayer, {
            reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
        });

        this.scale.on('resize', this.onResize, this);

        // Scenes can restart; a listener that outlives one leaks into the next.
        this.events.once('shutdown', () => {
            this.beats.destroy();
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
            const panel = plan.removedCard.rect;
            const hidden = plan.removedCard.faceDownCount;

            /**
             * The face-down removals, peeking out to the right: `[4]]]`.
             *
             * Their whole job is to say "three cards left this round and you
             * only get to see one" — the count is public (it follows from the
             * player count) while the faces are not, and a fanned edge says
             * both at once better than a sentence would.
             *
             * Laid out INSIDE the reserved rect, with the face-up card giving
             * up the width. Drawing past the rect would put pixels somewhere
             * `computeLayout` never proved empty, and the no-overlap and
             * inside-viewport guarantees are only over the rects it returns.
             */
            const sliverStep = hidden > 0 ? Math.max(MIN_SLIVER_STEP, Math.round(panel.w * SLIVER_STEP_FRACTION)) : 0;
            const faceRect: Rect = { ...panel, w: panel.w - sliverStep * hidden };

            // Back to front, so each sliver tucks behind the one to its left and
            // the face-up card sits on top of all of them.
            //
            // Each one needs an EDGE and its own height. Drawn without either,
            // two backs of the same texture at the same vertical extent abut
            // into a single continuous strip — the fan was there, and it read
            // as one card, which is exactly how it was reported.
            for (let index = hidden; index >= 1; index--) {
                // The further back, the shorter: a fan recedes.
                const inset = SLIVER_INSET * index;
                const right = faceRect.x + faceRect.w + sliverStep * index;
                const top = panel.y + inset;
                const height = Math.max(MIN_SLIVER_HEIGHT, panel.h - inset * 2);

                const back = this.add
                    .image(right, top, TEXTURES.cardBack)
                    .setOrigin(1, 0)
                    .setDisplaySize(faceRect.w, height);
                const edge = this.add
                    .rectangle(right, top, faceRect.w, height)
                    .setOrigin(1, 0)
                    .setStrokeStyle(1, TOKENS.colorSeatOther);

                this.table.add([back, edge]);
            }

            const burn = this.add
                .image(faceRect.x, faceRect.y, cardCopyFor(plan.removedCard.cardId).portraitKey)
                .setOrigin(0, 0)
                .setDisplaySize(faceRect.w, faceRect.h);
            this.table.add(burn);
            // UIX §6.1's mock labels this panel, and it needs to: an unlabelled
            // card beside the deck reads as a leak rather than as the face-up
            // removal a two-player round always makes (README setup, step 3).
            // "Removed", not "Removed from play": the caption now sets in the
            // band beside the value badge rather than across the whole card,
            // and the longer phrase cannot fit there at a legible size on any
            // real burn panel — `fitOverline` would drop it everywhere. The
            // accessibility twin still announces the full "Removed from play".
            this.table.add(this.cardFaceLabel(plan.removedCard.cardId, faceRect, 'Removed'));
        }

        // UIX §6.1's "own tokens + discards" row. The viewer is filtered out of
        // `seats`, so without this the one player who cannot see their own
        // standing is the player whose standing it is.
        {
            const own = plan.own;
            this.table.add(this.tokenMedallions(own.tokens, own.rect.x, own.rect.y + own.rect.h / 2 - MEDALLION / 2));

            const pipsLeft = own.rect.x + MEDALLION_SPAN;
            const ownPips = own.discardValues.map((value, index) =>
                this.add
                    .text(pipsLeft + index * 18, own.rect.y + own.rect.h / 2, String(value), {
                        fontFamily: 'Inter, sans-serif',
                        fontSize: '13px',
                        color: '#9ca3af'
                    })
                    .setOrigin(0, 0.5)
            );
            this.table.add(ownPips);

            if (own.discardValues.length > 0) {
                const total = this.add
                    .text(own.rect.x + own.rect.w, own.rect.y + own.rect.h / 2, `= ${own.discardTotal}`, {
                        fontFamily: 'Inter, sans-serif',
                        fontSize: '13px',
                        color: '#9ca3af'
                    })
                    .setOrigin(1, 0.5);
                this.table.add(total);
            }
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

            // Value first, always. A hand card carrying only art has to be
            // recognised rather than read, and two portraits in this set are
            // close enough that recognising is not reliable.
            const label = this.cardFaceLabel(card.cardId, card.rect);
            for (const part of label) part.setAlpha(card.dimmed ? 0.5 : 1);
            this.table.add(label);

            if (card.playable) {
                const border = this.add
                    .rectangle(card.rect.x, card.rect.y, card.rect.w, card.rect.h)
                    .setOrigin(0, 0)
                    .setStrokeStyle(2, TOKENS.colorStateYourTurn);
                this.table.add(border);
            }

            {
                /**
                 * A dedicated hit target on EVERY card, not only the playable
                 * ones. Reading what a card does is the most ordinary thing a
                 * player wants, and it is most wanted while waiting for someone
                 * else's turn — which is exactly when `legalPlays` is empty. The
                 * sheet opens read-only; it is `playable` that decides whether
                 * Play is offered, and `legalPlays` that decides `playable`.
                 *
                 * Sized from the LayoutSpec.
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

        // UIX §6.2: the chip carries a card-back marker while the seat holds a
        // card. Its absence on an eliminated seat is information too.
        if (seat.holdsCard) {
            const back = this.add
                .image(seat.rect.x + seat.rect.w - 6, seat.rect.y + 6, TEXTURES.cardBack)
                .setOrigin(1, 0)
                .setDisplaySize(CARD_BACK_H * CARD_ASPECT, CARD_BACK_H);
            this.table.add(back);
        }

        this.table.add(this.tokenMedallions(seat.tokens, seat.rect.x + 6, seat.rect.y + 26));

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

        // UIX §6.3: an eliminated seat's held card is revealed face-up atop
        // their pile. That reveal is core deduction data — the numeric pip
        // already carries the value, and this carries the face.
        if (seat.revealedCard !== null) {
            const revealed = this.add
                .image(seat.rect.x + seat.rect.w - 6, seat.rect.y + seat.rect.h - 6, cardCopyFor(seat.revealedCard).portraitKey)
                .setOrigin(1, 1)
                .setDisplaySize(REVEALED_H * CARD_ASPECT, REVEALED_H);
            this.table.add(revealed);

            // Too small for the full label, and the value is the deduction
            // datum anyway — the pip row beside it already carries the history.
            const value = this.add
                .text(
                    seat.rect.x + seat.rect.w - 6 - REVEALED_H * CARD_ASPECT - 2,
                    seat.rect.y + seat.rect.h - 6,
                    String(cardCopyFor(seat.revealedCard).value),
                    { fontFamily: 'Exo 2, sans-serif', fontSize: '15px', color: '#f5f5f5' }
                )
                .setOrigin(1, 1);
            this.table.add(value);
        }

        // UIX §6.2: tapping a chip opens the seat dossier. A dedicated hit
        // rectangle for the same reason the hand cards use one — a texture-
        // derived hit area disagrees with where the chip actually is.
        const hit = this.add
            .rectangle(seat.rect.x, seat.rect.y, seat.rect.w, seat.rect.h, 0x000000, 0)
            .setOrigin(0, 0)
            .setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => this.events.emit(SEAT_SELECTED, seat.playerId));
        this.table.add(hit);

        // The peek marker (UIX §8.1). Only this viewer sees it, and it persists
        // until the engine stops considering the peek valid — `revealed[]` is
        // recomputed per call, so a card played, traded or redrawn simply stops
        // appearing here. The client mirrors that and decides nothing.
        if (seat.knownCard !== null) {
            // Below the medallion row rather than beside the nickname: the
            // top-right corner now belongs to the card-back marker.
            const known = this.add.text(
                seat.rect.x + 6,
                seat.rect.y + 26 + MEDALLION + 4,
                // Value first, like every other card label on the table. This
                // marker is the standing record of a peek — it outlives the
                // reveal — so it is the one a player actually reads back when
                // deciding a guess, and a name alone makes them recall the
                // number instead of read it.
                `you know: ${cardLabel(seat.knownCard)}`,
                { fontFamily: 'Inter, sans-serif', fontSize: '11px', color: hex(TOKENS.colorSeatProtected) }
            );
            known.setOrigin(0, 0);
            this.table.add(known);
        }

        if (seat.caption !== null) {
            const caption = this.add.text(seat.rect.x + 6, seat.rect.y + seat.rect.h - 16, seat.caption, {
                fontFamily: 'Inter, sans-serif',
                fontSize: '11px',
                color: hex(SEAT_COLOURS[seat.state])
            });
            this.table.add(caption);
        }
    }

    /**
     * A card face's value badge and name (UIX §6.1, and the baseline's
     * value-first rule the design keeps in §1).
     *
     * The badge is a filled corner rather than bare text because it sits on
     * portrait art of unknown brightness, and a numeral that disappears against
     * a light background is the failure this exists to prevent. The name goes
     * along the bottom on a scrim for the same reason.
     */
    private cardFaceLabel(
        cardId: CardTypeId,
        rect: Rect,
        overline?: string
    ): (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] {
        const copy = cardCopyFor(cardId);
        const badge = Math.max(MIN_BADGE, Math.round(Math.min(rect.w, rect.h) * BADGE_FRACTION));

        const plate = this.add
            .rectangle(rect.x, rect.y, badge, badge, TOKENS.colorBg, 0.78)
            .setOrigin(0, 0)
            .setStrokeStyle(1, TOKENS.colorNebulaPurple);

        const value = this.add
            .text(rect.x + badge / 2, rect.y + badge / 2, String(copy.value), {
                fontFamily: 'Exo 2, sans-serif',
                fontSize: `${Math.round(badge * 0.68)}px`,
                color: '#f5f5f5'
            })
            .setOrigin(0.5);

        const nameH = Math.max(MIN_NAME_H, Math.round(rect.h * NAME_FRACTION));
        const scrim = this.add
            .rectangle(rect.x, rect.y + rect.h - nameH, rect.w, nameH, TOKENS.colorBg, 0.72)
            .setOrigin(0, 0);

        const name = this.add
            .text(rect.x + rect.w / 2, rect.y + rect.h - nameH / 2, copy.displayName, {
                fontFamily: 'Inter, sans-serif',
                fontSize: `${Math.round(nameH * 0.52)}px`,
                color: '#f5f5f5',
                align: 'center'
            })
            .setOrigin(0.5);

        // The name gives way before the value does: the value is what every
        // rule in the game is written in.
        if (name.width > rect.w - LABEL_PAD) name.setScale((rect.w - LABEL_PAD) / name.width);

        const parts: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text)[] = [scrim, name];

        // Drawn INSIDE the card rather than above it, so it cannot collide with
        // the deck in either composition — portrait stacks the burn panel under
        // the deck, wide sets it beside. It goes on before the badge, so the
        // value sits over its left end rather than under it.
        if (overline !== undefined) {
            const bandH = Math.max(MIN_NAME_H, Math.round(rect.h * NAME_FRACTION));
            const fontSize = Math.round(bandH * 0.46);

            // The badge owns the top-left corner on every card in the game, and
            // it is drawn last, so anything sharing that corner ends up under
            // it. The caption takes the band to the badge's right and centres
            // itself there — it used to centre on the whole card, which put its
            // first few characters beneath the value and read as clipped.
            const captionLeft = rect.x + badge;
            const captionW = rect.w - badge - LABEL_PAD;

            const caption = this.add
                .text(captionLeft + captionW / 2, rect.y + bandH / 2, overline, {
                    fontFamily: 'Inter, sans-serif',
                    fontSize: `${fontSize}px`,
                    color: hex(TOKENS.colorStateWaiting)
                })
                .setOrigin(0.5);

            // Measured, then judged: only Phaser knows how wide the caption
            // actually set, and `fitOverline` owns what to do about it. The
            // burn panel is the one card that carries a caption and the
            // smallest card on the table, so on a landscape phone the caption
            // ran to twice the card's width — past the rect `computeLayout`
            // proved empty.
            const scale = fitOverline(captionW, caption.width, fontSize);

            if (scale === null) {
                // Nothing legible fits. Destroy rather than leave it parked:
                // `this.add.*` has already put it on the display list.
                caption.destroy();
            } else {
                caption.setScale(scale);
                parts.push(this.add.rectangle(rect.x, rect.y, rect.w, bandH, TOKENS.colorBg, 0.72).setOrigin(0, 0), caption);
            }
        }

        parts.push(plate, value);
        return parts;
    }

    /**
     * Devotion tokens as medallions (UIX §6.2).
     *
     * "Tokens collapse; discards don't." A count of identical items loses
     * nothing as a numeral, so past four this becomes one medallion and a
     * multiplier — the rule that lets discard values stay uncollapsed forever.
     */
    private tokenMedallions(tokens: number, x: number, y: number): Phaser.GameObjects.GameObject[] {
        // `medallionPlan` decides; this only draws what it was told to. Nothing
        // here may be constructed and then dropped: `this.add.*` puts an object
        // on the scene's display list immediately, and `draw()` destroys only
        // what the table container holds — so an abandoned object survives
        // every redraw AND renders above the container that replaced it.
        const plan = medallionPlan(tokens);
        const objects: Phaser.GameObjects.GameObject[] = [];

        for (let index = 0; index < plan.medallions; index++) {
            objects.push(
                this.add
                    .image(x + index * (MEDALLION + 2), y, TEXTURES.devotionToken)
                    .setOrigin(0, 0)
                    .setDisplaySize(MEDALLION, MEDALLION)
            );
        }

        if (plan.countLabel !== null) {
            objects.push(
                this.add
                    .text(x + MEDALLION + 3, y + MEDALLION / 2, plan.countLabel, {
                        fontFamily: 'Inter, sans-serif',
                        fontSize: '12px',
                        color: '#f5f5f5'
                    })
                    .setOrigin(0, 0.5)
            );
        }

        return objects;
    }

    /**
     * Play a cinematic beat and resolve when it has finished (UIX §8.4).
     *
     * The presentation queue awaits this before releasing the announcement, so
     * the accessible channel can never run ahead of the visible one.
     */
    playBeat(beat: Parameters<BeatRunner['run']>[0], context?: Parameters<BeatRunner['run']>[1]): Promise<void> {
        return this.beats.run(beat, context);
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

/** Emitted when a seat chip is tapped. `main.ts` opens the dossier (UIX §6.2). */
export const SEAT_SELECTED = 'seat-selected';

/** Card art is 512×720 (`portraits.ts`), and every card drawn here keeps that ratio. */
const CARD_ASPECT = 512 / 720;

/** The card-back marker on a seat chip, and the face-up reveal on an eliminated one. */
const CARD_BACK_H = 26;
const REVEALED_H = 30;

/** One devotion medallion, and the width the own-status row reserves for them. */
const MEDALLION = 12;
const MEDALLION_SPAN = MEDALLION * 4 + 12;

/** The value badge, as a fraction of the card's short edge, with a legible floor. */
const BADGE_FRACTION = 0.28;
const MIN_BADGE = 22;

/** Breathing room a card's text keeps from its own edges, both sides together. */
const LABEL_PAD = 6;

/** The name strip along the card's bottom edge. */
const NAME_FRACTION = 0.16;
const MIN_NAME_H = 16;

/**
 * How far each face-down removal peeks out past the one in front of it.
 *
 * A fraction of the panel so it scales with the table, with a floor so the
 * edges stay visible as separate cards rather than merging into one thick line.
 */
const SLIVER_STEP_FRACTION = 0.14;
const MIN_SLIVER_STEP = 5;

/**
 * Vertical inset per card of depth, so the hidden cards recede behind the
 * face-up one instead of sharing its exact height. Multiplied by depth: without
 * a per-card difference, two backs of the same texture read as one card.
 */
const SLIVER_INSET = 3;

/** A floor, so a short panel cannot invert the receding inset into a negative. */
const MIN_SLIVER_HEIGHT = 12;

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
