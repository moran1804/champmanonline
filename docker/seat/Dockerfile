# A "seat": one Windows game running in Wine on a virtual screen, streamed to the browser with noVNC.
# Arch's Wine is built in WoW64 mode, so 32-bit games run without 32-bit Linux libraries.
FROM archlinux:latest

RUN pacman -Syu --noconfirm --disable-sandbox \
      wine tigervnc unshield libarchive xdotool xorg-xdpyinfo ttf-liberation python python-pip \
      pulseaudio libpulse socat \
 && pacman -Scc --noconfirm \
 && rm -rf /var/cache/pacman/pkg/*

# websockify bridges the browser's WebSocket to VNC; the noVNC viewer itself is served by the app.
ARG WEBSOCKIFY_VERSION=0.13.0
RUN python -m venv /opt/websockify \
 && /opt/websockify/bin/pip install --no-cache-dir websockify==${WEBSOCKIFY_VERSION}

# Sound: the game plays into a PulseAudio null sink, which start-seat streams to the browser.
# ALSA's default is a null device as a fallback, so a game never fails for lack of a sound card.
RUN printf 'pcm.!default { type null }\nctl.!default { type hw card 0 }\n' > /etc/asound.conf

RUN useradd -m -u 1000 player && install -d -o player -g player /home/player/.wine
ENV WINEPREFIX=/home/player/.wine WINEDEBUG=-all DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/runtime-player \
    WINEDLLOVERRIDES="mscoree,mshtml="
COPY --chmod=755 start-seat.sh /usr/local/bin/start-seat
COPY --chmod=755 seat-agent.py /usr/local/bin/seat-agent
USER player
WORKDIR /home/player
ENV GAMES_ROOT=/games
EXPOSE 6080 6081 7000
ENTRYPOINT ["/usr/local/bin/start-seat"]
CMD ["/usr/local/bin/seat-agent"]
