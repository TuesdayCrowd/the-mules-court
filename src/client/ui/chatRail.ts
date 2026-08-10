/**
 * Table talk: one public transcript, and the box to add to it.
 *
 * **It is not a fourth tab in the reference dock**, though it looks like one
 * should be. The dock removes itself from the document on every screen that is
 * not the table, and chat is wanted from the lobby onward; and its `render()`
 * calls `panel.replaceChildren(...)` on every state push, which during a match
 * is every `STATE_UPDATE` — so a composer living inside it would be destroyed,
 * with whatever was half-typed in it, each time a bot played a card.
 *
 * What it does take from the dock is its shape: a labelled `region` rather than
 * a `dialog`, Escape bound to the panel rather than the document, and focus
 * left alone on open. A panel that grabs focus interrupts the game.
 *
 * The transcript **appends**. Only a `CHAT_HISTORY` replacement rebuilds it,
 * detected by `ClientState.chatEpoch` moving — bumped in `store.ts` on
 * `CHAT_HISTORY` and nowhere else. A `seq`-based guess was tried first and
 * fooled by a server restart: `Room.rebuild` re-mints a fresh room's `chatSeq`
 * from zero, so the seeded RESTARTED note can land on the exact seq an
 * already-drawn message held in the room's previous life, and a prefix-of-seqs
 * comparison reads that collision as an ordinary append — silently keeping the
 * stale line on screen and dropping the very note that exists to announce the
 * wipe.
 *
 * Whether the rail is painted or collapsed to its launcher is decided entirely
 * by a media query in `ui.css`. Nothing here asks: `railVisible` is injected by
 * `main.ts`, which reads the computed value of `--chat-rail-w` rather than
 * re-testing the query, so the breakpoint exists in exactly one place.
 */

import {
    CHAT_EMPTY_STATE,
    CHAT_PANEL_TITLE,
    CHAT_PLACEHOLDER,
    CHAT_SEND_FAILED,
    CHAT_SEND_LABEL,
    MAX_CHAT_LENGTH,
    chatLauncherLabel,
    chatNoteMessage,
    chatProblemMessage,
    chatSenderLabel,
    validateChatText
} from '../content/chat';
import type { ChatEntry } from '../../server/protocol';
import type { ClientState } from '../store/types';
import { FOLLOWING, anchorOf, applyAnchor } from './scrollFollow';
import type { Surface } from './surface';

export interface ChatRailDeps {
    /** True when the frame actually left. A refusal keeps the text in the box. */
    readonly onSend: (text: string) => boolean;
    /**
     * Whether the rail is currently painted rather than collapsed.
     *
     * Injected rather than measured here, for the same reason `beats.ts` takes
     * `reducedMotion` injected: a surface may not reach an ambient global, and
     * the answer changes with the viewport so it must be read, never cached.
     */
    readonly railVisible: () => boolean;
}

const TITLE_ID = 'chat-rail-title';

/** The screens chat exists on. Not the menu, and not the nickname prompt: you speak with a seat's name. */
function wanted(screen: ClientState['screen']): boolean {
    return screen === 'lobby' || screen === 'table';
}

