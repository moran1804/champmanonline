#!/usr/bin/env python3
"""Control API for one seat. Only the app container talks to it (port 7000, internal network).

  POST /start   header X-Seat-Game: base64 JSON game config; body: the player's save zip (may be empty)
                → resets the game from its read-only master copy, lays the save over it, starts it
  GET  /save    → zip of every file that differs from the master copy (204 when nothing differs)
  POST /stop    → stops the game
  GET  /status  → {"running": bool}

Every request needs "Authorization: Bearer $SEAT_TOKEN".
"""
import base64
import hmac
import io
import json
import os
import shutil
import signal
import subprocess
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = os.environ["WINEPREFIX"]
GAMES_ROOT = os.environ.get("GAMES_ROOT", "/games")
TOKEN = os.environ.get("SEAT_TOKEN", "")
MAX_SAVE_BYTES = 200 * 1024 * 1024

lock = threading.Lock()
state = {"proc": None, "workdir": None, "baseline": {}}


def win_to_unix(win_path: str) -> str:
    """C:\\Program Files (x86)\\X → $WINEPREFIX/drive_c/Program Files (x86)/X"""
    drive, _, rest = win_path.partition(":")
    if drive.lower() != "c" or ".." in rest.replace("\\", "/").split("/"):
        raise ValueError("windowsPath must be on C: and must not contain ..")
    return os.path.join(PREFIX, "drive_c", *[p for p in rest.replace("\\", "/").split("/") if p])


def inside(base: str, rel: str) -> str:
    path = os.path.realpath(os.path.join(base, rel))
    if path != base and not path.startswith(base + os.sep):
        raise ValueError(f"path escapes the game folder: {rel}")
    return path


def file_stats(root: str) -> dict:
    out = {}
    for dirpath, _, names in os.walk(root):
        for n in names:
            full = os.path.join(dirpath, n)
            st = os.stat(full)
            out[os.path.relpath(full, root)] = (st.st_size, int(st.st_mtime))
    return out


def stop_game():
    proc = state["proc"]
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    subprocess.run(["wineserver", "-k"], check=False)
    subprocess.run(["wineserver", "-w"], check=False, timeout=30)
    state["proc"] = None


def start(cfg: dict, save_zip: bytes):
    stop_game()
    master = inside(GAMES_ROOT, os.path.join(cfg["folder"], cfg["installDir"]))
    if not os.path.isdir(master):
        raise ValueError("master copy not found")
    workdir = win_to_unix(cfg["windowsPath"])

    # Fresh copy of the installed game (copy2 keeps the master's timestamps for change detection).
    shutil.rmtree(workdir, ignore_errors=True)
    shutil.copytree(master, workdir, copy_function=shutil.copy2)
    state["baseline"] = file_stats(workdir)
    state["workdir"] = workdir

    if save_zip:
        with zipfile.ZipFile(io.BytesIO(save_zip)) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                dest = inside(workdir, info.filename)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(info) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)

    # The game's CD: D: points at the unpacked disc (its .windows-label gives the volume name).
    dosdevices = os.path.join(PREFIX, "dosdevices")
    d = os.path.join(dosdevices, "d:")
    if os.path.lexists(d):
        os.remove(d)
    if cfg.get("discDir"):
        os.symlink(inside(GAMES_ROOT, os.path.join(cfg["folder"], cfg["discDir"])), d)

    # Registry keys the installer wrote (into the 32-bit view, as the 32-bit installer did).
    if cfg.get("registry"):
        reg = inside(GAMES_ROOT, os.path.join(cfg["folder"], cfg["registry"]))
        subprocess.run(["wine", "C:\\windows\\syswow64\\regedit.exe", "/S", "Z:" + reg.replace("/", "\\")], check=False)
        subprocess.run(["wineserver", "-w"], check=False, timeout=60)

    state["proc"] = subprocess.Popen(
        ["wine", cfg["exe"], *cfg.get("args", [])],
        cwd=workdir,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def build_save() -> bytes | None:
    workdir = state["workdir"]
    if not workdir or not os.path.isdir(workdir):
        return None
    # Don't zip a file the game is halfway through writing: wait (up to 10 s) for writes to settle.
    for _ in range(10):
        now = time.time()
        changed = [
            rel
            for rel, st in file_stats(workdir).items()
            if state["baseline"].get(rel) != st
        ]
        if all(now - os.stat(os.path.join(workdir, r)).st_mtime > 2 for r in changed):
            break
        time.sleep(1)
    if not changed:
        return None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in sorted(changed):
            z.write(os.path.join(workdir, rel), rel.replace(os.sep, "/"))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _auth(self) -> bool:
        got = self.headers.get("Authorization", "")
        if TOKEN and hmac.compare_digest(got, f"Bearer {TOKEN}"):
            return True
        self._json(401, {"error": "unauthorised"})
        return False

    def _json(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._auth():
            return
        with lock:
            if self.path == "/status":
                proc = state["proc"]
                return self._json(200, {"running": bool(proc and proc.poll() is None)})
            if self.path == "/save":
                data = build_save()
                if data is None:
                    self.send_response(204)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_SAVE_BYTES:
            return self._json(413, {"error": "save too large"})
        body = self.rfile.read(length) if length else b""
        with lock:
            try:
                if self.path == "/start":
                    cfg = json.loads(base64.b64decode(self.headers["X-Seat-Game"]))
                    start(cfg, body)
                    return self._json(200, {"ok": True})
                if self.path == "/stop":
                    stop_game()
                    return self._json(200, {"ok": True})
            except Exception as e:  # report, don't crash the agent
                return self._json(500, {"error": str(e)})
        self._json(404, {"error": "not found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 7000), Handler).serve_forever()
