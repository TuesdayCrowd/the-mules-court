#!/usr/bin/env bash
#
# Azure App Service startup command for The Mule's Court.
#
# Set the web app's Startup Command to exactly:
#
#     bash /home/site/wwwroot/startup.sh
#
# Invoked *through* bash rather than executed directly because zip deploy does
# not reliably preserve the executable bit, and a startup command that cannot
# run produces a container that exits with nothing in the log a person reads
# first.
#
# What this script is for: the deployed artifact is `bun build --compile`
# output — Bun's runtime, the transport and every client asset in one
# executable (AGENTS.md, "The single-file binary"). App Service's `Node
# 24-lts` stack only selects the Debian base image; the startup command runs
# whatever it is pointed at, so the binary runs Bun on the Node stack and no
# part of src/server/ needs a second runtime to be correct under.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binary="$here/mules-court"

# Same missing-permission-bit reason as above, for the binary itself.
chmod +x "$binary"

# App Service hands the port to the app in PORT and expects it to listen
# there; the game reads MULES_PORT. The fallback is the platform's own default,
# so running this script by hand behaves the same way.
export MULES_PORT="${PORT:-8080}"

# `envOverrides` (src/server/config.ts) deliberately moves publicBaseUrl with
# MULES_PORT when no URL is named — closing deferred item D3 for a binary
# someone downloaded, where the invite link must follow the port. On App
# Service that default is wrong in the other direction: it would advertise
# http://localhost:8080 as the invite origin. WEBSITE_HOSTNAME is set by the
# platform on every instance, so deriving from it makes invite links correct
# with no configuration, while a custom domain overrides it with a plain app
# setting.
if [[ -z "${MULES_PUBLIC_BASE_URL:-}" && -n "${WEBSITE_HOSTNAME:-}" ]]; then
    export MULES_PUBLIC_BASE_URL="https://${WEBSITE_HOSTNAME}"
fi

# /home is an Azure Files network share, and SQLite's locking over SMB is a
# documented source of SQLITE_BUSY and corruption. /tmp is instance-local disk.
# Losing it on a restart is the right trade here rather than a compromise:
# rooms are reaped within the hour, and a room persists {seed, actionLog}
# rather than a state snapshot, so what is at stake is live lobbies — not
# anything a player expected to still be there tomorrow.
export MULES_DB_PATH="${MULES_DB_PATH:-/tmp/mules-court.sqlite}"

# MULES_STATIC_ROOT is deliberately unset: this binary carries its client
# inside itself, and index.ts treats an explicit handler and a static
# directory as alternatives rather than layers.

# exec rather than fork, so the binary replaces this shell and receives the
# SIGTERM App Service sends on restart. standalone.ts handles that signal to
# close sqlite cleanly; a wrapper left in the process tree would swallow it
# and leave a write-ahead log behind.
exec "$binary"
