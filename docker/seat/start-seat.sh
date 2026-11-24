#!/bin/sh
# Seat start-up: virtual screen (TigerVNC) → noVNC bridge (:6080) → one-time Wine set-up → command.
set -e
GEOMETRY="${SEAT_GEOMETRY:-800x600}"
Xvnc :1 -geometry "$GEOMETRY" -depth 24 -SecurityTypes None -localhost yes -AlwaysShared \
  -AcceptSetDesktopSize=0 >/tmp/xvnc.log 2>&1 &
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
/opt/websockify/bin/websockify 6080 localhost:5901 >/tmp/websockify.log 2>&1 &

if [ ! -f "$WINEPREFIX/.cmo-ready" ]; then
  wineboot -i >/dev/null 2>&1
  wineserver -w
  # Old games check the Windows version (CM 01/02 asks for "Service Pack 3" otherwise).
  wine reg add 'HKCU\Software\Wine' /v Version /d winxp /f >/dev/null 2>&1
  # D: is the game's CD; the agent points it at the unpacked disc for each session.
  wine reg add 'HKLM\Software\Wine\Drives' /v d: /d cdrom /f >/dev/null 2>&1
  wineserver -w
  touch "$WINEPREFIX/.cmo-ready"
fi
exec "$@"
