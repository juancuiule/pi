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
