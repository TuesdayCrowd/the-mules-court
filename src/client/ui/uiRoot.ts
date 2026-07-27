/**
 * The DOM half of the two-layer architecture (UIX §2).
 *
 * Holds `#ui-root` and the surfaces mounted into it. The one structural rule it
 * enforces is that every surface is a **direct child**: `ui.css` restores
 * `pointer-events: auto` with `#ui-root > *`, so a surface buried inside a
 * wrapper would silently stop taking taps. `pointer-events` inherits, so a
 * direct child covers everything nested inside it — surfaces may nest freely.
 */

import type { ClientState } from '../store/types';
import type { Surface } from './surface';

export interface UiRoot {
    readonly element: HTMLElement;
    add(surface: Surface): void;
    update(state: ClientState): void;
    destroy(): void;
}

export function createUiRoot(element: HTMLElement): UiRoot {
    let surfaces: Surface[] = [];

    return {
        element,

        add(surface) {
            surfaces.push(surface);
            surface.mount(element);
        },

        update(state) {
            for (const surface of surfaces) {
                try {
                    surface.update(state);
                } catch {
                    // One surface failing to render must not stop the rest. The
                    // connection dot in particular has to keep reporting a
                    // dropped socket even when the table below it cannot draw.
                }
            }
        },

        destroy() {
            for (const surface of surfaces) surface.destroy();
            surfaces = [];
            element.replaceChildren();
        }
    };
}
