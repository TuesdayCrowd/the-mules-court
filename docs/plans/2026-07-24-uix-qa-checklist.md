# UIX QA checklist — real device and screen reader

**Status: written, NOT RUN.** Every box below is unchecked, and none of them can
be checked yet.

Two reasons, and the first is the blocking one:

1. **The client does not run in a browser.** `src/main.ts` still boots the Phaser
   starter scenes; nothing in `src/client/` is mounted by anything. Stage 6 of
   `2026-07-24-uix-implementation-plan.md` does that wiring. Until it lands there
   is no application to open on a phone.
2. **This needs physical hardware.** Devtools emulation does not reproduce
   Safari's viewport behaviour — the toolbar collapse, the keyboard's effect on
   `100dvh`, or the safe-area insets — and no emulator reproduces VoiceOver or
   TalkBack gesture navigation. *UIX §13.2* and §13.3 name both as sign-off
   conditions precisely because a test suite cannot assert them.

Run this after Stage 6, on real devices, and record the results in place.

**Serving it:** `bun run dev:server` in one terminal, `bun run dev:host` in
another, then open the printed network address on the device.

**Worth knowing before you start.** Everything served over `http://<lan-ip>` is a
non-secure context, so `navigator.clipboard` does not exist there — the lobby's
**Copy** button falls back to a selection copy and should still work. If it does
not, that *is* a finding; note the device and OS version.

The cinematic beats now exist, so every line below about announcements waiting on
their animation is live and worth checking.

---

## iOS Safari

- [ ] The nickname field opens the keyboard without the layout jumping or the submit button leaving the viewport.
- [ ] The resize debounce (~100 ms) survives the toolbar collapsing and expanding during a scroll; the table does not thrash.
- [ ] A resize while a text input holds focus is **ignored**, so the keyboard appearing does not relayout the table underneath it.
- [ ] `viewport-fit=cover` plus the safe-area insets keep the action sheet's footer above the home indicator.
- [ ] Nothing important sits under the notch in landscape.
- [ ] Portrait ↔ landscape rotation rebuilds the table through the one reconciler, with no orphaned or duplicated objects.
- [ ] Rotation re-evaluates the action sheet's anchor on the **next** open (bottom → right), and does not cache the first answer.
- [ ] Text is crisp at `devicePixelRatio` 3, not soft — check card values and nicknames specifically.
- [ ] `100dvh` behaves as intended when the toolbar hides; the action dock stays reachable.

## Android Chrome

- [ ] Everything above.
- [ ] The back button on `/join/:matchId` leaves the app rather than half-navigating the SPA.
- [ ] Returning via the back button restores the seat from `localStorage` rather than asking for a nickname again.
- [ ] The keyboard's `resize` behaviour (Android resizes the viewport where iOS overlays it) does not break the layout.

## Both — the DOM/canvas touch seam

This is the seam the two-layer architecture creates, and the one place a bug
would be invisible to every test in the suite.

- [ ] A tap on the action sheet never reaches the canvas beneath it.
- [ ] A tap on a seat chip opens the dossier and does **not** fall through to a DOM element above it.
- [ ] A tap in the toast strip's area **does** reach the table beneath, since toasts are not interactive.
- [ ] A tap in the connection dot's corner likewise reaches the table.
- [ ] Dragging on the canvas does not scroll the page (`overscroll-behavior: none` holding).
- [ ] Every button clears 48 px in the real rendering, not just in the stylesheet.

## VoiceOver (iOS) and TalkBack (Android)

- [ ] Swipe order through the lobby is sensible: heading, invite box, seat rows in order, then the action.
- [ ] A disabled target button announces **its reason** ("protected", "eliminated") and not merely "dimmed".
- [ ] The toast region announces each play exactly once — not twice, and not on every unrelated state update.
- [ ] An announcement never arrives **before** its canvas animation resolves (*UIX §8.4*, interface rule 8). This is the rule the presentation queue exists to keep, and the only way to confirm it is to listen.
- [ ] The offscreen twin's seat list reads correctly and is **not** announced wholesale on every snapshot.
- [ ] Hand proxies are reachable and land where the cards visually are under touch exploration.
- [ ] The quick reference is reachable and readable during another player's turn.
- [ ] Overlays take focus on open and return it on close; focus never lands on a removed node.
- [ ] The fatal screen is announced as an alert and cannot be swiped past into dead chrome.
- [ ] Non-Latin nicknames (`Ана`, `中文`) are pronounced or spelled rather than skipped.

## Reduced motion

- [ ] `prefers-reduced-motion: reduce` collapses the Mule beat and the elimination sequence to plain fades.
- [ ] Countdowns and discard pips are **unaffected** by that setting — they are information, not decoration.

---

## Results

Record date, device, OS version, and outcome per section. A failed line gets an
issue reference, not a fix inline — the point of a checklist is that it is
re-runnable.

| Date | Device | OS | Sections run | Failures |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

## The invite link, specifically

The one flow that only exists across two devices, and the one most affected by
being served over plain http.

- [ ] **Copy** on the phone actually copies — paste it somewhere to confirm, do not trust the confirmation message.
- [ ] The copied link points at the address the phone is using, not `localhost`.
- [ ] Opening it on a second device reaches the lobby and takes a seat.
- [ ] The confirmation is announced, not only shown.
