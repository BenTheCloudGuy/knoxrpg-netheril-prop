# Netheril Dungeon Runner: Copilot Instructions

## Project Purpose

This repository powers a physical Dungeons & Dragons scrying prop. A Raspberry Pi reads RFID-tagged crystals, lights a WS281x ring, and drives a 1920x1080 Firefox touchscreen kiosk. Each crystal maps to one of the eight schools of magic and opens four Markdown-backed clue pages. A separate GM console manages crystals, clue content, updates, logs, and host power controls.

Treat the prop as an appliance used during a live game: recovery, predictable state transitions, touch ergonomics, and hardware-safe behavior matter more than adding framework complexity.

## Source Of Truth

- Use `src/server.js` and the current HTML files as the behavioral source of truth.
- `README.md` is useful orientation but contains stale hand-scanner behavior, unused OpenAI variables, and an old repository path.
- `notes.md`, `5eItems.md`, and `config/{blue,green,purple,red,translation}.md` are campaign/reference material, not runtime inputs.
- `src/public/index.html.bak*`, `src/public-gm/index.html.bak`, and `src/public/img/schools/_orig_backup/` are backups. Do not edit them unless explicitly asked.
- All eight school-specific center-sigil games are implemented. Their prizes are GM-configured messages; do not assume physical prize-control hardware exists.

## Runtime Architecture

One Node.js process in `src/server.js` owns both HTTP servers and hardware state.

- Player server: Express static site and WebSocket server on port `3000`.
- GM server: Express static site, JSON APIs, and SSE streams on port `3001`.
- Player UI: `src/public/index.html`, a self-contained HTML/CSS/JavaScript kiosk application.
- GM UI: `src/public-gm/index.html`, a self-contained HTML/CSS/JavaScript administration application.
- Crystal registry: `config/config.yaml`.
- Clue content: 32 files in `src/public/pages/`, named `<school>_<location>.md`.
- Legacy/future map data: `config/sites.json` and `config/pins.json`; APIs exist, but the current player and GM screens do not expose this data.

There is no frontend build step, component framework, database, test framework, linter configuration, or TypeScript compiler. Preserve the low-dependency appliance architecture unless a requested feature clearly justifies changing it.

## Current Player State Machine

The current behavior is crystal-gated, not hand-gated.

1. With no crystal, `view-landing` shows all school sigils and the message "Seek the crystals to unlock the treasures, clues, and dangers."
2. A WebSocket `crystal` event sets the accent/theme and opens `view-cross` after a short reveal.
3. The four directional glyphs fetch `/api/page/:school/:location` and open `view-page`.
4. The center sigil opens the school-specific game. Five failures end a run, while correct actions reduce the failure count.
5. A completed game calls the server with the insertion token and locks the kiosk on `view-prize` until crystal removal.
6. Closing a page or unfinished game returns to `view-cross` while the crystal remains active.
7. A `removed` event returns to `view-landing` and clears game timers and crystal state.
8. A `reload` event hard-reloads the player display.

The server still reads the Kano motion sensor and broadcasts `hand-on` and `hand-off` for compatibility/simulation, but `src/public/index.html` intentionally does not use those messages to gate navigation. Do not reintroduce a hand prompt or hand requirement unless explicitly requested.

## WebSocket Contract

The WebSocket endpoint shares the player HTTP server on port `3000`.

- `crystal`: `{ type, insertionId, tagId, tagHex, color, school, name, emulated, gameId, gameCompleted, glyphPrizeClaimed, prize? }`
- `removed`: `{ type: "removed" }`
- `hand-on`: `{ type: "hand-on" }` (currently ignored by player UI)
- `hand-off`: `{ type: "hand-off" }` (currently ignored by player UI)
- `reload`: `{ type: "reload" }`

On connection, the server sends either the current crystal or `removed`. A completed game's prize is included in the crystal snapshot so reloads restore the locked Prize page. `glyphPrizeClaimed` remains as an Illusion compatibility field. Keep reconnect handling and idempotent state updates intact.

