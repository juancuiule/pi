# Shell sandbox: a plain Linux userland for the agent's bash/read/write/edit tools.
# The pi-env daemon is copied in when a sandbox starts, so this image does not depend on the pi-env version;
# so is the Shell tab's `open` command (./open), which desktop containers must not get.
FROM ubuntu:24.04

# The tools agents reach for first, so a task does not start with "command not found" (docs/adr/0009-*).
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl file git jq less procps python-is-python3 python3 ripgrep sqlite3 unzip wget xz-utils zip \
  && rm -rf /var/lib/apt/lists/*

# Python packaging: uv (checked against the release's sha256), and pip for the system python3, with Ubuntu's
# EXTERNALLY-MANAGED marker removed so `pip install` works system-wide as root, as agents expect. Tools that uv or
# pip install for the user land in /root/.local/bin, which is on PATH.
RUN case $(uname -m) in \
    x86_64) SHA=2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66 ;; \
    aarch64) SHA=9db0c2f6683099f86bfeea47f4134e915f382512278de95b2a0e625957594ff3 ;; \
    *) exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/0.9.5/uv-$(uname -m)-unknown-linux-gnu.tar.gz" \
  && echo "$SHA  /tmp/uv.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
  && rm /tmp/uv.tar.gz \
  && uv pip install --system --break-system-packages --no-cache pip==25.2 \
  && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
  && printf "[global]\nroot-user-action = ignore\n" > /etc/pip.conf
ENV PATH=/root/.local/bin:$PATH

# A missing command says how to get it (./sandbox-env.sh), in the agent's `bash -c` and in the Shell tab alike.
COPY sandbox-env.sh /etc/sandbox-env.sh
RUN echo ". /etc/sandbox-env.sh" >> /etc/bash.bashrc
ENV BASH_ENV=/etc/sandbox-env.sh

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
