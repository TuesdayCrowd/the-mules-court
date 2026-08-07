/**
 * Drives real matches in a real browser and writes a screenshot per viewport.
 *
 * The layout suite proves things about the rects `computeLayout` returns. That
 * is a strong guarantee and a narrow one: anything drawn *past* a rect is not a
 * rect, so no assertion over the spec can see it. Two bugs shipped through that
 * gap — a hand flung to opposite corners, and a caption twice the width of the
 * card it captioned. Both were obvious in a screenshot and invisible to 1,398
 * passing tests.
 *
 * So this is a capture harness, not an oracle. It fails the run on anything a
 * machine can judge — a page error, a table that never mounted, a table that
 * mounted empty, a hand with no cards in it — and writes PNGs for the things
 * only eyes can.
 *
 * ## Two passes, because a match walks past most of the client
 *
 * The match pass deals a real hand and photographs it. That is faithful and it
 * is narrow: it sees whatever a freshly dealt table happens to contain, and
 * nothing that needs a turn played or a round finished. Two surfaces were
 * changed on the strength of "the tests pass" and neither had ever appeared in
 * an image — the showdown list, which comes after a round this pass never ends,
 * and a toast, which lives five seconds somewhere in a turn nobody drove.
 *
 * So the second pass walks `visual/gallery.ts`: the same surface factories
 * `main.ts` builds and the same `ui.css`, in this same real browser, handed a
 * synthetic state instead of a played one. The state is the only synthetic part,
 * and it buys the assertions below — a real cascade can be asked what a toast
 * actually measures, which is precisely what jsdom cannot answer and precisely
 * what the clipped-channel bug turned on.
 *
 * Neither pass replaces the other. A specimen proves a surface draws correctly
 * given a state; only a live match proves the client ever reaches that state.
 *
 * Run it with `bun run test:visual`. It needs both dev servers up, because it
 * plays actual matches over the actual socket rather than mocking a view.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

const CLIENT_URL = process.env.MULES_VISUAL_URL ?? 'http://localhost:8080';
const API_URL = process.env.MULES_VISUAL_API ?? 'http://localhost:3000';
const OUT_DIR = join(import.meta.dir, 'output');

/**
 * Which browser to drive.
 *
 * `msedge` and `chrome` use a browser already on the machine, so a checkout
 * needs no 150MB download to run this. Unset it to use Playwright's own
 * Chromium, which is the reproducible choice for CI — that one does need
 * `bunx playwright install chromium` first.
 */
const CHANNEL = process.env.MULES_VISUAL_CHANNEL ?? 'msedge';

interface Viewport {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    /** What `classifyTopology` should call this, as documentation for the reader. */
    readonly topology: 'portrait' | 'landscape-narrow' | 'wide';
}

/**
 * Every composition, plus both sides of the one boundary that flips it.
 *
 * The 559/561 pair exists because a two-pixel change in height used to move the
 * hand from centred to opposite corners. A boundary is allowed to change the
 * composition; it is not allowed to be a cliff, and the pair is here so that
 * stays visible.
 */
const VIEWPORTS: readonly Viewport[] = [
    { name: 'phone-portrait', width: 390, height: 844, topology: 'portrait' },
    { name: 'phone-landscape', width: 844, height: 390, topology: 'landscape-narrow' },
    { name: 'short-wide-window', width: 1400, height: 500, topology: 'landscape-narrow' },
    { name: 'boundary-below', width: 1400, height: 559, topology: 'landscape-narrow' },
    { name: 'boundary-above', width: 1400, height: 561, topology: 'wide' },
    { name: 'tablet-landscape', width: 1024, height: 768, topology: 'wide' },
    { name: 'desktop-4x3', width: 1633, height: 1221, topology: 'wide' },
    { name: 'desktop-16x9', width: 1920, height: 1080, topology: 'wide' }
];

interface Failure {
    readonly viewport: string;
    readonly detail: string;
}

const failures: Failure[] = [];

