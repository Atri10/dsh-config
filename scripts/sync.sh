#!/usr/bin/env bash
# Sync seed config into the live $DSH_HOME bind mount.
#
# config/ is the image-level source of truth (baked at build via
# `COPY config/ /opt/dsh-seed/`, copied into $DSH_HOME on FIRST boot only by
# start.sh). Once a home is seeded, dsh reads $DSH_HOME directly, so edits to
# config/ do NOT reach the running instance. Run this after changing seed
# files to push them into the live home — without touching runtime data
# (credentials, sessions, storages).
#
#   ./sync.sh            # copy seed config -> dsh-home
#   docker compose restart
#
# To reseed from scratch (loses credentials + sessions):
#   docker compose down && rm -rf dsh-home && docker compose up -d --build

set -euo pipefail
cd "$(dirname "$0")/.."   # repo root (script lives in scripts/)

SEED_DIR="config"
HOME_DIR="${DSH_HOME_DIR:-dsh-home}"

if [ ! -d "$SEED_DIR" ] || [ ! -d "$HOME_DIR" ]; then
  echo "error: need both $SEED_DIR/ and $HOME_DIR/ present" >&2
  exit 1
fi

# Config-only copy: the web profile patch + user agent presets.
# Explicitly NOT: sessions/, storages/, .credentials.yaml, .anonymous-user-id,
# settings.yaml, profiles/node_modules (symlink farm into the image).
# Remove-then-copy so a deleted source file does not linger in the target.
for rel in profiles/web/cordis.patch.yml .agent-presets; do
  src="$SEED_DIR/$rel"
  dst="$HOME_DIR/$rel"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    echo "synced: $rel"
  fi
done

echo "done. Restart to apply: docker compose restart"
