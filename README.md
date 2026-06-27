# Netheril Prop

An interactive D&D tabletop prop for the Netheril campaign. Players place RFID-tagged "Kyber Crystals" on a reader and hold their hand over a motion sensor to access an ancient Netherese scrying interface — complete with cuneiform glyphs, color-coded crystal themes, and a GM console for live content management.

## Hardware

- Raspberry Pi (arm64, tested on Pi 4/5)
- RDM6300 RFID reader (125kHz, on `/dev/serial0` @ 9600 baud)
- Kano Motion Sensor (USB CDC ACM, on `/dev/ttyACM0` @ 115200 baud)
- WS281x RGB LED ring (6 LEDs, GPIO 18 / Pin 12)
- RFID tags (125kHz) embedded in prop crystals
- Touchscreen display (1920x1080, runs Firefox kiosk)

## Project Structure

```
knoxrpg-netheril-prop/
├── start.sh              # Launch server + Firefox kiosk
├── stop.sh               # Stop server + Firefox
├── package.json
├── config/
│   ├── config.yaml       # Crystal definitions (RFID hex, colour, name)
│   └── sites.json        # Legacy sites data (unused by player)
├── src/
│   ├── server.js         # Express + WebSocket server
│   ├── public/           # Player interface (port 3000)
│   │   ├── index.html    # Main player UI (hand prompt → 4-glyph cross → page view)
│   │   ├── handprint.png
│   │   ├── fonts/        # NotoSansCuneiform font
│   │   ├── img/schools/  # 8 school-of-magic sigils (transparent PNG)
│   │   └── pages/        # 32 markdown pages: <school>_<top|bottom|left|right>.md
│   └── public-gm/        # GM console (port 3001)
│       └── index.html    # GM management UI
├── dev/
│   ├── start-dev.sh      # Dev mode launcher (SIM_MODE)
│   └── index.html        # Simulator control panel
└── .devcontainer/
    └── devcontainer.json  # VS Code devcontainer config
```

## Setup

### Prerequisites

- Node.js 18+
- Hardware connected (see above)

### Install

```bash
cd knoxrpg-netheril-prop
npm install
```

### Environment Variables

Add to `~/.profile` (or equivalent):

```bash
export OPEN_AI_URL="https://api.openai.com/v1/"
export OPENAI_API_KEY="your-key-here"
```

### Run (Production — Raspberry Pi)

```bash
./start.sh    # Starts server + Firefox kiosk
./stop.sh     # Stops everything
```

- **Player interface:** `http://localhost:3000`
- **GM console:** `http://localhost:3001`

### Run (Development — No Hardware)

```bash
SIM_MODE=true node src/server.js
```

Or use the dev launcher:

```bash
./dev/start-dev.sh
```

Opens a simulator control panel at `http://localhost:3001/sim` to trigger crystal insert/remove and hand on/off events without physical hardware.

## How It Works

This prop is used in a massive dungeon-crawl one-shot to help players disable traps, open doors, and solve puzzles. Each crystal is tied to one of the eight D&D schools of magic.

1. **Crystal placed on reader** — Screen reveals; the 8 school sigils on the side columns dim, and the school matching the crystal's colour glows. A handprint prompt appears in the centre.
2. **Hand held over motion sensor** — The hand prompt is replaced by a 4-glyph cross. The centre of the cross shows the school of magic associated with the crystal; the four outer glyphs (top / bottom / left / right) are tappable buttons.
3. **Tap a glyph** — The matching page (`src/public/pages/<school>_<location>.md`) is fetched and rendered. Tap the close glyph in the corner to return.
4. **Hand removed** — Returns to the handprint prompt.
5. **Crystal removed** — Screen fades to black.

The GM console (port 3001) provides live management of:
- **Crystals** — Add/edit RFID codes, colours, names. School is derived automatically from colour.

## Crystal → School → LED Colour

| Crystal Colour | School | LED Hex |
|---|---|---|
| White  | Abjuration    | `0xFFFFFF` |
| Blue   | Conjuration   | `0x0000FF` |
| Yellow | Divination    | `0xFFFF00` |
| Pink   | Enchantment   | `0xFF0080` |
| Red    | Evocation     | `0xFF0000` |
| Orange | Illusion      | `0xFF8000` |
| Black  | Necromancy    | `0x000000` (LED off) |
| Green  | Transmutation | `0x00FF00` |

## Page Content

Each school has four placeholder pages — one per cross direction — in `src/public/pages/`:

```
<school>_top.md      # Origins
<school>_bottom.md   # Foundations
<school>_left.md     # Practices
<school>_right.md    # Risks
```

Edit these markdown files (a subset of Markdown is supported: headings, paragraphs, bold, italic, lists, inline code) and they will be re-fetched on the next tap — no server restart needed.


