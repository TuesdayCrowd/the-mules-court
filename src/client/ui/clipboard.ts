/**
 * Copying the invite link, including where the modern API does not exist.
 *
 * `navigator.clipboard` is **secure-context only**. Testing this game means
 * opening it on a phone at `http://<lan-ip>:8080`, where it is simply
 * `undefined` — so the one button whose entire purpose is getting the link onto
 * a second device was the one button that could not work there.
 *
 * `document.execCommand('copy')` is deprecated and still works in exactly that
 * case, which is the whole reason to keep it. It is the fallback, never the
 * first choice.
 *
 * **The fallback must run synchronously inside the click.** Browsers only honour
 * `execCommand('copy')` during a user gesture, so it is attempted immediately
 * rather than after awaiting anything — awaiting first is what would put it
 * outside the gesture and make it fail for a second, subtler reason.
 */

export interface ClipboardLike {
    writeText(text: string): Promise<void>;
}

export interface ClipboardDeps {
    /** `navigator.clipboard` where the context allows it, absent where it does not. */
    readonly clipboard?: ClipboardLike;
    /** `document.execCommand`, injected so the fallback is testable without a real one. */
    readonly exec?: (command: string) => boolean;
}

/**
 * Selects the text in an offscreen field and asks the document to copy it.
 *
 * `readonly` and a fixed, transparent position keep iOS from scrolling to the
 * field or opening a keyboard over it, and `setSelectionRange` is what makes
 * the selection stick on iOS specifically — `select()` alone is ignored there.
 */
function copyViaSelection(text: string, exec: (command: string) => boolean): boolean {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '0';
    field.style.opacity = '0';
    document.body.appendChild(field);

    try {
        field.select();
        field.setSelectionRange(0, text.length);
        return exec('copy');
    } catch {
        return false;
    } finally {
        field.remove();
    }
}

export function createClipboard(deps: ClipboardDeps): ClipboardLike {
    return {
        writeText(text) {
            // Preferred where it exists. A rejection here is a real refusal —
            // a denied permission, say — and the lobby already says so plainly
            // rather than claiming a copy that never happened.
            if (deps.clipboard !== undefined) return deps.clipboard.writeText(text);

            if (deps.exec !== undefined && copyViaSelection(text, deps.exec)) return Promise.resolve();

            return Promise.reject(new Error('no clipboard available'));
        }
    };
}
