import { Scene } from 'phaser';
import { CARD_CATALOG } from '../engine';
import type { CardTypeId } from '../engine';
import { cardCopyFor } from '../../client/content/cardCopy';
import { CARD_BACK_ASSET, CARD_FRONT_ASSET, portraitPath } from '../../client/content/portraits';
import { TOKENS } from '../../client/tokens/tokens';

/** Texture keys the Court scene looks up. Named here so nothing guesses a string twice. */
export const TEXTURES = {
    playfield: 'playfield',
    cardFront: 'card-front',
    cardBack: 'card-back',
    devotionToken: 'devotion-token',
    distortion: 'shader-distortion',
    sparkle: 'shader-sparkle',
    rainbow: 'shader-rainbow'
} as const;

export class Preloader extends Scene {
    constructor() {
        super('Preloader');
    }

    init() {
        const { width, height } = this.scale.gameSize;

        this.add.image(width / 2, height / 2, TEXTURES.playfield).setAlpha(0.35);

        const barWidth = Math.min(width * 0.6, 460);
        this.add.rectangle(width / 2, height / 2, barWidth, 24).setStrokeStyle(1, TOKENS.colorStateWaiting);
        const bar = this.add.rectangle(width / 2 - barWidth / 2 + 2, height / 2, 4, 20, TOKENS.colorNebulaPurple);
        bar.setOrigin(0, 0.5);

        this.load.on('progress', (progress: number) => {
            bar.width = 4 + (barWidth - 8) * progress;
        });
    }

    preload() {
        // Leading slash is load-bearing — see Boot. A relative path resolves
        // against /join/:matchId and quietly loads index.html as every texture.
        this.load.setPath('/assets');

        // A texture that fails is otherwise invisible: Phaser substitutes its
        // placeholder and carries on, so the table renders in green diagonals
        // with nothing in any log to explain it.
        this.load.on('loaderror', (file: Phaser.Loader.File) => {
            console.error(`[preloader] failed to load ${file.key} from ${file.url}`);
        });

        // Derived from the catalog, never listed: a card added to the engine
        // cannot be forgotten here, because there is no list to forget it from.
        for (const id of Object.keys(CARD_CATALOG) as CardTypeId[]) {
            this.load.image(cardCopyFor(id).portraitKey, portraitPath(id));
        }

        this.load.image(TEXTURES.cardFront, CARD_FRONT_ASSET);
        this.load.image(TEXTURES.cardBack, CARD_BACK_ASSET);
        this.load.image(TEXTURES.devotionToken, 'misc/devotion_token.png');

        // UIX §8.5 assigns each of these to exactly one beat.
        this.load.image(TEXTURES.distortion, 'shaders/distortion_map.png');
        this.load.image(TEXTURES.sparkle, 'shaders/sparkle_pattern.png');
        this.load.image(TEXTURES.rainbow, 'shaders/rainbow_gradient.png');
    }

    async create() {
        // UIX §2.4. Canvas text is painted pixels: created before the face
        // loads, it renders in a fallback and never re-renders itself the way
        // DOM text does. Waiting here is the whole fix.
        await document.fonts.ready;
        this.scene.start('Court');
    }
}
