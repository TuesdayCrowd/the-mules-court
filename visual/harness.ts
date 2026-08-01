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

await assertServersUp();

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch(CHANNEL === 'chromium' ? {} : { channel: CHANNEL });

try {
    for (const viewport of VIEWPORTS) await capture(browser, viewport);
} finally {
    await browser.close();
}

console.log(`\n${VIEWPORTS.length} viewports captured to visual/output/`);

if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  ${failure.viewport}: ${failure.detail}`);
    process.exit(1);
}

console.log('No page errors, every table mounted with seats, a hand, and named controls.');
console.log('The screenshots still want eyes — that is what they are for.');
