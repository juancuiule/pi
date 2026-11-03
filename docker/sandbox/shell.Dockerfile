# Shell sandbox: a plain Linux userland for the agent's bash/read/write/edit tools.
# The pi-env daemon is copied in when a sandbox starts, so this image does not depend on the pi-env version;
# so is the Shell tab's `open` command (./open), which desktop containers must not get.
FROM ubuntu:24.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Google Chrome, for agent-browser: Google ships it for amd64 and, since July 2026, arm64 Linux, where Chrome for
# Testing (what `agent-browser install` fetches) has no build.
RUN curl -fsSL -o /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_$(dpkg --print-architecture).deb" \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb \
  && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb

# agent-browser (skills/agent-browser), from its npm package, which npm's integrity hash vouches for: the binary
# for this architecture plus the skill folders `agent-browser skills get` reads beside it (the GitHub release's
# binary alone has none). The sha256 pins the package; a replaced file fails the build.
RUN curl -fsSL -o /tmp/agent-browser.tgz https://registry.npmjs.org/agent-browser/-/agent-browser-0.39.1.tgz \
  && echo "9efb4de1a5406f1b32dfcca2890e272053caace3369b6294d47240384e0a4732  /tmp/agent-browser.tgz" | sha256sum -c - \
  && BIN=agent-browser-linux-$(dpkg --print-architecture | sed "s/amd64/x64/") \
  && mkdir -p /opt/agent-browser \
  && tar -xzf /tmp/agent-browser.tgz -C /opt/agent-browser --strip-components=1 \
    package/LICENSE package/skills package/skill-data package/bin/$BIN \
  && chmod +x /opt/agent-browser/bin/$BIN \
  && ln -s /opt/agent-browser/bin/$BIN /usr/local/bin/agent-browser \
  && rm /tmp/agent-browser.tgz

WORKDIR /workspace
CMD ["sleep", "infinity"]
