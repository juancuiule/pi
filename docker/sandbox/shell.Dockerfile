# Shell sandbox: a plain Linux userland for the agent's bash/read/write/edit tools.
# The pi-env daemon is copied in when a sandbox starts, so this image does not depend on the pi-env version.
FROM ubuntu:24.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

# How a sandboxed process leaves the agent a message; the host drains the spool it writes (src/sandbox/notify.ts).
COPY pi-notify /usr/local/bin/pi-notify
RUN chmod +x /usr/local/bin/pi-notify

WORKDIR /workspace
CMD ["sleep", "infinity"]
