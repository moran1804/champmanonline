# ChampMan Online

**champmanonline.co.uk** is a private website where approved users sign in and play the classic Championship Manager games in their browser. Their careers are saved to their account.

- **DOS games** run entirely in the player's browser with [js-dos](https://js-dos.com) (DOSBox compiled to WebAssembly), so the server does no emulation.
- **The server** (Fastify + SQLite) handles accounts and admin approval, sends out the game bundles, and stores each user's save files.
- **Hosting** is on TrueNAS as a Custom App, published through a Cloudflare Tunnel.
- **Phones and tablets** are supported: tap to click, long-press to right-click, the phone's own keyboard via ⌨, and side controls when the phone is held sideways.

Currently playable: **CM1, CM Italia, CM 93/94, CM2 (v1.56), CM 96/97 and CM 97/98** (DOS, in the browser) and **CM 01/02** (Windows, streamed from a seat). The other Windows versions show as "Coming soon".

## How it works

```
Browser ── Cloudflare ── cloudflared ── app container (:8080)
                                          ├─ /api/*            auth, admin, games, saves
                                          ├─ /, /player.html   React site + isolated emulator page
                                          ├─ /jsdos/*          self-hosted js-dos 8.3.20
                                          ├─ /games (ro)       original game folders
                                          └─ /data             app.db, saves/, cache/bundles/
```

