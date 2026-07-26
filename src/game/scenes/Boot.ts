import { Scene } from 'phaser';

/**
 * Loads only what the Preloader itself needs to draw a loading screen.
 *
 * Boot has no preloader of its own, so anything queued here is an unmeasured
 * wait on a blank canvas — one background, and nothing else.
 */
export class Boot extends Scene {
    constructor() {
        super('Boot');
    }

    preload() {
        this.load.image('playfield', 'assets/misc/playfield_background_space.png');
    }

    create() {
        this.scene.start('Preloader');
    }
}
