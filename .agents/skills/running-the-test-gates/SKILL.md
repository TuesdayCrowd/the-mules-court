---
name: running-the-test-gates
description: Use before claiming any change in this repo is done, when a test fails for a reason that does not match the code changed, or when adding a new directory under src/.
---

# Running the test gates

## The gate

```bash
bun run test        # engine + client (Vitest), then server, then MCP (bun test)
bunx tsc --noEmit   # the ONLY type check — vite build and the dev server do not type-check
bun run build       # confirm the production bundle still builds
```

All three. `bun run test` passing while `tsc` fails is the normal way a broken change
looks, because Vite transpiles without checking.

## Two runners, and why

| Suite | Runner | Command |
|---|---|---|
| `src/game/**`, `src/client/**` | Vitest | `bun run test:engine` |
| `src/server/**` | `bun test` | `bun run test:server` |
| `src/mcp/**` | `bun test` | `bun run test:mcp` |

Not stylistic: Vitest's workers run under Node, which can load neither `bun:sqlite` nor
the Bun globals the transport needs. `src/mcp/` inherits that — it opens real WebSockets
and spawns its own server as a subprocess.

**`test:engine` is a misnomer.** It predates the client and runs both.

## A new directory under `src/` is silently untested

`vitest.config.ts` enumerates **globs**; the two `bun test` scripts name
**directories**. So a new top-level directory is type-checked automatically
(`tsconfig.json` includes `src` wholesale) but runs no tests until a script names it.
That asymmetry is how a suite rots — `test:mcp` exists because of it. Add the script in
the same change that adds the directory.

## Client tests need a DOM opt-in

Node is the default. A file needing a DOM declares it on **line 1**:

```ts
// @vitest-environment jsdom
```

Vitest 4 removed `environmentMatchGlobs`, so there is no config-level alternative.

## Gates that fail for non-obvious reasons

- **`__tests__/purity.test.ts`** — reads raw file text, so a *comment* naming a banned
  global fails. See the `adding-to-the-pure-layer` skill.
- **`__tests__/axe.test.ts`** — axe-core over every surface. `color-contrast` is the one
  disabled rule (jsdom has no layout); contrast is checked arithmetically in
  `tokens/contrast.test.ts` instead. A new surface must be registered here.
- **`ui/tableContract.test.ts`** — greps `table.ts` for every field the pure layout
  layer publishes. See the `laying-out-the-table` skill.
- **`layout/discardCapacity.test.ts`** — drives thousands of real matches; slow by
  design, and its answer (eight) contradicts the design document (seven).

## What the suite cannot see

`bun run test:visual` drives real matches in a real browser and writes PNGs per
viewport. It needs **both dev servers running**. It is a capture harness, not an
oracle — it fails on page errors and empty surfaces, and leaves the rest to eyes. Two
layout bugs shipped past 1,398 green tests and were obvious in a screenshot.

There is **no linter** configured. Do not invent one mid-task.

## Common mistakes

- **Reporting green from one suite.** `bunx vitest run` skips server and MCP entirely.
- **Skipping `tsc` on a "docs-only" change** that touched a `.ts` docblock.
- **Assuming a slow test is hung.** `discardCapacity` and the MCP suite both take
  seconds by design.