- **Game bundles.** For each game, the server zips the `<folder>/Game Files` directory together with a generated `dosbox.conf`, caches the result under `/data/cache/bundles`, and sends it only to approved users. The bundle URL includes a version hash, so browsers cache it permanently and still fetch a new copy when the files change.
- **Saves.** A save slot is a zip of every file the game has changed compared with the original install (for CM 93/94 that's `SVGAME`, `PLHIST` and so on).
  - When a slot is loaded, the player lays this zip over the clean game files.
  - The player checks for changed files every 30 seconds, when **Save to cloud** is pressed, when **Exit game** is pressed, and when the tab is hidden. Any changes are merged into the slot and uploaded.
  - Players save inside the game as normal, then use the game's own *Load Game* when they come back.
- **Player isolation.** The emulator runs in `player.html` inside an iframe, because js-dos's global CSS (Tailwind/daisyUI) would otherwise restyle the site.
- **js-dos is pinned to 8.3.20.** In testing in November 2026, versions 8.4.x to 8.5.4 never reached the `ci-ready` event for any bundle, while 8.3.20 boots CM 93/94 correctly. Re-test before upgrading.

## Local development

Requires Node 24 or later, which provides the built-in `node:sqlite` and runs TypeScript directly.

```bash
npm install
cp .env.example .env
npm run build          # builds the site into apps/web/dist (also copies js-dos)
npm run dev:api        # http://localhost:8080, serves API + built site
# optional hot-reload frontend: npm run dev:web → http://localhost:5173 (proxies /api)
```

The game files are read from `./Game Files` by default. Set `GAMES_ROOT` to use another location.

## Deploying to TrueNAS

1. **Build the image.** Push this repo to GitHub. The workflow in `.github/workflows/docker.yml` builds a `linux/amd64` image and publishes it to `ghcr.io/<you>/champmanonline:latest`. Then do one of the following:
   - Make the GHCR package public.
   - Or add GHCR credentials in TrueNAS under Apps → Configuration → Docker Registries.
2. **Create the folders on the NAS.** Make `/mnt/<pool>/apps/champmanonline/data` and `/mnt/<pool>/apps/champmanonline/games`, then copy the contents of `Game Files/` into `games/` so that each version is its own sub-folder. Give the TrueNAS `apps` user (568) access to both: read-write on `data`, read-only on `games`.
3. **Create the Cloudflare tunnel.** In Cloudflare Zero Trust, go to Networks → Tunnels and create a tunnel. Add a public hostname `champmanonline.co.uk` pointing to the service `http://app:8080`, and copy the tunnel token.
4. **Install the app.** In TrueNAS, go to Apps → Discover Apps → ⋮ → **Install via YAML**. Paste `deploy/truenas-app.yaml` and fill in every `CHANGE_ME`.
5. **Sign in as admin.** Visit https://champmanonline.co.uk and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

**Accounts.** Players sign up with only a username and password and are signed in straight away. There's no email, so a forgotten password has to be reset by an admin. The **Admin** page lists everyone and can disable an account. Set `REQUIRE_APPROVAL=true` to make new accounts wait for approval instead.

**Back up the `data` folder.** It holds every user's account and saves.

## Adding the next DOS game

1. In `games/catalog.json`, set the game's entry to `"enabled": true` and add a `dosbox` block, for example:
   ```json
   "dosbox": { "cycles": "max 80%", "autoexec": ["mount c .", "c:", "cm2.exe"] }
   ```
   Games that need a CD image also need an `imgmount` line here.
2. Check that the game boots locally (`npm run build:bundle <id>` builds its bundle), then deploy.

Other catalog options:

| Option | What it does |
|---|---|
| `gameSubdir` | Folder holding the game inside `folder`. Defaults to `"Game Files"`; use `"."` for the folder itself, as CM2 v1.56 does. |
| `coverFolder` | Takes the cover image from another version folder. |
| `exclude` | Files or folders to leave out of the bundle, such as Windows launchers or installers. |
| `files` | Replaces a file's text inside the bundle, for example a `config.dat` that points at the wrong drive. |
| `lookupFile` | The manual-answer table, if its file name doesn't contain "results". |
| `note` | A message shown on the game's page. |

**CD games** (such as CM2 v1.56) mount their original CD image with an `imgmount d game.iso -t iso -fs iso` line in `autoexec`. Their bundles are large. CM2's is about 236 MB, so the first play is a big download, and after that the browser keeps a copy in Cache Storage.

**Bundles** are zipped as a stream and cached in `/data/cache/bundles`. The first player to open a game after its files change waits for the build, which takes about 8 seconds for CM2.

## Windows games (seats)

Windows games can't run in the browser, so they run on the server and are streamed:

```
Browser ──(signed-in WebSocket /api/seat/ws)── app ──► seatN: Xvnc + websockify + Wine (+ seat agent :7000)
```

- **Seats.** A seat (`docker/seat`, image `champmanonline-seat`) is one Wine "PC" with an 800×600 virtual screen. The TrueNAS YAML defines a fixed pool of them (`seat1`…`seat4`), and the app hands out a free one when someone presses Play. The app never gets access to Docker.
- **The stream.** Only the player who owns a seat can open its stream; the app checks their session and relays the WebSocket to that seat's websockify. The browser shows it with noVNC (`seat.html`, which offers the Play page the same API as the DOS player).
- **Saves.** Each session starts from a fresh copy of the game's read-only master install, with the player's slot files laid on top. The slot is every file that differs from the master. The app copies it into the slot every minute, on **Save to cloud** and when the session ends (Exit, the game closing, 5 minutes after the tab closes, or `SEAT_IDLE_MINUTES` without input).
- **The game's CD** is the unpacked disc mounted as `D:` (with a `.windows-label` file for its volume name), so the original CD check passes without any crack.

### Adding a Windows game
1. Install it once in a seat (run its installer under Wine against the unpacked disc) and copy the installed folder to `<version folder>/Installed`. Put the unpacked disc in `<version folder>/Disc`, and export the installer's registry keys to `<version folder>/install.reg`.
2. Add a `seat` block to its catalog entry and set `"emulator": "wine"`, as for CM 01/02:
   ```json
   "seat": { "installDir": "Installed", "windowsPath": "C:\\Program Files (x86)\\Championship Manager 01-02",
             "exe": "cm0102.exe", "discDir": "Disc", "registry": "install.reg" }
   ```

**Testing seats needs an x86 machine.** On Apple Silicon, Rosetta can't run 32-bit Windows code inside Linux, so build and test seats on the NAS.

## Roadmap

- **Phase 2:** the rest of the DOS games (CM1, Italia, CM2, 96/97, 97/98).
- **V2 (in progress):** Windows games via seats. CM 01/02 is done; next CM 03/04, then test CM 99/00, 00/01 and CM4 (without cracks), and touch support for seats.
