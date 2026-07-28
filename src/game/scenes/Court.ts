import { Scene } from 'phaser';
import { buildRenderPlan, medallionPlan } from '../../client/layout/renderPlan';
import type { RenderPlan, SeatPlan } from '../../client/layout/renderPlan';
import { fitOverline } from '../../client/layout/overline';
import { PIP_GAP_PX, computeLayout, pipBlockHeight } from '../../client/layout/tableLayout';
import type { ChipSpec, LayoutSpec, PipSpec, Rect } from '../../client/layout/types';
import type { ClientState } from '../../client/store/types';
import { cardCopyFor, cardLabel } from '../../client/content/cardCopy';
import type { CardTypeId } from '../../game/engine';
import { FONT_DISPLAY, FONT_UI } from '../../client/tokens/fonts';
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
    /**
     * The deck's warning pulse, held so a redraw can stop it.
     *
     * `draw` destroys everything in `this.table`, and a destroyed target ends a
     * tween — but this one is `repeat: -1` and so never completes on its own,
     * which is exactly the shape of leak worth being explicit about.
     */
    private deckPulse: Phaser.Tweens.Tween | null = null;
    /** Matches the predicate the beat runner uses, so the two agree. */
    private reducedMotion: () => boolean = () => false;
    /**
     * The pending long press, if any.
     *
     * One at a time — a second finger starts a new press rather than racing the
     * first — and cleared whenever the table is rebuilt, because the card it
     * was going to describe has just been destroyed.
     */
    private pressTimer: Phaser.Time.TimerEvent | null = null;
    /**
     * Beats currently mid-flight.
     *
     * The render pump asks before it stops the loop, and a beat is the one piece
     * of motion it cannot see for itself: `playBeat` resolves from a tween's
     * completion, and the presentation queue awaits that promise before
     * releasing the next announcement. Sleeping through one stalls the table
     * permanently, so this is counted rather than inferred.
     */
    private beatsInFlight = 0;
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
        this.reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.beats = createBeatRunner(this, this.beatLayer, { reducedMotion: this.reducedMotion });

        this.scale.on('resize', this.onResize, this);

        // Scenes can restart; a listener that outlives one leaks into the next.
        this.events.once('shutdown', () => {
            this.deckPulse?.stop();
            this.deckPulse = null;
            this.pressTimer?.remove();
            this.pressTimer = null;
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
            ),
            this.spec
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
    private draw(plan: RenderPlan, spec: LayoutSpec): void {
        this.deckPulse?.stop();
        this.deckPulse = null;
        // The card a pending press was going to describe is about to be
        // destroyed, and the hint that is up describes a table that no longer
        // exists.
        this.pressTimer?.remove();
        this.pressTimer = null;
        this.events.emit(CARD_HINT_CLEARED);
        this.table.removeAll(true);

        // The pip geometry travels with the seat rather than being read off
        // `this.spec`: the seat drawing needs the size `fitPips` proved fits,
        // and passing it makes that dependency visible instead of ambient.
        for (const seat of plan.seats) this.drawSeat(seat, spec.pip, spec.chip);

        const deck = this.add
            .rectangle(plan.deck.rect.x, plan.deck.rect.y, plan.deck.rect.w, plan.deck.rect.h, plan.deck.colour, 0.85)
            .setOrigin(0, 0);
        const deckCount = this.add
            .text(plan.deck.rect.x + plan.deck.rect.w / 2, plan.deck.rect.y + plan.deck.rect.h / 2, String(plan.deck.count), {
                fontFamily: FONT_DISPLAY,
                fontSize: `${Math.round(plan.deck.rect.h * 0.32)}px`,
                color: '#f5f5f5'
            })
            .setOrigin(0.5);
        this.table.add([deck, deckCount]);

        /**
         * UIX §6.4: the deck warns as it empties — subtle at three cards or
         * fewer, strong at empty, because the showdown is then one play away.
         *
         * `deckPlan` has computed `pulse` since the render plan existed and
         * `renderPlan.test.ts` has asserted all three levels, and nothing ever
         * drew it. The colour changed and the urgency did not, which makes the
         * state colour alone — the one thing UIX §6.3 rules out.
         *
         * Alpha rather than scale: the rect has `origin(0, 0)`, so scaling it
         * would grow the deck down and to the right instead of breathing.
         */
        if (plan.deck.pulse !== 'none' && !this.reducedMotion()) {
            const strong = plan.deck.pulse === 'strong';
            this.deckPulse = this.tweens.add({
                targets: deck,
                alpha: strong ? 0.45 : 0.7,
                duration: strong ? 520 : 900,
                ease: 'Sine.easeInOut',
                yoyo: true,
                repeat: -1
            });
        }

        // The banner is also the one piece of table text with nothing behind
        // it — the deck count has its filled rect, the card value its plate,
        // the card name its scrim, and "Your turn" had bare nebula. That is a
        // second, smaller reason it was hard to read (the first being that it
        // drew at 10px; see `FONT_DISPLAY`). It gets a plate like everything
        // else, sized to the words rather than to the band, so the table does
        // not grow a full-width bar across its middle.
        const bannerCentreX = plan.banner.rect.x + plan.banner.rect.w / 2;
        const bannerCentreY = plan.banner.rect.y + plan.banner.rect.h / 2;
        const banner = this.add
            .text(bannerCentreX, bannerCentreY, plan.banner.text, {
                fontFamily: FONT_DISPLAY,
                fontSize: `${Math.max(MIN_BANNER_PX, Math.round(plan.banner.rect.h * 0.7))}px`,
                color: hex(plan.banner.colour)
            })
            .setOrigin(0.5);

        // Clamped to the band `computeLayout` proved empty: a plate wider than
        // its own rect is the same mistake the burn caption made.
        const bannerPlate = this.add
            .rectangle(
                bannerCentreX,
                bannerCentreY,
                Math.min(banner.width + BANNER_PLATE_PAD * 2, plan.banner.rect.w),
                Math.min(banner.height + BANNER_PLATE_PAD, plan.banner.rect.h),
                TOKENS.colorBg,
                0.72
            )
            .setOrigin(0.5);

        this.table.add([bannerPlate, banner]);

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
            const burnLabel = this.cardFaceLabel(plan.removedCard.cardId, faceRect, 'Removed');
            // Overline first: the badge owns the top-left corner on every card
            // and must sit OVER the caption band's left end, not under it.
            this.table.add(burnLabel.overline);
            this.table.add(burnLabel.parts);
        }

        // UIX §6.1's "own tokens + discards" row. The viewer is filtered out of
        // `seats`, so without this the one player who cannot see their own
        // standing is the player whose standing it is.
        {
            const own = plan.own;
            const medallion = spec.chip.medallion;
            this.table.add(
                this.tokenMedallions(own.tokens, own.rect.x, own.rect.y + own.rect.h / 2 - medallion / 2, medallion)
            );

            // The viewer's own tokens had no hit target at all, unlike every
            // opponent chip. Tapping a token opens the match log at the round it
            // was won in — a token IS a round won, and that round's narration is
            // otherwise unreachable once the next round is dealt.
            this.table.add(this.tokenHitArea(own.rect.x, own.rect.y, spec.ownRow.medallionSpan, own.rect.h, own.playerId));

            /**
             * Each discard as its face plus its value.
             *
             * The row drew bare numerals while a seat chip drew a portrait for
             * the card it revealed — not because the face was unavailable, but
             * because `buildRenderPlan` mapped `{cardId, value}` down to the
             * number one layer above here. It passes the pair through now.
             *
             * Every dimension comes from `spec.ownRow`, which is fitted so all
             * eight possible discards fit the line. This row was the last place
             * the scene still invented geometry, and the tokens-under-the-name
             * bug is what that costs.
             */
            const row = spec.ownRow;
            const facesLeft = own.rect.x + row.medallionSpan;
            const faceTop = own.rect.y + (own.rect.h - row.iconH) / 2;

            own.discards.forEach((discard, index) => {
                const x = facesLeft + index * row.step;

                this.table.add(
                    this.add
                        .image(x, faceTop, cardCopyFor(discard.cardId).portraitKey)
                        .setOrigin(0, 0)
                        .setDisplaySize(row.iconW, row.iconH)
                        .setAlpha(0.85)
                );

                // The value stays. A face has to be recognised; a numeral is
                // read, and every rule in the game is written in the numeral —
                // the same reason a hand card carries both.
                const plate = this.add
                    .rectangle(x, faceTop + row.iconH, row.iconW, row.valuePx + 2, TOKENS.colorBg, 0.72)
                    .setOrigin(0, 1);
                const value = this.add
                    .text(x + row.iconW / 2, faceTop + row.iconH - 1, String(discard.value), {
                        fontFamily: FONT_DISPLAY,
                        fontSize: `${row.valuePx}px`,
                        color: '#f5f5f5'
                    })
                    .setOrigin(0.5, 1);

                // Hint-only: a discard is history, so there is nothing to tap.
                // It is also the card most worth explaining, because unlike a
                // hand card it has no action sheet to open.
                const hit = this.add
                    .rectangle(x, faceTop, row.iconW, row.iconH, 0x000000, 0)
                    .setOrigin(0, 0)
                    .setInteractive({ useHandCursor: true });
                this.attachCardGesture(hit, discard.cardId);

                this.table.add([plate, value, hit]);
            });

            if (own.discards.length > 0) {
                const total = this.add
                    .text(own.rect.x + own.rect.w, own.rect.y + own.rect.h / 2, `= ${own.discardTotal}`, {
                        fontFamily: FONT_UI,
                        fontSize: `${row.valuePx}px`,
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

            /**
             * Value first, always — plus, on a dimmed card, why it is dimmed.
             *
             * `dimCaption` computed that sentence, `renderPlan.test.ts` asserted
             * it, and nothing ever drew it; the comment above claimed otherwise.
             * A player holding The First Speaker beside a Darell watched the
             * Darell fade with no explanation anywhere on the table.
             *
             * It rides the card's own overline band rather than floating above
             * the card: the gap over the hand is `0.012 × height` and a plate
             * there would sit on the own-status row.
             */
            const label = this.cardFaceLabel(card.cardId, card.rect, card.caption ?? undefined);

            // Overline first, so the value badge lands over its left end — and
            // at full opacity, because it is the reason for the dimming and
            // fading it hides the one thing the player needs to read.
            this.table.add(label.overline);

            for (const part of label.parts) part.setAlpha(card.dimmed ? 0.5 : 1);
            this.table.add(label.parts);

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
                this.attachCardGesture(hit, card.cardId, () =>
                    this.events.emit(CARD_SELECTED, card.cardInstanceId)
                );
                this.table.add(hit);
            }
        }
    }

    private drawSeat(seat: SeatPlan, pip: PipSpec, chip: ChipSpec): void {
        const border = this.add
            .rectangle(seat.rect.x, seat.rect.y, seat.rect.w, seat.rect.h)
            .setOrigin(0, 0)
            .setStrokeStyle(2, SEAT_COLOURS[seat.state]);
        // Eliminated seats dim; nothing else does. The skull and the caption
        // carry the same fact in shape and in words.
        border.setAlpha(seat.state === 'eliminated' ? 0.5 : 1);

        // Every offset below comes from `chip`, and none of them is a literal.
        // The nickname scaled with the chip while the token row sat at a fixed
        // `y + 26`, so on anything larger than a phone the name's scrim was
        // painted straight over the devotion tokens — `computeLayout` now
        // budgets the bands and `tableLayout.test.ts` sweeps every viewport to
        // prove they stay apart. Re-deriving any of it here is what would put
        // the bug back, exactly as this method once did with the pip packing.
        const name = this.add.text(seat.rect.x + chip.pad, seat.rect.y + chip.pad, seat.nickname, {
            fontFamily: FONT_UI,
            fontSize: `${chip.nameH}px`,
            color: '#f5f5f5'
        });

        // The chip's own border is stroke-only, so the nickname and the discard
        // values sit straight on the nebula. They get scrims — but sized to the
        // text, not to the chip. A two-player table gives one opponent the full
        // width of the screen, and a full-width scrim there is a black bar
        // across the table rather than a legibility aid.
        const nameScrim = this.add
            .rectangle(seat.rect.x, seat.rect.y, name.width + chip.pad * 2, chip.nameBandH, TOKENS.colorBg, 0.6)
            .setOrigin(0, 0);

        // UIX §6.2: the chip carries a card-back marker while the seat holds a
        // card. Its absence on an eliminated seat is information too.
        if (seat.holdsCard) {
            const back = this.add
                .image(seat.rect.x + seat.rect.w - chip.pad, seat.rect.y + chip.pad, TEXTURES.cardBack)
                .setOrigin(1, 0)
                .setDisplaySize(CARD_BACK_H * CARD_ASPECT, CARD_BACK_H);
            this.table.add(back);
        }

        this.table.add(
            this.tokenMedallions(seat.tokens, seat.rect.x + chip.pad, seat.rect.y + chip.tokenTop, chip.medallion)
        );

        // Interface rule 7: every value, never a truncation. The pip geometry
        // was sized for the worst case the engine can actually produce — and
        // now this actually uses it. It used to reinvent the packing here with
        // its own 18px step and a hardcoded 12px, so `fitPips`'s search for a
        // size that provably fits was computed, returned, and thrown away. The
        // comment claimed a guarantee the code was not honouring.
        const pipStep = pip.size + PIP_GAP_PX;
        const pipBlockH = pipBlockHeight(pip);
        const pipsTop = seat.rect.y + chip.pipTop;

        // Only as wide as the values it backs, and absent entirely when the
        // seat has discarded nothing — an empty scrim is a bar over the art
        // saying nothing.
        const pipsAcross = Math.min(seat.discardValues.length, pip.perRow);
        const pipScrims =
            pipsAcross === 0
                ? []
                : [
                      this.add
                          .rectangle(seat.rect.x, pipsTop - 4, pipsAcross * pipStep + chip.pad * 2, pipBlockH + 10, TOKENS.colorBg, 0.6)
                          .setOrigin(0, 0)
                  ];

        const pips = seat.discardValues.map((value, index) =>
            this.add.text(
                seat.rect.x + chip.pad + (index % pip.perRow) * pipStep,
                pipsTop + Math.floor(index / pip.perRow) * pipStep,
                String(value),
                { fontFamily: FONT_UI, fontSize: `${pip.size}px`, color: '#9ca3af' }
            )
        );

        this.table.add([nameScrim, ...pipScrims, border, name, ...pips]);

        // UIX §6.3: an eliminated seat's held card is revealed face-up atop
        // their pile. That reveal is core deduction data — the numeric pip
        // already carries the value, and this carries the face.
        if (seat.revealedCard !== null) {
            const revealed = this.add
                .image(seat.rect.x + seat.rect.w - chip.pad, seat.rect.y + seat.rect.h - chip.pad, cardCopyFor(seat.revealedCard).portraitKey)
                .setOrigin(1, 1)
                .setDisplaySize(REVEALED_H * CARD_ASPECT, REVEALED_H);
            this.table.add(revealed);

            // Too small for the full label, and the value is the deduction
            // datum anyway — the pip row beside it already carries the history.
            const value = this.add
                .text(
                    seat.rect.x + seat.rect.w - chip.pad - REVEALED_H * CARD_ASPECT - 2,
                    seat.rect.y + seat.rect.h - chip.pad,
                    String(cardCopyFor(seat.revealedCard).value),
                    { fontFamily: FONT_DISPLAY, fontSize: '15px', color: '#f5f5f5' }
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

        /**
         * The revealed card gets its own gesture, added AFTER the chip-wide
         * rect so it wins the hit test — Phaser picks the topmost interactive
         * object, and added first it would never see a pointer at all.
         *
         * It still opens the dossier on a tap, because tapping anywhere on a
         * chip always has. Only the hover is new.
         */
        if (seat.revealedCard !== null) {
            const revealedHit = this.add
                .rectangle(
                    seat.rect.x + seat.rect.w - chip.pad - REVEALED_H * CARD_ASPECT,
                    seat.rect.y + seat.rect.h - chip.pad - REVEALED_H,
                    REVEALED_H * CARD_ASPECT,
                    REVEALED_H,
                    0x000000,
                    0
                )
                .setOrigin(0, 0)
                .setInteractive({ useHandCursor: true });
            this.attachCardGesture(revealedHit, seat.revealedCard, () =>
                this.events.emit(SEAT_SELECTED, seat.playerId)
            );
            this.table.add(revealedHit);
        }

        // Added AFTER the chip-wide rect so it wins the hit test: Phaser picks
        // the topmost interactive object, and this one is inside the other.
        this.table.add(
            this.tokenHitArea(
                seat.rect.x + chip.pad,
                seat.rect.y + chip.tokenTop,
                Math.min(seat.rect.w - chip.pad * 2, chip.medallion * 5),
                chip.medallion,
                seat.playerId
            )
        );

        // The peek marker (UIX §8.1). Only this viewer sees it, and it persists
        // until the engine stops considering the peek valid — `revealed[]` is
        // recomputed per call, so a card played, traded or redrawn simply stops
        // appearing here. The client mirrors that and decides nothing.
        if (seat.knownCard !== null) {
            // Value first, like every other card label on the table. This marker
            // is the standing record of a peek — it outlives the reveal — so it
            // is the one a player actually reads back when deciding a guess, and
            // a name alone makes them recall the number instead of read it.
            this.chipLine(
                seat,
                chip,
                chip.markerTop,
                `you know: ${cardLabel(seat.knownCard)}`,
                hex(TOKENS.colorSeatProtected)
            );
        }

        /**
         * The seat's state, in words (UIX §6.3 — never colour alone).
         *
         * Drawn from `chip.captionTop`, which is budgeted between the marker and
         * the pips. It used to sit at a literal `rect.h - 16` while the pip block
         * was measured up from the bottom edge, so it landed inside the discard
         * values at every viewport — reported as "the text for being protected is
         * drawn over the same area of an opponent's discard".
         */
        if (seat.caption !== null) {
            this.chipLine(seat, chip, chip.captionTop, seat.caption, hex(SEAT_COLOURS[seat.state]));
        }
    }

    /**
     * One small labelled line inside a seat chip, on its own scrim.
     *
     * Both callers previously drew bare text at a fixed 11px. The nickname and
     * the pips have carried scrims for a while — the chip's border is
     * stroke-only, so anything without one sits straight on the nebula — and
     * these two were the last table text that did not.
     *
     * Scrim sized to the text rather than the chip, for the reason the nickname's
     * is: a two-player table gives one opponent the full width of the screen, and
     * a full-width bar there is a black stripe across the table rather than a
     * legibility aid.
     */
    private chipLine(seat: SeatPlan, chip: ChipSpec, top: number, text: string, colour: string): void {
        const y = seat.rect.y + top;

        const label = this.add
            .text(seat.rect.x + chip.pad, y, text, {
                fontFamily: FONT_UI,
                fontSize: `${chip.smallPx}px`,
                color: colour
            })
            .setOrigin(0, 0);

        // Measured, then clamped. Only Phaser knows how wide a string actually
        // set, and a chip is `contentW / opponentCount` — narrow enough that a
        // state caption used to run off its right edge.
        const room = seat.rect.w - chip.pad * 2;
        if (label.width > room) label.setScale(room / label.width);

        const scrim = this.add
            .rectangle(seat.rect.x, y - 1, label.displayWidth + chip.pad * 2, chip.smallH, TOKENS.colorBg, 0.6)
            .setOrigin(0, 0);

        // Scrim first: it is a backdrop, and added second it would cover the
        // text it exists to make readable.
        this.table.add([scrim, label]);
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
    ): FaceLabel {
        const copy = cardCopyFor(cardId);
        const badge = Math.max(MIN_BADGE, Math.round(Math.min(rect.w, rect.h) * BADGE_FRACTION));

        const plate = this.add
            .rectangle(rect.x, rect.y, badge, badge, TOKENS.colorBg, 0.78)
            .setOrigin(0, 0)
            .setStrokeStyle(1, TOKENS.colorNebulaPurple);

        const value = this.add
            .text(rect.x + badge / 2, rect.y + badge / 2, String(copy.value), {
                fontFamily: FONT_DISPLAY,
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
                fontFamily: FONT_UI,
                fontSize: `${Math.round(nameH * 0.52)}px`,
                color: '#f5f5f5',
                align: 'center'
            })
            .setOrigin(0.5);

        // The name gives way before the value does: the value is what every
        // rule in the game is written in.
        if (name.width > rect.w - LABEL_PAD) name.setScale((rect.w - LABEL_PAD) / name.width);

        const parts: FacePart[] = [scrim, name];
        // Returned apart from `parts` so a caller can hold it to a different
        // opacity: on a dimmed hand card the overline IS the reason for the
        // dimming, and fading it hides the one thing worth reading.
        const overlineParts: FacePart[] = [];

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
                    fontFamily: FONT_UI,
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
                overlineParts.push(
                    this.add.rectangle(rect.x, rect.y, rect.w, bandH, TOKENS.colorBg, 0.72).setOrigin(0, 0),
                    caption
                );
            }
        }

        parts.push(plate, value);
        return { parts, overline: overlineParts };
    }

    /**
     * Devotion tokens as medallions (UIX §6.2).
     *
     * "Tokens collapse; discards don't." A count of identical items loses
     * nothing as a numeral, so past four this becomes one medallion and a
     * multiplier — the rule that lets discard values stay uncollapsed forever.
     */
    private tokenMedallions(
        tokens: number,
        x: number,
        y: number,
        size: number
    ): Phaser.GameObjects.GameObject[] {
        // `medallionPlan` decides; this only draws what it was told to. Nothing
        // here may be constructed and then dropped: `this.add.*` puts an object
        // on the scene's display list immediately, and `draw()` destroys only
        // what the table container holds — so an abandoned object survives
        // every redraw AND renders above the container that replaced it.
        const plan = medallionPlan(tokens);
        const objects: Phaser.GameObjects.GameObject[] = [];
        const step = size + MEDALLION_GAP;

        for (let index = 0; index < plan.medallions; index++) {
            objects.push(
                this.add
                    .image(x + index * step, y, TEXTURES.devotionToken)
                    .setOrigin(0, 0)
                    .setDisplaySize(size, size)
            );
        }

        if (plan.countLabel !== null) {
            objects.push(
                this.add
                    .text(x + step, y + size / 2, plan.countLabel, {
                        fontFamily: FONT_UI,
                        // Sized from the medallion beside it, so the multiplier
                        // cannot dwarf the token it multiplies on a large chip.
                        fontSize: `${Math.max(11, Math.round(size * 0.9))}px`,
                        color: '#f5f5f5'
                    })
                    .setOrigin(0, 0.5)
            );
        }

        return objects;
    }

    /**
     * Hover and long-press on one card's hit area.
     *
     * **Hover is an enhancement, never a dependency** (UIX §349). Every sentence
     * it shows is already reachable by tapping the card or opening the dock, so
     * a touch device loses nothing — and gains the long press, which is the same
     * affordance for a player with no pointer.
     *
     * The hint itself is DOM. Nothing about it may be stored on a Phaser object:
     * `draw` destroys every one of them on each `STATE_UPDATE`, so hover state
     * held here would have its owner deleted mid-gesture the moment an opponent
     * plays a card.
     *
     * `onTap` fires on pointer**up**, not down. A long press has to be able to
     * decide the gesture was not a tap, and it cannot do that after the tap has
     * already been dispatched — which is what firing on pointerdown meant. It is
     * also better tap semantics: a press that slides off the card no longer
     * counts as choosing it.
     */
    private attachCardGesture(
        hit: Phaser.GameObjects.Rectangle,
        cardId: CardTypeId,
        onTap?: () => void
    ): void {
        let pressedAt: { x: number; y: number } | null = null;
        let longPressed = false;

        const cancelTimer = (): void => {
            this.pressTimer?.remove();
            this.pressTimer = null;
        };

        hit.on('pointerover', (pointer: Phaser.Input.Pointer) => {
            // A touch "hover" is really the finger already down; the long press
            // owns that case, and honouring both makes a tap flash a hint.
            if (pointer.wasTouch) return;
            this.events.emit(CARD_HINTED, cardId, { x: pointer.x, y: pointer.y });
        });

        hit.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            if (pointer.wasTouch) {
                // Sliding a finger is a scroll or a mis-aim, not a press.
                if (pressedAt !== null && Phaser.Math.Distance.BetweenPoints(pointer, pressedAt) > MOVE_CANCEL_PX) {
                    cancelTimer();
                    pressedAt = null;
                }
                return;
            }
            this.events.emit(CARD_HINTED, cardId, { x: pointer.x, y: pointer.y });
        });

        hit.on('pointerout', () => {
            cancelTimer();
            pressedAt = null;
            this.events.emit(CARD_HINT_CLEARED);
        });

        hit.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            pressedAt = { x: pointer.x, y: pointer.y };
            longPressed = false;
            cancelTimer();

            this.pressTimer = this.time.delayedCall(LONG_PRESS_MS, () => {
                this.pressTimer = null;
                if (pressedAt === null) return;
                longPressed = true;
                this.events.emit(CARD_HINTED, cardId, pressedAt);
            });
        });

        hit.on('pointerup', () => {
            cancelTimer();
            const wasTap = pressedAt !== null && !longPressed;
            pressedAt = null;
            // A long press showed the hint; dispatching the tap as well would
            // open the sheet over the thing the player pressed to read.
            if (wasTap) onTap?.();
        });
    }

    /**
     * A tap target over a run of devotion medallions.
     *
     * Built from the same numbers that placed the medallions, for the reason
     * every hit rect here is a rectangle rather than `setInteractive()` on the
     * art: a texture-derived hit area disagrees with where the thing appears the
     * moment its texture fails to load.
     */
    private tokenHitArea(x: number, y: number, w: number, h: number, playerId: string): Phaser.GameObjects.GameObject {
        const hit = this.add
            .rectangle(x, y, Math.max(1, w), Math.max(1, h), 0x000000, 0)
            .setOrigin(0, 0)
            .setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => this.events.emit(TOKENS_SELECTED, playerId));
        return hit;
    }

    /**
     * Play a cinematic beat and resolve when it has finished (UIX §8.4).
     *
     * The presentation queue awaits this before releasing the announcement, so
     * the accessible channel can never run ahead of the visible one.
     */
    playBeat(beat: Parameters<BeatRunner['run']>[0], context?: Parameters<BeatRunner['run']>[1]): Promise<void> {
        this.beatsInFlight++;
        // `finally`, not `then`: a beat that throws must still release the
        // counter, or the loop never sleeps again for the rest of the session.
        return this.beats.run(beat, context).finally(() => {
            this.beatsInFlight--;
        });
    }

    /**
     * Whether anything on this scene is still moving.
     *
     * Read by the render pump before it stops the loop. Every source of motion
     * is named explicitly rather than guessed at, because the cost of a false
     * negative is a frozen table and the cost of a false positive is a few
     * wasted frames.
     */
    isAnimating(): boolean {
        return this.beatsInFlight > 0 || this.pressTimer !== null || this.tweens.getTweens().length > 0;
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

/**
 * Emitted when a run of devotion medallions is tapped, on any seat including the
 * viewer's own. `main.ts` opens the match log at the round that token was won in.
 */
export const TOKENS_SELECTED = 'tokens-selected';

/**
 * A card wants its ability shown — pointer hover, or a long press on touch.
 * Carries viewport coordinates, because the hint is a DOM surface.
 */
export const CARD_HINTED = 'card-hinted';

/** The hint should go away. */
export const CARD_HINT_CLEARED = 'card-hint-cleared';

type FacePart = Phaser.GameObjects.Rectangle | Phaser.GameObjects.Text;

/**
 * A drawn card face, with its overline kept apart from the rest.
 *
 * They are separated because callers treat them differently on both axes: the
 * overline goes on FIRST so the value badge lands over its left end, and it
 * keeps full opacity on a dimmed card because it is what explains the dimming.
 */
interface FaceLabel {
    readonly parts: FacePart[];
    /** Empty unless an overline was asked for and something legible fit. */
    readonly overline: FacePart[];
}

/** Card art is 512×720 (`portraits.ts`), and every card drawn here keeps that ratio. */
const CARD_ASPECT = 512 / 720;

/** The card-back marker on a seat chip, and the face-up reveal on an eliminated one. */
const CARD_BACK_H = 26;
const REVEALED_H = 30;

/**
 * The gap between two medallions. The medallion's own size is
 * `LayoutSpec.chip.medallion`, which scales with the table — a flat 12px was
 * right for a phone and lost on a monitor, the same complaint the pips had.
 *
 * Kept in step with `tableLayout.ts`'s own constant of the same name, which is
 * what `ownRow.medallionSpan` is measured with.
 */
const MEDALLION_GAP = 2;

/**
 * How long a finger must rest on a card before it reads as "tell me about this"
 * rather than "play this". Long enough not to fire on a deliberate tap, short
 * enough that a player who is waiting does not give up first.
 */
const LONG_PRESS_MS = 450;

/** A press that travels this far was a scroll or a mis-aim, not a press. */
const MOVE_CANCEL_PX = 10;

/** The value badge, as a fraction of the card's short edge, with a legible floor. */
const BADGE_FRACTION = 0.28;
const MIN_BADGE = 22;

/** Breathing room a card's text keeps from its own edges, both sides together. */
const LABEL_PAD = 6;

/**
 * Floors and fractions for the table text that carries no card behind it.
 *
 * The turn banner and the seat chips were the only on-table text drawn against
 * bare nebula — every other label has a plate, a scrim or a filled rect under
 * it. They now do too, and the sizes below scale with the rect they sit in
 * rather than being pinned to a phone's pixel count.
 */
const MIN_BANNER_PX = 20;
const BANNER_PLATE_PAD = 14;

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