## Hardware Contract

Production mode is the default. `SIM_MODE=true` must be set before loading `src/server.js` to avoid importing or initializing Pi-only hardware modules.

### RFID Reader

- Device: RDM6300 on `/dev/serial0` at 9600 baud.
- Frame: STX (`0x02`) + 2 hex version characters + 8 hex tag characters + 2 hex checksum characters + ETX (`0x03`), 14 bytes total.
- Checksum: XOR of the five bytes represented by version plus tag hex.
- Input is decoded as `latin1`; preserve byte values and the resynchronizing bounded buffer.
- A valid tag refreshes `lastSeenTime`; 500 ms without a frame means removal.
- Hex identifiers are normalized to uppercase without a required `0x` prefix.

### Kano Motion Sensor

- USB CDC serial defaults to `/dev/ttyACM0` at 115200 baud.
- Override only the device path with `MOTION_PORT`.
- Input is newline-delimited JSON shaped like `{"name":"proximity-data","detail":{"proximity":N}}`.
- A proximity value at or above 230 triggers hand-on. The sensor logic treats data silence while covered as still on and uses a one-second low-data timeout for hand-off.
- This sensor remains part of the server/simulator contract even though the current player UI does not gate on it.

### LED Ring

- Six WS281x LEDs use GPIO 18, physical pin 12, DMA 10, brightness 255, and GRB strip order.
- The ring fills with the active crystal color and turns off on removal or process cleanup.
- `black` intentionally maps to `0x000000`, so a necromancy crystal turns the ring off.
- Keep all hardware calls behind `!SIM_MODE` or the existing simulation-safe helpers.
- Do not exercise GPIO, serial devices, reboot, shutdown, or systemd controls as part of routine development validation.

## Crystal And Content Invariants

The canonical color-to-school mapping is:

| Color | School |
| --- | --- |
| `white` | `abjuration` |
| `blue` | `conjuration` |
| `yellow` | `divination` |
| `pink` | `enchantment` |
| `red` | `evocation` |
| `orange` | `illusion` |
| `black` | `necromancy` |
| `green` | `transmutation` |

### School Game Mapping

Each school owns one distinct center-sigil trial. Keep this mapping stable unless the campaign design is explicitly changed.

| Color | School | Game | Theme | Status |
| --- | --- | --- | --- | --- |
| `white` | `abjuration` | Trap Disarmament | Break defensive wards without touching unstable runes. | Implemented |
| `blue` | `conjuration` | Weave Lock | Align planar paths to open a summoning portal. | Implemented |
| `yellow` | `divination` | Wheel of Fate | Reveal a hidden dungeon phrase by choosing letters. | Implemented |
| `pink` | `enchantment` | The Lying Statues | Read magically influenced testimony and identify the liar. | Implemented |
| `red` | `evocation` | Runic Sequence | Repeat an increasingly volatile sequence of energy runes. | Implemented |
| `orange` | `illusion` | Glyph Matching | See through concealed sigils and match all eight pairs. | Implemented |
| `black` | `necromancy` | Monster Silhouette | Identify creatures from ominous shadows and deathly clues. | Implemented |
| `green` | `transmutation` | Potion Mixing | Transform ingredients into the requested magical mixture. | Implemented |

Do not silently fall back to Glyph Matching for another school. Keep game timers in the shared cleanup registry so removal, close, and insertion changes cannot leave delayed actions running.

- Keep `LED_COLORS`, `COLOR_TO_SCHOOL`, player theme classes, GM swatches, and school assets synchronized when changing colors.
- The GM API derives `school` from `color`; do not introduce a conflicting independent mapping in `config/config.yaml`.
- Valid page locations are exactly `top`, `bottom`, `left`, and `right`.
- Keep all 32 school/location files present. The player endpoint validates both path segments before reading a file.
- The browser uses a deliberately small local Markdown renderer. Confirm its supported syntax in `renderMarkdown()` before adding content features; do not assume full CommonMark or raw HTML support.
- GM page writes are capped at 50,000 characters. Crystal names are capped at 100 characters.

