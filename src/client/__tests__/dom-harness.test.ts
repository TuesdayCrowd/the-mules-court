// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

/**
 * Proves the per-file jsdom opt-in works. Vitest 4 removed `environmentMatchGlobs`,
 * so the docblock above is how a DOM-touching test file chooses its environment;
 * everything else in `src/client` stays on the Node default.
 *
 * Storage is deliberately absent from this test. Node 26 defines its own
 * `localStorage` global, which is `undefined` unless the process is started with
 * `--localstorage-file`, and that pre-existing global shadows the one jsdom would
 * otherwise install (under Vitest, `window` *is* `globalThis`). No client module
 * reads that global anyway: web storage arrives as an injected `KeyValueStore`,
 * so the gap is invisible to production code and a polyfill would be machinery
 * kept alive by a single assertion.
 */
describe('jsdom environment', () => {
    it('provides a document that real DOM operations work against', () => {
        document.body.innerHTML = '<div id="ui-root"></div>';
        expect(document.getElementById('ui-root')).not.toBeNull();
    });

    it('supports the element APIs the DOM layer is built from', () => {
        const button = document.createElement('button');
        button.textContent = 'Take a seat';
        button.setAttribute('aria-describedby', 'why');
        document.body.append(button);

        expect(document.querySelector('button')?.textContent).toBe('Take a seat');
        expect(button.getAttribute('aria-describedby')).toBe('why');
        expect(button.matches('button')).toBe(true);
    });
});