export function createChatRail(deps: ChatRailDeps): Surface {
    const container = document.createElement('div');
    container.dataset.role = 'chat-rail-host';

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.dataset.action = 'chat';
    launcher.className = 'chat-launcher';
    launcher.setAttribute('aria-expanded', 'false');

    const launcherText = document.createElement('span');
    // `chatLauncherLabel(0)` already returns exactly this word; calling it
    // rather than writing 'Chat' again keeps the two labels one source.
    launcherText.textContent = chatLauncherLabel(0);

    const badge = document.createElement('span');
    badge.dataset.role = 'chat-badge';
    badge.className = 'chat-badge';
    // The count is already in the button's accessible name, so the glyph itself
    // is decoration — announced twice otherwise, once as a name and once as a
    // stray digit.
    badge.setAttribute('aria-hidden', 'true');
    badge.hidden = true;
    launcher.append(launcherText, badge);

    const panel = document.createElement('section');
    panel.dataset.role = 'chat-rail';
    panel.className = 'chat-rail';
    // A region, not a dialog: it sits beside the game rather than in front of
    // it, and a screen reader announcing a dialog would tell the player their
    // turn had been interrupted.
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', TITLE_ID);

    const title = document.createElement('h2');
    title.id = TITLE_ID;
    title.textContent = CHAT_PANEL_TITLE;

    const transcript = document.createElement('ol');
    transcript.dataset.role = 'chat-transcript';
    transcript.className = 'chat-transcript';
    // The transcript announces itself as it grows; the composer below it does
    // not move, so a reader is never dragged away from what they are typing.
    transcript.setAttribute('aria-live', 'polite');

    const empty = document.createElement('p');
    empty.dataset.role = 'chat-empty';
    empty.textContent = CHAT_EMPTY_STATE;

    const form = document.createElement('form');
    form.dataset.role = 'chat-form';
    form.className = 'chat-form';

    const label = document.createElement('label');
    label.htmlFor = 'chat-input';
    label.className = 'visually-hidden';
    label.textContent = CHAT_PLACEHOLDER;

    const input = document.createElement('input');
    input.id = 'chat-input';
    input.dataset.role = 'chat-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = CHAT_PLACEHOLDER;
    // The server refuses anything longer anyway; stopping it at the field means
    // the player is never told off for a key they already pressed.
    input.maxLength = MAX_CHAT_LENGTH;

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = CHAT_SEND_LABEL;

    const problem = document.createElement('p');
    problem.dataset.role = 'chat-problem';
    problem.className = 'chat-problem';
    problem.setAttribute('role', 'status');

    form.append(label, input, submit);
    panel.append(title, transcript, empty, form, problem);

    /** How many entries are already on screen, so an ordinary push appends only the tail. */
    let drawnCount = 0;
    /**
     * The last `chatEpoch` drawn. `-1` matches no real epoch — the store's
     * starts at 0 — so the very first push always takes the rebuild path,
     * which is harmless against an empty transcript and is what seeds
     * `drawnCount` correctly.
     */
    let drawnEpoch = -1;
    let open = false;
    /** The newest seq the player has been shown. Everything after it is unread. */
    let seenSeq = 0;
    let onScreen = false;
    /**
     * The transcript from the last `update()`, held so `setOpen` can redraw the
     * badge on a bare click.
     *
     * `drawBadge` is what decides what the badge reads, and it needs the
     * current chat to do that — but opening or closing the panel commits
     * nothing to the store, so there is no fresh `state.chat` at that moment,
     * only whatever the most recent push already told this surface.
     */
    let lastChat: readonly ChatEntry[] = [];

    function lineFor(entry: ChatEntry): HTMLElement {
        const item = document.createElement('li');
        item.dataset.role = 'chat-line';
        item.dataset.kind = entry.kind;

        if (entry.kind === 'note') {
            // Copy, not a code: the wire carries `RESTARTED`, the player reads a
            // sentence, and only this layer knows which.
            item.textContent = chatNoteMessage(entry.code);
            return item;
        }

        const who = document.createElement('span');
        who.className = 'chat-who';
        who.textContent = chatSenderLabel(entry);

        const what = document.createElement('span');
        what.className = 'chat-what';
        // textContent, never innerHTML. There is no sanitiser in this repo and
        // there must not need to be one.
        what.textContent = entry.text;

        item.append(who, what);
        return item;
    }

    function drawTranscript(chat: readonly ChatEntry[], epoch: number): void {
        // `chatEpoch` is the wire's own answer to "was this appended or
        // replaced" — see the module doc for why comparing `seq`s instead was
        // wrong.
        const isAppend = epoch === drawnEpoch;

        const anchor = anchorOf(transcript);

        if (!isAppend) {
            // A CHAT_HISTORY replacement. Rebuilding is correct here and only
            // here: the slice is a different conversation, not a longer one.
            transcript.replaceChildren();
            for (const entry of chat) transcript.appendChild(lineFor(entry));
        } else {
            for (const entry of chat.slice(drawnCount)) transcript.appendChild(lineFor(entry));
        }

        drawnCount = chat.length;
        drawnEpoch = epoch;
        empty.hidden = chat.length > 0;
        applyAnchor(transcript, isAppend ? anchor : FOLLOWING);
    }

    function drawBadge(chat: readonly ChatEntry[]): void {
        // Not `chat[chat.length - 1]`: `Room.appendChat` unshifts a TRIMMED
        // note ahead of the message that triggered the eviction but mints its
        // seq after it, so the highest seq can sit at index 0. The maximum
        // across the whole array is the only reading that survives that.
        const newest = chat.reduce((max, entry) => Math.max(max, entry.seq), 0);

        // Being able to see it IS having read it. `railVisible` and `open` are
        // the two ways that happens, and the second is the one a player chooses.
        if (deps.railVisible() || open) seenSeq = newest;

        const unread = chat.reduce((count, entry) => (entry.seq > seenSeq ? count + 1 : count), 0);
        badge.hidden = unread === 0;
        badge.textContent = String(unread);
        launcher.setAttribute('aria-label', chatLauncherLabel(unread));
    }

    function setOpen(next: boolean): void {
        open = next;
        launcher.setAttribute('aria-expanded', String(next));
        container.dataset.open = String(next);
        // Opening IS reading: without this, a badge left over from before the
        // click stays wrong until some unrelated STATE_UPDATE happens to push
        // again — which, in the lobby, can be never. Redrawn from `lastChat`
        // rather than waiting on the next `update()`, because a click commits
        // nothing to the store and there isn't going to be one.
        drawBadge(lastChat);
        // Focus is deliberately left alone, exactly as the reference dock leaves
        // it: taking it on open makes a non-modal panel feel like an
        // interruption, and returning it on close yanks the player out of
        // whatever they moved on to.
    }

    launcher.addEventListener('click', () => setOpen(!open));

    // Bound to the panel rather than the document: a non-modal panel that
    // swallowed every Escape would close itself while the player was cancelling
    // an action sheet somewhere else entirely.
    panel.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).key === 'Escape') setOpen(false);
    });

    form.addEventListener('submit', event => {
        event.preventDefault();

        const validated = validateChatText(input.value);
        if (!validated.ok) {
            problem.textContent = chatProblemMessage(validated.problem);
            return;
        }

        if (!deps.onSend(validated.value)) {
            // The frame did not leave. Keeping the text is the only honest
            // option: clearing it would lose a message the court never heard.
            problem.textContent = CHAT_SEND_FAILED;
            return;
        }

        problem.textContent = '';
        input.value = '';
    });

    setOpen(false);

    return {
        mount(parent) {
            parent.appendChild(container);
        },

        update(state) {
            lastChat = state.chat;

            const showing = wanted(state.screen);

            if (showing !== onScreen) {
                onScreen = showing;
                if (showing) {
                    container.append(panel, launcher);
                } else {
                    panel.remove();
                    launcher.remove();
                    return;
                }
            }

            if (!showing) return;

            drawTranscript(state.chat, state.chatEpoch);
            drawBadge(state.chat);
        },

        destroy() {
            container.remove();
        }
    };
}
