# Shell sandbox: a plain Linux userland for the agent's bash/read/write/edit tools.
# The pi-env daemon is copied in when a sandbox starts, so this image does not depend on the pi-env version;
# so is the Shell tab's `open` command (./open), which desktop containers must not get.
FROM ubuntu:24.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
CMD ["sleep", "infinity"]
