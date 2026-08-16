# DeepSeek Harness (dsh) — Docker sandbox

Local DeepSeek Harness web UI in a Docker container, tuned for speed, with a
custom agent preset and config baked into the image.

## Quick start

```bash
# 1. configure your API key
cp .env.example .env          # edit DEEPSEEK_API_KEY / COMMAND_CODE_API_KEY

# 2. build + start
docker compose up -d --build

# 3. open
open http://localhost:3080
```

New sessions default to the **Power** agent preset (persistent bash, full
toolset). Pick a different preset per session in the UI.

## What's inside

- **dsh** `0.1.0-rc.6` (npm) with node-pty compiled in.
- **`power` agent preset** (default): standard toolset (bash, fs+search,
  skills, plan, goals, subagents, workflow, web, jobs) + **persistent bash**
  (cwd/env survive across tool calls) + Docker-sandbox-aware persona that
  steers the model toward `rg`/`jq`/`nohup` patterns.
- **Image-level seed** (`config/` → `/opt/dsh-seed`): the preset + profile
  patch are baked in; `scripts/start.sh` copies them into `$DSH_HOME` on first boot
  only. Delete the container and `docker compose up --build` reproduces the
  setup.
- **Runtime data on a host bind mount** (`dsh-home/` → `/root/.dsh`):
  credentials, sessions, and storages survive container deletion. Never
  committed (gitignored).
- **Tooling**: `rg`, `jq`, `pnpm` (corepack), `python3`, `git`.

## Tuning (no rebuild)

`.env`:

```
DSH_MAX_PARALLEL_TOOL_CALLS=16   # agent-loop parallel tool calls per step
DSH_BASH_TIMEOUT_MS=600000       # bash sandbox cap per command (ms)
```

Apply with `docker compose up -d` (recreates the container).

## Editing the preset / profile

1. Edit `config/.agent-presets/power/agent.cordis.yml` (persona, tools) or
   `config/profiles/web/cordis.patch.yml` (parallelism, default preset).
2. `scripts/sync.sh` — pushes config into the live home (`dsh-home/`).
3. `docker compose restart` — takes effect for new sessions.

Reseed from scratch (loses credentials + sessions):

```bash
docker compose down && rm -rf dsh-home && docker compose up -d --build
```

## Managing plugins

```bash
docker exec -it deepseek-harness sh -c 'cd ~/.dsh/profiles/web && dsh plugin --profile web add <package>'
```

Out-of-tree plugin packages land in `dsh-home/profiles/web/` (persisted);
re-run after a full reseed.

## Layout

```
Dockerfile            # node 24 + dsh + node-pty + rg/jq/pnpm + seed copy
docker-compose.yml    # loopback-only web, bind mounts, healthcheck
scripts/
  start.sh            # seed-on-first-boot + launch + socat bridge
  sync.sh             # push config/ -> dsh-home (config only)
config/               # image-level config source of truth (see its README)
  .agent-presets/     #   custom agent presets (power = default)
  profiles/web/       #   web profile patch layer
dsh-home/             # runtime home: credentials/sessions/storages (gitignored)
workspace/            # bind-mounted default working directory
data/                 # (reserved)
```

## Web access

- **`web_search`** — DeepSeek search provider (works out of the box).
- **`web_fetch`** — enabled. The npm dist ships no HTTP fetch provider, so a
  vendored local plugin (`config/profiles/web/plugins/dsh-web-fetch-http/`,
  adapted from the official `@deepseek-ai/dsh-web-fetch-http`) registers one
  into the web seam; the profile patch selects it as `fetchProvider`. The
  loader imports it by relative path, so it survives rebuilds via the image
  seed. Same-origin redirects only; http(s) only; 5 MB / 100k-char caps.
  SSRF caveat: do not expose this stack where the agent could reach sensitive
  internal targets.
