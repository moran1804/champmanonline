#!/bin/sh
# Seat start-up: virtual screen (TigerVNC) → noVNC bridge (:6080) → sound stream (:6081)
# → one-time Wine set-up → command.
set -e
GEOMETRY="${SEAT_GEOMETRY:-800x600}"
Xvnc :1 -geometry "$GEOMETRY" -depth 24 -SecurityTypes None -localhost yes -AlwaysShared \
  -AcceptSetDesktopSize=0 >/tmp/xvnc.log 2>&1 &
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
/opt/websockify/bin/websockify 6080 localhost:5901 >/tmp/websockify.log 2>&1 &

# Sound: games play into the "seat" null sink. Each browser connection to :6081 gets the sink's
# output as raw 22.05 kHz mono mu-law (~176 kbit/s), small enough to stream with very little delay.
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
pulseaudio --daemonize=yes --exit-idle-time=-1 -n --log-target=file:/tmp/pulse.log \
  --load="module-null-sink sink_name=seat rate=22050 channels=1 sink_properties=device.description=Seat" \
  --load="module-native-protocol-unix"
for i in $(seq 1 50); do pactl info >/dev/null 2>&1 && break; sleep 0.1; done
pactl set-default-sink seat
socat TCP-LISTEN:4714,bind=127.0.0.1,reuseaddr,fork \
  EXEC:"parec -d seat.monitor --raw --format=ulaw --rate=22050 --channels=1 --latency-msec=20" >/tmp/audio.log 2>&1 &
/opt/websockify/bin/websockify 6081 localhost:4714 >/tmp/websockify-audio.log 2>&1 &

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
