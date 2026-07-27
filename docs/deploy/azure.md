# Deploying to Azure App Service

The app runs on Azure as the **single-file binary** `bun run compile:linux-x64`
produces: Bun's runtime, the transport and all 30 client assets in one ~100 MB
executable. `deploy/azure/startup.sh` launches it.

Target: web app **`mules-court`**, Linux, stack **`Node - 24-lts`**.

## Why a binary, and why the stack setting is irrelevant

`src/server/` is Bun-native — `Bun.serve` owns both HTTP and the WebSocket
server, `bun:sqlite` owns persistence, `Bun.file` backs static hosting. None of
that exists in Node, so a `Node - 24-lts` App Service cannot run this source
tree with `node`.

It does not need to. On App Service Linux the stack setting selects a Debian
base image and a default startup command; **the startup command may be any
executable**. Pointing it at a Bun-compiled binary runs Bun on the Node stack.

The alternative was porting the transport to Node (`node:http` + `ws`,
`node:sqlite`, a `node:fs` lookup). That is only three files, because the
architecture already isolates the runtime — but it would leave the repo
permanently maintaining two runtimes, since `bun run serve`, the standalone
binary and the whole `bun test src/server` suite stay on Bun regardless. The
binary keeps one runtime, and it is the one `src/server/__tests__/standalone.test.ts`
already covers.

## One-time setup

Needs the Azure CLI (`brew install azure-cli`, then `az login`). Substitute your
resource group.

```bash
RG=<your-resource-group>
APP=mules-court
```

### 1. The startup command

```bash
az webapp config set -g "$RG" -n "$APP" \
  --startup-file "bash /home/site/wwwroot/startup.sh"
```

### 2. WebSockets — the app does not work without this

Off by default. Leave it off and the socket upgrade fails while `/` still
serves fine, so the game loads and then sits on *Connecting* forever.

```bash
az webapp config set -g "$RG" -n "$APP" --web-sockets-enabled true
```

### 3. Always On

The binary holds rooms in memory. An idle-unload drops every live lobby, and
the ~100 MB cold start is not something to pay on a player's first click.
Requires Basic tier or higher.

```bash
az webapp config set -g "$RG" -n "$APP" --always-on true
```

### 4. App settings

```bash
az webapp config appsettings set -g "$RG" -n "$APP" --settings \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  WEBSITES_CONTAINER_START_TIME_LIMIT=600
```

`SCM_DO_BUILD_DURING_DEPLOYMENT=false` is required. Oryx would otherwise try
`npm install && npm run build` on a package whose every build script shells out
to `bunx`, and fail. Nothing is built on Azure — CI ships a finished artifact.

The start-time limit is headroom: the binary is read off an Azure Files share
at cold start, and the 230 s default is uncomfortably close on a small SKU.

**No `MULES_*` setting is required.** `startup.sh` derives all four from the
platform (see below). Set one only to override:

| Setting | Default from `startup.sh` | Set it when |
| --- | --- | --- |
| `MULES_PORT` | `$PORT` | never — the platform assigns it |
| `MULES_PUBLIC_BASE_URL` | `https://$WEBSITE_HOSTNAME` | you attach a custom domain |
| `MULES_DB_PATH` | `/tmp/mules-court.sqlite` | never, without reading §"SQLite" |
| `MULES_STATIC_ROOT` | unset, deliberately | never — the client is compiled in |

### 5. Never scale out

```bash
az monitor autoscale list -g "$RG" -o table   # expect nothing for this app
```

Rooms live in one process's memory keyed to one SQLite file
(`roomRegistry.ts`). A second instance means two players in "the same" match
landing on different servers, each certain the other's seat does not exist.
**Keep the instance count at 1 and do not attach an autoscale rule.** Scaling
*up* (a bigger SKU) is fine; scaling *out* is not.

### 6. The deploy credential

```bash
az webapp deployment list-publishing-profiles \
  -g "$RG" -n "$APP" --xml
```

