#!/bin/sh
# Starts the virtual display, the XFCE session, the VNC server and its WebSocket bridge, then marks the desktop ready.
set -e
export DISPLAY=:99

Xvfb :99 -screen 0 "${SCREEN_WIDTH:-1280}x${SCREEN_HEIGHT:-800}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done

dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
# Ready means the desktop and panel are drawn, so the first screenshot is not a blank screen
until xdotool search --class xfdesktop >/dev/null 2>&1 \
  && xdotool search --class xfce4-panel >/dev/null 2>&1; do sleep 0.2; done
sleep 1
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &
websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
# Both start in the background; ready must wait until they accept, or the server's first relay is refused
for port in 5900 6080; do
  until python3 -c "import socket; socket.create_connection(('127.0.0.1', $port), 1)" 2>/dev/null; do sleep 0.1; done
done

touch /tmp/desktop-ready
wait
