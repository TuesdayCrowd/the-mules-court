/**
 * Mute, in the corner, on every screen.
 *
 * It sits beside the connection dot because that is where this game already
 * keeps its persistent chrome, and because of when a player reaches for it:
 * somebody walks into the room, or a phone is in a quiet carriage, and the
 * sound has to stop *now*. A control that costs a menu, a scroll and a tap
 * fails that moment, and a player who cannot find it in that moment mutes the
 * whole device instead and never comes back.
 *
 * The preference itself belongs to the player (`ui/sound.ts`), not to this
 * button. Two owners of one setting is how a toggle ends up disagreeing with
 * what is audible; this surface only asks and tells.
 *
 * **Default unmuted.** Nothing can sound before the player has interacted with
 * the page — a browser will not start an audio context before a gesture, and
 * `createSoundPlayer` unlocks on the first one rather than any earlier — so
 * there is no ambush to defend against, and defaulting to silence would mean
 * most players never learned the game had a voice.
 */

import { iconElement } from './icons';
import type { SoundControl } from './sound';
import type { Surface } from './surface';

export interface SoundToggleDeps {
    readonly sound: SoundControl;
}

/**
 * Both halves are stated: `aria-pressed` carries the toggle state, and the name
 * says what pressing it will do.
 *
 * A constant name ("Sound") with only `aria-pressed` to distinguish the two
 * states is the usual advice and is wrong here — the button is one glyph in a
 * corner with no adjacent text to fall back on, so the state has to survive
 * being read on its own.
 */
const LABELS = {
    on: 'Sound on. Mute.',
    off: 'Sound muted. Unmute.'
} as const;

export function createSoundToggle(deps: SoundToggleDeps): Surface {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.role = 'sound-toggle';
    button.className = 'sound-toggle';

    /** What the button is currently drawn as, so a redraw only happens on a change. */
    let shown: boolean | null = null;

    function apply(): void {
        const muted = deps.sound.muted();
        if (shown === muted) return;
        shown = muted;

        button.setAttribute('aria-pressed', String(muted));
        // Styling keys on this rather than on the label, so nothing has to parse
        // a sentence to draw a state.
        button.dataset.muted = String(muted);
        button.setAttribute('aria-label', muted ? LABELS.off : LABELS.on);
        button.title = muted ? LABELS.off : LABELS.on;
        button.replaceChildren(iconElement(muted ? 'sound-off' : 'sound-on'));
    }

    button.addEventListener('click', () => {
        deps.sound.setMuted(!deps.sound.muted());
        apply();
    });

    apply();

    return {
        mount(parent) {
            parent.appendChild(button);
        },

        /**
         * Nothing in `ClientState` decides this — the preference is the
         * player's, not the table's. Re-applying anyway keeps the button honest
         * if anything else ever mutes the game, and `apply` is a no-op when the
         * drawn state already matches.
         */
        update() {
            apply();
        },

        destroy() {
            button.remove();
        }
    };
}
