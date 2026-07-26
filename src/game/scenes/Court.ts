import { Scene } from 'phaser';
import { computeLayout } from '../../client/layout/tableLayout';
import type { LayoutSpec } from '../../client/layout/types';
import type { ClientState } from '../../client/store/types';
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

/** Long enough to ride out a toolbar collapse, short enough to feel immediate. */
const RESIZE_DEBOUNCE_MS = 100;
