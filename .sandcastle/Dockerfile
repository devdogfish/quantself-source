# Build from repo root: bunx sandcastle docker build-image --dockerfile .sandcastle/Dockerfile
FROM node:24-bookworm

ARG BUN_VERSION=1.3.14
ARG CODEX_VERSION=0.164.0

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The provisioning test uses Compose config parsing; no Docker daemon is mounted.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex@${CODEX_VERSION} bun@${BUN_VERSION}

USER ${AGENT_UID}:${AGENT_GID}

# Cache dependency downloads in the image; each sandbox keeps its own install.
WORKDIR /home/agent/dependency-cache
COPY --chown=agent package.json bun.lock ./
COPY --chown=agent apps/api/package.json ./apps/api/package.json
COPY --chown=agent apps/web/package.json ./apps/web/package.json
COPY --chown=agent apps/log-bot/package.json ./apps/log-bot/package.json
COPY --chown=agent packages/auth/package.json ./packages/auth/package.json
COPY --chown=agent packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile --linker hoisted --ignore-scripts \
  && rm -rf /home/agent/dependency-cache

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
