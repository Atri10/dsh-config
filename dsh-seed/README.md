# dsh-seed — image-level config seed

This directory is baked into the image at build time:

```dockerfile
COPY dsh-seed/ /opt/dsh-seed/
```

`start.sh` copies it into `$DSH_HOME` (`/root/.dsh`) on **first boot only**
(see the guard in `start.sh`). After that, dsh reads and writes `$DSH_HOME`
directly, so **edits here do not reach a running instance** — run `./sync.sh`
to push seed config into the live home, or delete `dsh-home/` to reseed fresh.

## Layout

```
dsh-seed/
├── .agent-presets/power/     # the "power" agent preset (default for new sessions)
│   ├── preset.yml            #   name/description shown in the UI
│   └── agent.cordis.yml      #   plugin composition (persona, tools, persistent bash)
└── profiles/web/
    └── cordis.patch.yml      # web profile tuning (default preset, parallelism, timeout)
```

## Authoritative source of truth

| Path | Role |
|---|---|
| `dsh-seed/` | **Single source of truth** for config. Edit here, then `./sync.sh` + restart. |
| `dsh-home/` (bind-mounted to `/root/.dsh`) | Runtime home dsh actually reads. Contains credentials, sessions, storages — **never commit**. |
| Image `/opt/dsh-seed` | Copy of `dsh-seed/` at build time; reseeds a virgin home. |

Keep `dsh-seed/` and `dsh-home/` in sync with `./sync.sh`. The script copies
config only (profile patch + presets) and never touches runtime data.

## Secrets

`.credentials.yaml` in `dsh-home/` holds the provider API key (write-only,
UI-managed). Prefer env-driven keys (`.env` → compose → container env →
`apiKeyEnv: NAME` in `settings.yaml`); the credentials store takes precedence
when both exist.
