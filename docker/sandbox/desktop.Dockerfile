# Desktop sandbox, after E2B's desktop template: the shell sandbox plus XFCE on a virtual display, xdotool and
# scrot for control, and websockify on port 6080 so a person can watch: the server relays its VNC stream to the
# console's own noVNC client, so the image serves no web pages. Built on the shell image, so an Upgrade from
# shell to desktop never loses a tool; `pnpm sandbox:build` builds the shell image first.
ARG SHELL_IMAGE=effect-pi/sandbox-shell
FROM ${SHELL_IMAGE}

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11-utils dbus-x11 xfce4 xfce4-terminal mousepad \
    x11vnc websockify xdotool scrot at-spi2-core \
  && rm -rf /var/lib/apt/lists/*

# agent-desktop (skills/agent-desktop): the release archive for this architecture, checked against the release's
# checksums.txt; it holds the CLI and the clipboard helper it expects beside it.
RUN case $(dpkg --print-architecture) in \
    amd64) TRIPLE=x86_64-unknown-linux-gnu SHA=ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4 ;; \
    arm64) TRIPLE=aarch64-unknown-linux-gnu SHA=864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb ;; \
    *) exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/agent-desktop.tar.gz "https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-$TRIPLE.tar.gz" \
  && echo "$SHA  /tmp/agent-desktop.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/agent-desktop.tar.gz -C /usr/local/bin \
  && rm /tmp/agent-desktop.tar.gz

COPY desktop-start.sh /usr/local/bin/desktop-start
RUN chmod +x /usr/local/bin/desktop-start

ENV DISPLAY=:99
# The session bus is at a fixed address, so every process (the agent's commands through docker exec, the Shell tab)
# reaches the desktop's apps and its accessibility bus, which tools such as agent-desktop read the apps through.
# Qt and Chromium apps join the accessibility bus only when asked; GTK apps always do.
ENV XDG_RUNTIME_DIR=/run/user/0 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus \
  QT_ACCESSIBILITY=1 \
  ACCESSIBILITY_ENABLED=1
EXPOSE 6080
CMD ["desktop-start"]
