# Layers Claude Code onto any Debian- or Ubuntu-based image.
#
#   docker build --build-arg BASE_IMAGE=node:22-bookworm-slim -t claude-multitask:latest .
#
# The app's Images dialog runs exactly this build for you.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# git and ripgrep are what Claude Code reaches for constantly; less and procps make the
# container pleasant to work in by hand when you click into the pane.
RUN set -eux; \
    if command -v apt-get >/dev/null 2>&1; then \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl git less procps ripgrep unzip; \
      rm -rf /var/lib/apt/lists/*; \
    else \
      echo "This Dockerfile needs a Debian or Ubuntu based image (apt-get)." >&2; exit 1; \
    fi

# Bases such as ubuntu:24.04 and the Python dev container have no Node, so add it.
RUN set -eux; \
    if ! command -v node >/dev/null 2>&1; then \
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    node --version

ARG CLAUDE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && claude --version

WORKDIR /work
CMD ["bash", "-l"]