## HTTP API Ownership

Player server (`3000`):

- `GET /api/page/:school/:location`
- `GET /api/fonts`
- `GET /api/sites`, `GET /api/sites/:id`
- `GET /api/pins`, `GET /api/pins/:id`
- `POST /api/games/:gameId/complete` with the active `X-Netheril-Insertion` header
- `POST /exit`

GM server (`3001`):

- Crystal CRUD at `/api/crystals`
- Crystal emulation at `/api/emulation/status`, `/api/emulation/crystal`, and `/api/emulation/crystal-remove`
- School page list/read/write at `/api/school-pages`
- `GET /api/game-prizes` and `PUT /api/game-prizes/:gameId`
- `POST /api/reload-player`
- Site and pin CRUD at `/api/sites` and `/api/pins`
- `GET /api/update` and `GET /api/logs` are SSE streams
- `POST /api/restart`, `/api/reboot`, and `/api/shutdown` affect the host
- `/api/sim/*` and `/sim/` exist only when `SIM_MODE=true`

Preserve the port boundary when adding calls: relative URLs from the GM page reach port 3001, while its WebSocket and player assets explicitly target port 3000.

## Frontend Conventions

- Keep both interfaces dependency-free and self-contained unless the task requires a larger migration.
- Preserve the established Netherese visual language, bundled fonts, school sigils, 16:9 kiosk composition, and touch-sized controls.
- The primary kiosk is 1920x1080, but changes must remain usable at smaller desktop/mobile simulator sizes.
- Avoid hover-only interactions. Every player action must work by touch.
- Keep stable view dimensions and verify text does not overlap, clip, or resize controls when crystal names or page content are long.
- Use the existing Web Audio helpers for feedback; audio must tolerate autoplay restrictions and a suspended audio context.
- Escape user/config content before assigning it to `innerHTML`. Follow the GM console's `esc`/`escAttr` pattern and the player's Markdown renderer.
- Do not add generated SVG replacements for the existing PNG school assets.

## Server And Data Conventions

- This is CommonJS JavaScript: use `require`, semicolons, two-space indentation, and the surrounding naming style.
- Validate and normalize data at API boundaries. Retain existing length caps and school/location allowlists.
- Use `path.join` plus allowlisted identifiers for file access. Never accept arbitrary paths from requests.
- Keep WebSocket broadcasts JSON serializable and backward compatible.
- Config files are rewritten synchronously by GM actions. Avoid unrelated formatting churn in `config/config.yaml`, `sites.json`, or `pins.json`.
- There is no authentication. Treat port 3001 as a trusted local-network control surface and do not expose it publicly. New destructive/system controls require explicit confirmation in the GM UI.
- Preserve cleanup on `SIGINT` and `SIGTERM` so LEDs are blanked when the process exits.

## Development Workflow

Install dependencies with:

```bash
npm install
```

Run safely without Pi hardware from the repository root:

```bash
SIM_MODE=true node src/server.js
```

Then open:

- Player: `http://localhost:3000`
- GM console: `http://localhost:3001`
- Hardware simulator: `http://localhost:3001/sim/`

`dev/start-dev.sh` currently changes into `dev/` and then invokes `src/server.js`, so do not cite it as the reliable launcher until that path bug is fixed.

Do not use `npm start` for development: it invokes `sudo` and production hardware mode. `start.sh`, `stop.sh`, `install-service.sh`, and GM host-control endpoints are production operations and may prompt for elevation or disrupt the kiosk.

## Validation

There is currently no automated test suite. Use the narrowest applicable checks.

Server syntax:

```bash
node --check src/server.js
```

Inline browser script syntax:

```bash
node -e 'const fs=require("fs"),vm=require("vm"); for (const file of ["src/public/index.html","src/public-gm/index.html","dev/index.html"]) { const html=fs.readFileSync(file,"utf8"); for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1],{filename:file}); } console.log("Inline scripts parse");'
```

