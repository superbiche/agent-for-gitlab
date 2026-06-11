ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG GLAB_VERSION=1.102.0
ARG OPENCODE_AI_VERSION=1.17.3

LABEL org.opencontainers.image.source="https://github.com/Schickli/ai-code-for-gitlab" \
	  org.opencontainers.image.title="AI GitLab Agent" \
	  org.opencontainers.image.description="Reusable base image for AI GitLab pipeline runner" \
	  org.opencontainers.image.licenses="MIT"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq \
	&& curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" \
	&& dpkg -i /tmp/glab.deb \
	&& rm -f /tmp/glab.deb \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g "opencode-ai@${OPENCODE_AI_VERSION}"

# Copy runner sources
WORKDIR /opt/agent
COPY agent-image/scripts/ /opt/agent/
COPY prompts/ /opt/agent/prompts/
RUN npm ci --omit=dev

# Node ESM support and convenience launcher
RUN printf "#!/usr/bin/env sh\nnode /opt/agent/ai-runner.js \"$@\"\n" > /usr/local/bin/ai-runner \
	&& chmod +x /usr/local/bin/ai-runner

# Default shell; CI jobs will invoke `ai-runner`
CMD ["sh"]
