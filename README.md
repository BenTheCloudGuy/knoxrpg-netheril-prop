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
│   ├── config.yaml       # Crystal definitions (RFID hex, color, glyphs)
│   ├── sites.json        # Thul site data (GM-managed)
│   ├── pins.json         # Map pin data (GM-managed)
│   ├── blue.md           # Story content per crystal color
│   ├── green.md
│   ├── purple.md
│   ├── red.md
│   └── translation.md    # Cuneiform translation reference
├── src/
│   ├── server.js         # Express + WebSocket server
│   ├── public/           # Player interface (port 3000)
│   │   ├── index.html    # Main player UI
│   │   ├── map.html      # World map view
│   │   └── fonts/        # NotoSansCuneiform font
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
- **Player map:** `http://localhost:3000/map.html`
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

1. **Crystal placed on reader** — Screen transitions from black, shows a handprint prompt
2. **Hand held over motion sensor** — Scrying menu appears (4 orbital orbs: Sites, Map, Research, Personnel)
3. **Hand removed** — Returns to handprint prompt
4. **Crystal removed** — Screen fades to black

The GM console (port 3001) provides live management of:
- **Crystals** — Add/edit RFID codes, colors, glyph ranges
- **Sites** — Thul network locations with pages, research, personnel
- **Map Pins** — Interactive map markers with descriptions

## LED Colors

| Crystal | LED Hex | Color |
|---------|---------|-------|
| Blue | `0x0000FF` | Blue |
| Purple | `0x8000FF` | Purple |
| Green | `0x00FF00` | Green |
| Red | `0xFF0000` | Red |
| Yellow | `0xFFFF00` | Yellow |
| White | `0xFFFFFF` | White |
| Orange | `0xFF8000` | Orange |
| Pink | `0xFF0080` | Pink |
| Cyan | `0x00FFFF` | Cyan |