For runtime/API changes, start in simulation mode and exercise only the touched path. A typical state sequence is insert known crystal, fetch its page, remove crystal, and confirm status:

```bash
curl -s http://localhost:3001/api/sim/status
curl -s -H 'Content-Type: application/json' -d '{"hex":"00000C0E"}' http://localhost:3001/api/sim/crystal
curl -s http://localhost:3000/api/page/conjuration/top
curl -s -X POST http://localhost:3001/api/sim/crystal-remove
```

For UI changes, use the simulator and verify the landing, cross, page, return, removal, and reconnect states at both 1920x1080 and a narrow viewport. Check browser console errors and inspect screenshots. Do not claim physical hardware validation unless it was actually performed on the Pi.

## Deployment Notes

- `netheril.service` runs the server as root because serial/GPIO access currently depends on it.
- `netheril-kiosk.service` runs Firefox as user `benthebuilder` on `DISPLAY=:0` and waits for port 3000.
- The committed `netheril.service` currently hardcodes `/home/benthebuilder/knoxrpg-netheril-prop`, while this checkout is `/home/benthebuilder/knoxrpg-netheril-dungeon-runner`. Confirm the intended install path before changing or installing services.
- `install-service.sh` copies units into `/etc/systemd/system`, reloads systemd, and enables both units. It does not rewrite paths.
- The GM update stream runs `git pull` followed by `npm install --production`; successful updates require a service restart.
- Live logs use `journalctl -u netheril`.

## Screen Aperture (Foam Border)

The physical 1920x1080 panel sits behind a hand-carved foam border with an irregular, torn cutout. The player UI keeps every element inside that aperture.

- **Mechanism:** `fitAppToViewport()` uniformly scales and offsets the whole `#app` box (via `--app-scale`, `--app-dx`, `--app-dy`) into a safe rectangle. Because the scale is uniform, the school-web geometry never drifts; all views inherit the inset for free. Do not add a second per-view padding layer.
- **Single authority:** `config/screen-aperture.json`, read and written through `GET`/`POST /api/aperture`. This is the source of truth for the aperture polygon and the derived safe insets. Do not hardcode insets anywhere else; the server-locked value survives power cycles and applies to every display.
- **Measured (2026-09-20, first pass from an overhead grid photo):** safe insets top 150, right 195, bottom 165, left 165 (screen px); full aperture polygon stored in the JSON. Recalibrate whenever the foam is reseated; hand-carved foam is not repeatable.
- **Calibration tools (on the native panel, foam on, in room light):**
  - `/grid.html` renders a fullscreen labeled coordinate grid (1920x1080, 100px majors, center bullseye) for an overhead photo.
  - In the player UI, `Alt+G` opens the grid overlay; tap the inner foam edge to record the aperture polygon, then `S` saves and locks it to `/api/aperture`.
  - `Alt+C` opens a per-edge nudge overlay (GM-only debug frame).
  - `?safeTop=..&safeRight=..&safeBottom=..&safeLeft=..` query params and `localStorage` provide per-display overrides; the server aperture is the default when neither is set.

## Change Discipline

- Make focused edits and preserve live-prop behavior outside the requested feature.
- Never edit backup files to implement a live change.
- Do not silently change RFID timeouts, sensor thresholds, GPIO assignments, service users, ports, or color/school mappings.
- When changing a contract, update all producers and consumers and document the migration.
- Call out whether validation covered syntax, simulation, browser behavior, or physical hardware; these are different confidence levels.

## Specialized Workspace Resources

- Use the `Netheril Runtime Engineer` agent for server, WebSocket, serial, GPIO, config, and API changes.
- Use the `Netheril Kiosk UI Engineer` agent for player/GM interface and browser state-machine work.
- Use the `netheril-simulation-validation` skill to run the safe no-hardware validation workflow.
- Use the `netheril-school-content` skill for school clue Markdown and renderer-compatible content.
- Use the `netheril-pi-deployment` skill for systemd, kiosk, install, update, and on-device troubleshooting.u