# Desktop sandbox, after E2B's desktop template: Ubuntu with XFCE on a virtual display, xdotool and scrot for
# control, and noVNC on port 6080 so a person can watch. Also has everything the shell sandbox has.
FROM ubuntu:22.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git jq python3 ripgrep \
    xvfb x11-utils dbus-x11 xfce4 xfce4-terminal mousepad \
    x11vnc novnc websockify xdotool scrot \
  && rm -rf /var/lib/apt/lists/*

COPY desktop-start.sh /usr/local/bin/desktop-start
RUN chmod +x /usr/local/bin/desktop-start

ENV DISPLAY=:99
WORKDIR /workspace
EXPOSE 6080
CMD ["desktop-start"]
