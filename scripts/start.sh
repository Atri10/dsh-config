#!/usr/bin/env bash
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_HOST="127.0.0.1"
DSH_PORT="${DSH_PORT:-3080}"     # must equal the host-published port
PROXY_PORT="${PROXY_PORT:-3081}" # container-internal only
MAX_WAIT_SECS="${MAX_WAIT_SECS:-60}"

# ── seed $DSH_HOME on first boot ────────────────────────────────────────────
# The image carries /opt/dsh-seed: the custom `power` agent preset and the
# patched web profile. Copy them in only when $DSH_HOME has no web profile
# yet, so a deleted container is rebuilt identically while a live home (with
# credentials, sessions, and any user edits) is never clobbered.
if [ -d /opt/dsh-seed ] && [ ! -d "${DSH_HOME}/profiles/web" ]; then
  echo "[start] seeding ${DSH_HOME} from /opt/dsh-seed (first boot)"
  mkdir -p "${DSH_HOME}"
  cp -a /opt/dsh-seed/. "${DSH_HOME}"/
elif [ -d /opt/dsh-seed ]; then
  echo "[start] ${DSH_HOME}/profiles/web exists — skipping seed (keeping runtime data)"
fi

echo "[start] launching dsh web on ${DSH_HOST}:${DSH_PORT}"
dsh web --host "${DSH_HOST}" --port "${DSH_PORT}" &
DSH_PID=$!

echo "[start] waiting for dsh to accept connections..."
waited=0
until curl -fsS "http://${DSH_HOST}:${DSH_PORT}" >/dev/null 2>&1; do
  if ! kill -0 "${DSH_PID}" 2>/dev/null; then
    echo "[start] dsh exited before it started listening." >&2
    echo "[start] scroll up for its real error — often 'Failed to load native module: pty.node'." >&2
    wait "${DSH_PID}" || true
    exit 1
  fi
  waited=$((waited + 1))
  if [ "${waited}" -ge "${MAX_WAIT_SECS}" ]; then
    echo "[start] timed out after ${MAX_WAIT_SECS}s waiting for dsh on ${DSH_HOST}:${DSH_PORT}" >&2
    exit 1
  fi
  sleep 1
done

echo "[start] dsh is up. Bridging 0.0.0.0:${PROXY_PORT} -> ${DSH_HOST}:${DSH_PORT}"
exec socat TCP-LISTEN:${PROXY_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:${DSH_HOST}:${DSH_PORT}
