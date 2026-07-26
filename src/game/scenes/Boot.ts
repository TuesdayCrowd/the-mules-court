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
        // Absolute, not relative. On /join/:matchId a relative URL resolves to
        // /join/<id>/assets/..., which the SPA fallback answers with index.html
        // and a 200 — so the loader never sees a 404, it just decodes HTML as an
        // image and silently substitutes a missing texture. Same reason Vite's
        // base is '/' rather than './'.
        this.load.image('playfield', '/assets/misc/playfield_background_space.png');
    }

    create() {
        this.scene.start('Preloader');
    }
}
