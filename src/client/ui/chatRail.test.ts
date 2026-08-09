// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ChatEntry } from '../../server/protocol';
import { makeState, makeUiRootElement } from './__fixtures__/dom';
import { createChatRail } from './chatRail';

const said = (seq: number, text: string, nickname: string | null = 'Ana'): ChatEntry => ({
    seq,
    sentAt: 1_000 + seq,
    kind: 'said',
    from: 'p2',
    nickname,
    text
});

function mount(onSend: (text: string) => boolean = () => true, railVisible = () => false) {
    const root = makeUiRootElement();
    const rail = createChatRail({ onSend, railVisible });
    rail.mount(root);
    return { root, rail };
}

const lines = (root: HTMLElement) => [...root.querySelectorAll('[data-role="chat-line"]')].map(el => el.textContent ?? '');
const launcher = (root: HTMLElement) => root.querySelector('[data-action="chat"]') as HTMLButtonElement;
const input = (root: HTMLElement) => root.querySelector('[data-role="chat-input"]') as HTMLInputElement;
const badge = (root: HTMLElement) => root.querySelector('[data-role="chat-badge"]') as HTMLElement;

describe('the transcript', () => {
    it('renders a line per entry, named by its speaker', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'hello'), said(2, 'again')] }));

        expect(lines(root)).toHaveLength(2);
        expect(lines(root)[0]).toContain('Ana');
        expect(lines(root)[0]).toContain('hello');
    });

    it('falls back to a seat label when a speaker has no nickname', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'hi', null)] }));

        expect(lines(root)[0]).toContain('Seat 2');
    });

    it('renders a note as copy rather than as a code', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [{ seq: 1, sentAt: 1, kind: 'note', code: 'RESTARTED' }] }));

        expect(lines(root)[0]).toContain('restarted');
        expect(lines(root)[0]).not.toContain('RESTARTED');
    });

    it('appends rather than rebuilding, so an existing line keeps its element', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'one')] }));
        const first = root.querySelector('[data-role="chat-line"]');

        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'one'), said(2, 'two')] }));

        expect(root.querySelector('[data-role="chat-line"]')).toBe(first);
        expect(lines(root)).toHaveLength(2);
    });

    it('rebuilds when history replaces the slice', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(9, 'stale')] }));
        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'fresh')] }));

        expect(lines(root)).toHaveLength(1);
        expect(lines(root)[0]).toContain('fresh');
    });

    it('writes text through textContent, so markup is never parsed', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [said(1, '<b>bold</b>')] }));

        expect(root.querySelector('[data-role="chat-line"] b')).toBeNull();
        expect(lines(root)[0]).toContain('<b>bold</b>');
    });
});

describe('the composer', () => {
    it('survives an update with its text intact', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [] }));
        input(root).value = 'half a th';

        rail.update(makeState({ screen: 'lobby', chat: [said(1, 'someone else')] }));

        expect(input(root).value).toBe('half a th');
    });

    it('sends on submit and clears', () => {
        const onSend = vi.fn(() => true);
        const { root, rail } = mount(onSend);
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        input(root).value = 'hello';
        (root.querySelector('[data-role="chat-form"]') as HTMLFormElement).requestSubmit();

        expect(onSend).toHaveBeenCalledWith('hello');
        expect(input(root).value).toBe('');
    });

    it('keeps the text when the send is refused', () => {
        const { root, rail } = mount(() => false);
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        input(root).value = 'hello';
        (root.querySelector('[data-role="chat-form"]') as HTMLFormElement).requestSubmit();

        expect(input(root).value).toBe('hello');
    });

    it('explains a refusal it can make itself, and sends nothing', () => {
        const onSend = vi.fn(() => true);
        const { root, rail } = mount(onSend);
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        input(root).value = 'nope \u{1F600}';
        (root.querySelector('[data-role="chat-form"]') as HTMLFormElement).requestSubmit();

        expect(onSend).not.toHaveBeenCalled();
        expect((root.querySelector('[data-role="chat-problem"]') as HTMLElement).textContent).toContain('emoji');
    });
});

describe('the badge', () => {
    it('counts what arrived while the panel was shut', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one'), said(2, 'two')] }));

        expect(badge(root).textContent).toBe('2');
        expect(launcher(root).getAttribute('aria-label')).toBe('Chat, 2 unread messages');
    });

    it('clears when the player opens the panel, and stays clear', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one')] }));
        launcher(root).click();
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one')] }));

        expect(badge(root).hidden).toBe(true);
        expect(launcher(root).getAttribute('aria-label')).toBe('Chat');
    });

    it('never counts while the rail is painted, because it is already being read', () => {
        const { root, rail } = mount(() => true, () => true);
        rail.update(makeState({ screen: 'table', chat: [said(1, 'one'), said(2, 'two')] }));

        expect(badge(root).hidden).toBe(true);
    });

    it('does not count the players own arrival back into an empty match', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [] }));

        expect(badge(root).hidden).toBe(true);
    });
});

describe('presence', () => {
    it('shows nothing on the menu or the join screen', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'menu', chat: [] }));
        expect(launcher(root)).toBeNull();

        rail.update(makeState({ screen: 'joining', chat: [] }));
        expect(launcher(root)).toBeNull();
    });

    it('appears in the lobby and stays through the table', () => {
        const { root, rail } = mount();
        rail.update(makeState({ screen: 'lobby', chat: [] }));
        expect(launcher(root)).not.toBeNull();

        rail.update(makeState({ screen: 'table', chat: [] }));
        expect(launcher(root)).not.toBeNull();
    });
});