function fail(viewport: string, detail: string): void {
    failures.push({ viewport, detail });
    console.log(`  ✗ ${detail}`);
}

async function assertServersUp(): Promise<void> {
    const checks: [string, string][] = [
        [CLIENT_URL, 'bun run dev'],
        [API_URL, 'bun run dev:server']
    ];

    for (const [url, command] of checks) {
        try {
            await fetch(url, { signal: AbortSignal.timeout(3000) });
        } catch {
            console.error(`\nCannot reach ${url}.\n\nThis harness plays real matches, so both halves have to be running:\n\n  bun run dev:server   # :3000\n  bun run dev          # :8080\n\nMissing: ${command}\n`);
            process.exit(1);
        }
    }
}

/**
 * One seat, in its own browser context.
 *
 * The context is the point. Seat tokens live in localStorage under
 * `mules-court:${matchId}`, so two tabs sharing a profile resume the SAME seat
 * and a second player can never sit down. One context per seat is the only way
 * to reach a real two-player table.
 */
async function takeSeat(
    browser: Browser,
    viewport: Viewport,
    url: string,
    nickname: string,
    action: 'Host a game' | 'Take a seat'
): Promise<Page> {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2
    });
    const page = await context.newPage();

    page.on('pageerror', error => fail(viewport.name, `${nickname}: uncaught ${error.message}`));
    page.on('console', message => {
        if (message.type() === 'error') fail(viewport.name, `${nickname}: console error — ${message.text()}`);
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByRole('textbox').first().fill(nickname);
    await page.getByRole('button', { name: action }).click();
    await page.waitForTimeout(1200);

    return page;
}

async function capture(browser: Browser, viewport: Viewport): Promise<void> {
    console.log(`\n${viewport.name} (${viewport.width}×${viewport.height}, expect ${viewport.topology})`);

    const host = await takeSeat(browser, viewport, CLIENT_URL, 'corey', 'Host a game');
    await host.screenshot({ path: join(OUT_DIR, `${viewport.name}-lobby.png`) });

    const guest = await takeSeat(browser, viewport, host.url(), 'tuesday', 'Take a seat');

    await host.getByRole('button', { name: 'Start Match' }).click();
    // The deal runs cinematic beats; screenshotting mid-flight catches cards in
    // transit and makes every run's image different for no reason.
    await host.waitForTimeout(3500);

    await host.screenshot({ path: join(OUT_DIR, `${viewport.name}-match.png`) });

    // What a machine can still judge, once the pixels are someone else's problem.
    if ((await host.locator('[data-role="table-host"]').count()) === 0) {
        fail(viewport.name, 'no table — it never mounted');
    }

    // Mounted but empty is the failure a screenshot hides: `table.ts#update`
    // clears the plan layer and returns early on a state it cannot draw, so the
    // background still renders and the page looks plausible.
    const seats = await host.locator('[data-role="seat-chip"]').count();
    if (seats === 0) fail(viewport.name, 'table mounted but drew no seats');

    // Every card is a real button, which is the whole accessibility story now
    // that there is no shadow tree standing in for a canvas. No cards in hand
    // during a live match means a player has nothing to activate.
    const hand = await host.locator('[data-role="hand-card"]').count();
    if (hand === 0) fail(viewport.name, 'no hand cards during a live match');

    // A control with no accessible name is invisible to a screen reader and to
    // axe; jsdom can prove the markup, only a browser can prove it survived the
    // cascade and the live plan.
    const unnamed = await host.evaluate(() =>
        [...document.querySelectorAll('[data-role="seat-chip"] button, [data-role="hand-card"]')].filter(
            el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === ''
        ).length
    );
    if (unnamed > 0) fail(viewport.name, `${unnamed} table controls have no accessible name`);

    console.log(`  ✓ table up: ${seats} seats, ${hand} hand cards, every control named`);

    await guest.context().close();
    await host.context().close();
}

/** One entry in `visual/gallery.ts`'s `SPECIMENS`, read from the page itself. */
interface Specimen {
    readonly name: string;
    readonly about: string;
}

const GALLERY_URL = `${CLIENT_URL}/visual/gallery.html`;

/**
 * The specimen list, taken from the gallery rather than restated here.
 *
 * Two copies of this list would drift, and the drift is silent in the worst
 * direction: a specimen added to the gallery and not to the harness is a
 * surface nobody photographs, which is the exact condition this whole pass was
 * added to end.
 */
async function specimenList(browser: Browser): Promise<readonly Specimen[]> {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    await page.goto(GALLERY_URL, { waitUntil: 'networkidle' });

    const specimens = await page.evaluate(
        () => (window as unknown as { MULES_SPECIMENS?: Specimen[] }).MULES_SPECIMENS ?? []
    );
    await context.close();

    if (specimens.length === 0) {
        console.error(`\nThe gallery at ${GALLERY_URL} published no specimens. Is visual/gallery.ts loading?\n`);
        process.exit(1);
    }

    return specimens;
}

/**
 * What a real cascade can be asked that jsdom cannot.
 *
 * Every assertion here is about *rendered* geometry or a *resolved* colour —
 * the two things a layout-less DOM has no opinion on. Anything provable from
 * the markup alone belongs in the Vitest suite, where it runs in three seconds.
 */
async function judgeSpecimen(page: Page, viewport: string, specimen: string): Promise<void> {
    if (specimen === 'toasts') {
        const toasts = await page.evaluate(() =>
            [...document.querySelectorAll('[data-role="toast"]')].map(el => {
                const style = getComputedStyle(el);
                return {
                    kind: (el as HTMLElement).dataset.kind ?? '',
                    width: Math.round(el.getBoundingClientRect().width),
                    borderColor: style.borderTopColor,
                    // Text wider than the box holding it. A toast sizes itself
                    // to its content, so this only goes positive once something
                    // clamps the width — which the strip does, at 90% of the
                    // viewport — and then the last words are simply gone.
                    overflow: el.scrollWidth - el.clientWidth
                };
            })
        );

        const byKind = new Map(toasts.map(toast => [toast.kind, toast]));
        for (const kind of ['narration', 'table', 'personal', 'notice']) {
            if (!byKind.has(kind)) fail(viewport, `gallery/toasts: no toast rendered for kind "${kind}"`);
        }

        // The bug itself, in one number. `narration` is clipped to a 1px box on
        // purpose; if it ever measures like a real toast, the running commentary
        // is being painted over the table again.
        const narration = byKind.get('narration');
        if (narration !== undefined && narration.width > 2) {
            fail(viewport, `gallery/toasts: narration is painted (${narration.width}px) — it must stay clipped`);
        }

        // And its mirror: a kind meant to be read that measures like the clipped
        // one is on screen in name only. This is the assertion the whole
        // bystander-guess change turns on, and no jsdom test can make it.
        for (const kind of ['table', 'personal', 'notice']) {
            const toast = byKind.get(kind);
            if (toast !== undefined && toast.width < 40) {
                fail(viewport, `gallery/toasts: ${kind} measures ${toast.width}px — it is not being drawn`);
            }
        }

        // `notice` (a server refusal) wears the bare `.toast` box, so a `table`
        // line resolving to the same border is pixel-identical to "the court
        // refused your play" — two meanings, one appearance, both able to be on
        // screen at once. Compared as *resolved* colours rather than as source
        // text, so a rule that computes its way back to the base value fails
        // here even though the stylesheets look different.
        const table = byKind.get('table');
        const notice = byKind.get('notice');
        const personal = byKind.get('personal');
        if (table !== undefined && notice !== undefined && table.borderColor === notice.borderColor) {
            fail(viewport, `gallery/toasts: table and notice share a border (${table.borderColor}) — indistinguishable`);
        }
        if (table !== undefined && personal !== undefined && table.borderColor === personal.borderColor) {
            fail(viewport, `gallery/toasts: table wears the personal border (${table.borderColor}) — that colour means "you"`);
        }

        // Found by looking at this specimen's very first screenshot: on a 390px
        // phone the `personal` toast — larger type and wider padding than any
        // other kind — ran its own text into its own border.
        for (const toast of toasts) {
            if (toast.kind !== 'narration' && toast.overflow > 1) {
                fail(viewport, `gallery/toasts: ${toast.kind} clips its own text by ${toast.overflow}px`);
            }
        }

        console.log(`  ✓ toasts: ${toasts.map(t => `${t.kind} ${t.width}px`).join(', ')}`);
        return;
    }

    if (specimen === 'round-over') {
        const rows = await page.evaluate(() =>
            [...document.querySelectorAll('[data-role="revealed-hand"]')].map(el => ({
                text: (el.textContent ?? '').trim(),
                // Text wider than its box is the harness's founding bug: a
                // caption twice the width of the card it captioned, invisible to
                // every assertion over a rect.
                overflow: el.scrollWidth - el.clientWidth
            }))
        );

        if (rows.length === 0) {
            fail(viewport, 'gallery/round-over: the showdown revealed no hands');
        }

        for (const row of rows) {
            // A value, then the name. The whole of the reported complaint: the
            // showdown is decided in numbers and stated them nowhere.
            if (!/\d+\s*·\s*\S/.test(row.text)) {
                fail(viewport, `gallery/round-over: "${row.text}" names a card without its value`);
            }
            if (row.overflow > 1) {
                fail(viewport, `gallery/round-over: "${row.text}" overflows its box by ${row.overflow}px`);
            }
        }

        console.log(`  ✓ round-over: ${rows.length} hands revealed, each with a value, none overflowing`);
        return;
    }

    // A specimen the gallery publishes and this file has no opinion on. Said out
    // loud rather than passed over: an unjudged specimen is still photographed,
    // and someone should know the picture is all they are getting.
    console.log(`  · ${specimen}: captured, no machine assertions defined`);
}

async function captureGallery(browser: Browser, viewport: Viewport, specimens: readonly Specimen[]): Promise<void> {
    for (const specimen of specimens) {
        const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: 2
        });
        const page = await context.newPage();

        page.on('pageerror', error => fail(viewport.name, `${specimen.name}: uncaught ${error.message}`));
        page.on('console', message => {
            if (message.type() === 'error') fail(viewport.name, `${specimen.name}: console error — ${message.text()}`);
        });

        await page.goto(`${GALLERY_URL}?specimen=${specimen.name}`, { waitUntil: 'networkidle' });
        // Toasts animate in over 160ms and the display face is self-hosted;
        // shooting before both settle makes every run's image different.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);

        await page.screenshot({ path: join(OUT_DIR, `${viewport.name}-${specimen.name}.png`) });
        await judgeSpecimen(page, viewport.name, specimen.name);

        await context.close();
    }
}

await assertServersUp();

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch(CHANNEL === 'chromium' ? {} : { channel: CHANNEL });

let specimens: readonly Specimen[] = [];

try {
    specimens = await specimenList(browser);
    console.log(`Gallery specimens: ${specimens.map(s => s.name).join(', ')}`);
    for (const specimen of specimens) console.log(`  ${specimen.name} — ${specimen.about}`);

    for (const viewport of VIEWPORTS) {
        await capture(browser, viewport);
        await captureGallery(browser, viewport, specimens);
    }
} finally {
    await browser.close();
}

const images = VIEWPORTS.length * (2 + specimens.length);
console.log(`\n${VIEWPORTS.length} viewports × (2 match + ${specimens.length} specimen) = ${images} images in visual/output/`);

if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  ${failure.viewport}: ${failure.detail}`);
    process.exit(1);
}

console.log('No page errors, every table mounted with seats, a hand, and named controls.');
console.log('Every specimen drew, measured and coloured as its stylesheet claims.');
console.log('The screenshots still want eyes — that is what they are for.');