Paste the XML into a GitHub repository secret named
**`AZURE_WEBAPP_PUBLISH_PROFILE`**. (Publish-profile auth is the quickest path;
federated OIDC via `azure/login` is the better one if this outlives a weekend,
as it issues no long-lived secret.)

## Deploying

`.github/workflows/deploy-azure.yml` runs on every push to `main`, and on
demand from the Actions tab. It runs the full AGENTS.md gate — `bun run test`,
`bunx tsc --noEmit` — then compiles the binary, checks the committed embedded
manifest is not stale, and zips exactly two files:

```
mules-court    # the compiled binary
startup.sh     # copied from deploy/azure/
```

To deploy by hand instead:

```bash
bun run compile:linux-x64
mkdir -p package && cp dist-bin/mules-court-linux-x64 package/mules-court \
  && cp deploy/azure/startup.sh package/
(cd package && zip -qry ../app.zip .)
az webapp deploy -g "$RG" -n "$APP" --src-path app.zip --type zip
```

## What `startup.sh` does, and why

Read the file — it is commented. The three decisions worth repeating:

**`PORT` → `MULES_PORT`.** App Service assigns the port and expects the app to
listen there.

**`WEBSITE_HOSTNAME` → `MULES_PUBLIC_BASE_URL`.** Without this the invite links
the API hands out say `http://localhost:8080`, because `envOverrides` moves
`publicBaseUrl` with `MULES_PORT` when no URL is named — correct for a binary
someone downloaded, wrong behind a platform hostname. In practice the lobby
builds its visible invite link from `location.origin`, so this only corrupts the
API's `joinUrl` field; it is still worth being right.

**`MULES_DB_PATH` → `/tmp`.** See below.

### SQLite must not live under `/home`

`/home` on App Service is an Azure Files SMB share, and SQLite's locking over
SMB is a documented source of `SQLITE_BUSY` and corruption. `/tmp` is
instance-local disk.

The cost is that the file does not survive a restart or a deploy. That is
acceptable here rather than a compromise: rooms are reaped within the hour, and
a room persists `{seed, actionLog}` rather than a state snapshot, so what is at
risk is live lobbies — not anything a player expected to find tomorrow. A
restart mid-match is already a supported path (`roomRegistry` rebuilds lazily,
the client reconnects with `RESUME_SEAT`), but only while the file is there;
across a deploy, in-flight matches are lost.

If matches ever need to survive a deploy, the answer is a real database, not
`/home`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Container exits immediately, log shows `Illegal instruction` | The CPU lacks AVX2, which `bun-linux-x64` requires. Rebuild with `--target=bun-linux-x64-baseline` and redeploy. |
| Game loads, then sits on *Connecting* forever | WebSockets not enabled (step 2). |
| Container start times out | Cold-reading ~100 MB off Azure Files. Raise `WEBSITES_CONTAINER_START_TIME_LIMIT`; confirm Always On is set. |
| `Permission denied` on startup | The zip lost the executable bit and `chmod` failed — check the deploy actually placed both files at `/home/site/wwwroot/`. |
| App's own JavaScript 404s | Stale `src/server/embeddedAssets.generated.ts`. Run `bun run build` and commit it; the workflow fails on this deliberately. |
| Players in one match cannot see each other | The app scaled out. Return to a single instance. |

Live logs:

```bash
az webapp log tail -g "$RG" -n "$APP"
```

## Operational limits, stated plainly

- **One instance, forever.** In-memory rooms, local SQLite.
- **Every deploy drops live matches.** New container, empty `/tmp`.
- **Rate limiting is coarse.** `ipConnectionsPerMinute: 30` buckets by
  `srv.requestIP`, which behind App Service's front end is the load balancer,
  not the player. All traffic shares one bucket. Honouring `X-Forwarded-For` in
  `index.ts` is the fix if this ever bites; it is not wired up today.
