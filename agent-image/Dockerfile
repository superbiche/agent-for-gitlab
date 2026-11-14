ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG GLAB_VERSION=1.102.0
ARG GH_VERSION=2.101.0
ARG OPENCODE_AI_VERSION=1.18.18

LABEL org.opencontainers.image.source="https://github.com/Schickli/ai-code-for-gitlab" \
	  org.opencontainers.image.title="AI GitLab Agent" \
	  org.opencontainers.image.description="Reusable base image for AI GitLab pipeline runner" \
	  org.opencontainers.image.licenses="MIT"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq \
	&& curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" \
	&& dpkg -i /tmp/glab.deb \
	&& rm -f /tmp/glab.deb \
	&& curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" \
	&& dpkg -i /tmp/gh.deb \
	&& rm -f /tmp/gh.deb \
	&& rm -rf /var/lib/apt/lists/*

# Match the managed local pre-commit scanner; checksum from the official release.
RUN curl -fsSL -o /tmp/trufflehog.tar.gz "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.0/trufflehog_3.97.0_linux_amd64.tar.gz" \
    && echo "62224de2f9dd7cd418800feb953760a302ed2f82a7c547fe1146a4874fb179e4  /tmp/trufflehog.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/trufflehog.tar.gz -C /usr/local/bin trufflehog \
    && trufflehog --version 2>&1 | grep -F '3.97.0' \
    && rm /tmp/trufflehog.tar.gz

RUN npm install -g "opencode-ai@${OPENCODE_AI_VERSION}"

COPY agent-image/opencode-bootstrap/ /opt/opencode-bootstrap/
RUN cd /opt/opencode-bootstrap && npm ci --ignore-scripts --omit=dev

# Pi (alternative harness, selected per job with AGENT_HARNESS=pi; OpenCode stays the
# default). Version and integrity are pinned by agent-image/pi-bootstrap/package-lock.json;
# nothing is fetched at job time. Pi requires Node >= 22.19, checked here so a floating
# base image cannot silently ship an unsupported runtime.
COPY agent-image/pi-bootstrap/ /opt/pi-bootstrap/
RUN node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<19)) { console.error("Pi needs Node >= 22.19, got "+process.version); process.exit(1); }' \
	&& cd /opt/pi-bootstrap && npm ci --ignore-scripts --omit=dev \
	&& ln -s /opt/pi-bootstrap/node_modules/.bin/pi /usr/local/bin/pi \
	&& test "$(pi --version)" = "1.5.2"

# Copy runner sources
WORKDIR /opt/agent
COPY agent-image/scripts/ /opt/agent/
COPY prompts/ /opt/agent/prompts/
RUN npm ci --omit=dev

# Build gate: the guard's reproduction of Pi's path rules and the delivered-lines accounting are
# compared with the Pi installed above. REQUIRE_PI_DIST=1 turns a missing Pi into a failure, so an
# image whose guard and Pi disagree (a Pi bump that changed a rule, a wrong pin) cannot be built.
RUN PI_DIST=/opt/pi-bootstrap/node_modules/@earendil-works/pi-coding-agent/dist REQUIRE_PI_DIST=1 \
	node --test test/pi-path-rules.test.js test/pi-native-read.test.js

# Node ESM support and convenience launcher
RUN printf "#!/usr/bin/env sh\nnode /opt/agent/ai-runner.js \"$@\"\n" > /usr/local/bin/ai-runner \
	&& chmod +x /usr/local/bin/ai-runner

# Default shell; CI jobs will invoke `ai-runner`
CMD ["sh"]
