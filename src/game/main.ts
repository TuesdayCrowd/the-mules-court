import { AUTO, Game, Scale } from 'phaser';
import { Boot } from './scenes/Boot';
import { Court } from './scenes/Court';
import { POINTER_POLICY } from './inputPolicy';
import { Preloader } from './scenes/Preloader';

/**
 * The game config (UIX §2.2, §2.5).
 *
 * `Scale.RESIZE` with no design resolution: the canvas fills its parent 1:1, so
 * there is no letterboxing and no coordinate system to translate through. Every
 * position comes from `src/client/layout/`, computed against the live viewport —
 * which is only coherent if the canvas *is* that viewport.
 *
 * Three scenes, not five. `MainMenu` and `GameOver` are DOM surfaces now, in
 * `src/client/ui/`, and an empty Phaser scene behind each would be dead weight.
 * `Court` is the only gameplay scene; between matches it idles as the ambient
 * nebula behind the DOM screens.
 */
const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    parent: 'game-container',
    backgroundColor: '#000000',
    scale: {
        mode: Scale.RESIZE,
        // No centring. With RESIZE the canvas already fills the parent, and a
        // centring margin would offset it away from the very coordinates the
        // layout computed against that same parent.
        autoCenter: Scale.NO_CENTER,
        width: '100%',
        height: '100%'
    },
    // Phaser hears only what lands on its own canvas. See POINTER_POLICY:
    // the default makes a tap on the DOM layer hit-test the table beneath it.
    input: POINTER_POLICY,
    scene: [Boot, Preloader, Court]
};

const StartGame = (parent: string) => {
    return new Game({ ...config, parent });
};

export default StartGame;
