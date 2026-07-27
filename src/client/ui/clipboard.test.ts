// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createClipboard } from './clipboard';

const LINK = 'http://192.168.68.69:8080/join/K7QX2';

describe('when the modern API exists', () => {
    it('uses it', async () => {
        const written: string[] = [];
        const clipboard = createClipboard({ clipboard: { writeText: t => (written.push(t), Promise.resolve()) } });

        await clipboard.writeText(LINK);

        expect(written).toEqual([LINK]);
    });

    it('never falls back after it, since a rejection there is a real refusal', async () => {
        let execCalls = 0;
        const clipboard = createClipboard({
            clipboard: { writeText: () => Promise.reject(new Error('denied')) },
            exec: () => (execCalls++, true)
        });

        await expect(clipboard.writeText(LINK)).rejects.toThrow('denied');
        expect(execCalls).toBe(0);
    });
});

describe('when the modern API is missing — http on a LAN address', () => {
    it('copies through the selection fallback', async () => {
        const commands: string[] = [];
        const clipboard = createClipboard({ exec: cmd => (commands.push(cmd), true) });

        await expect(clipboard.writeText(LINK)).resolves.toBeUndefined();
        expect(commands).toEqual(['copy']);
    });

    it('puts the link in the field it copies from', async () => {
        let seen: string | null = null;
        const clipboard = createClipboard({
            exec: () => {
                seen = (document.querySelector('textarea') as HTMLTextAreaElement).value;
                return true;
            }
        });

        await clipboard.writeText(LINK);

        expect(seen).toBe(LINK);
    });

    it('leaves no field behind', async () => {
        const clipboard = createClipboard({ exec: () => true });
        await clipboard.writeText(LINK);
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('leaves no field behind when the copy fails either', async () => {
        const clipboard = createClipboard({ exec: () => false });
        await expect(clipboard.writeText(LINK)).rejects.toThrow();
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('leaves no field behind when the copy throws', async () => {
        const clipboard = createClipboard({
            exec: () => {
                throw new Error('blocked');
            }
        });
        await expect(clipboard.writeText(LINK)).rejects.toThrow();
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('reports failure rather than claiming a copy that did not happen', async () => {
        const clipboard = createClipboard({ exec: () => false });
        await expect(clipboard.writeText(LINK)).rejects.toThrow('no clipboard available');
    });

    it('reports failure when there is no way to copy at all', async () => {
        await expect(createClipboard({}).writeText(LINK)).rejects.toThrow('no clipboard available');
    });
});

describe('the field it copies from', () => {
    it('is offscreen and unfocusable, so no keyboard opens over the lobby', async () => {
        let style: { position: string; opacity: string } | null = null;
        let readOnly = false;
        const clipboard = createClipboard({
            exec: () => {
                const field = document.querySelector('textarea') as HTMLTextAreaElement;
                style = { position: field.style.position, opacity: field.style.opacity };
                readOnly = field.hasAttribute('readonly');
                return true;
            }
        });

        await clipboard.writeText(LINK);

        expect(style).toEqual({ position: 'fixed', opacity: '0' });
        expect(readOnly).toBe(true);
    });
});
