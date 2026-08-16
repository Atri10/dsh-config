FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="deepseek-harness"
LABEL org.opencontainers.image.description="Local DeepSeek Harness (dsh), Web UI kept on loopback only"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV NODE_ENV=production
ENV TZ=Asia/Kolkata
ENV DSH_HOME=/root/.dsh

# node-pty (dsh's terminal backend) ships no Linux prebuild and must be
# compiled at install time. Without a C toolchain the compile silently
# fails and dsh crashes on first launch — this is *the* cause of the
# repeated "connection refused" errors seen in this thread.
#
# ripgrep + jq are the agent's fast search/JSON tools (the power preset's
# persona tells the model to use them); pnpm (via corepack, bundled with
# Node) is what `dsh plugin --profile web add <pkg>` forwards to.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      make \
      g++ \
      python3 \
      ripgrep \
      jq \
      socat \
      tini \
    && rm -rf /var/lib/apt/lists/*

RUN node -v && npm -v && corepack enable && pnpm --version

# Pin the version — this package is two days old and still rc-tagged;
# check https://www.npmjs.com/package/@deepseek-ai/dsh for the current tag.
RUN npm install -g @deepseek-ai/dsh@0.1.0-rc.6

# Belt-and-braces: force-rebuild node-pty's native addon even though the
# install above may already have run its install script. This catches the
# documented case where npm reports success but never actually produced
# pty.node — and fails the Docker build here, loudly, instead of at
# container runtime.
RUN set -eux; \
    NPM_ROOT="$(npm root -g)"; \
    found=0; \
    while IFS= read -r -d '' d; do \
      found=1; \
      echo "rebuilding node-pty at: $d"; \
      (cd "$d" && npx --yes node-gyp rebuild); \
      test -f "$d/build/Release/pty.node" || { echo "pty.node still missing in $d" >&2; exit 1; }; \
    done < <(find "$NPM_ROOT" -type d -name node-pty -print0); \
    [ "$found" -eq 1 ] || { echo "node-pty not found under $NPM_ROOT — dsh package layout may have changed" >&2; exit 1; }

# Seed the harness home: the custom `power` agent preset (persistent bash +
# Docker-aware persona) and the web profile's patch layer (parallelism,
# default preset). scripts/start.sh copies these into $DSH_HOME
# on first boot only, so a deleted container + `docker compose up --build`
# reproduces the full setup — while runtime data (credentials, sessions)
# stays in the bind-mounted $DSH_HOME and is never clobbered.
COPY config/ /opt/dsh-seed/

COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

RUN mkdir -p /workspace /data
WORKDIR /workspace

# Only the internal bridge port needs publishing — dsh's own port never
# leaves loopback inside the container.
EXPOSE 3081

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
