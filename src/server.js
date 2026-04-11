const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const yaml = require('js-yaml');
const fs = require('fs');

const SIM_MODE = process.env.SIM_MODE === 'true';

// --- Conditional hardware imports ---
let SerialPort, ReadlineParser, ws281x;
if (!SIM_MODE) {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
  ws281x = require('rpi-ws281x');
}

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');

const PORT = 3000;
const GM_PORT = 3001;
const SERIAL_PATH = '/dev/serial0';
const SERIAL_BAUD = 9600;
const MOTION_SERIAL_PATH = process.env.MOTION_PORT || '/dev/ttyACM0';
const MOTION_BAUD = 115200;
const HAND_THRESHOLD = 20;    // proximity value below which hand is "on" (covering sensor)
const HAND_TIMEOUT = 600;     // ms of high readings before hand-off

// --- RGB LED Ring ---
const NUM_LEDS = 6;
const LED_GPIO = 18;       // Pin 12 (PWM0)

if (!SIM_MODE) {
  ws281x.configure({
    leds: NUM_LEDS,
    dma: 10,
    brightness: 255,
    gpio: LED_GPIO,
    stripType: 'grb'
  });
  ws281x.render(new Uint32Array(NUM_LEDS)); // blank on start
} else {
  console.log('[SIM] Hardware simulation mode — no LEDs, serial, or GPIO');
}

const LED_COLORS = {
  blue:    0x0000FF,
  purple:  0x8000FF,
  green:   0x00FF00,
  red:     0xFF0000,
  yellow:  0xFFFF00,
  white:   0xFFFFFF,
  orange:  0xFF8000,
  pink:    0xFF0080,
  cyan:    0x00FFFF,
  unknown: 0x333333,
};

function ledFill(color) {
  if (SIM_MODE) { console.log(`[SIM] LED fill: 0x${color.toString(16).padStart(6,'0')}`); return; }
  const pixels = new Uint32Array(NUM_LEDS).fill(color);
  ws281x.render(pixels);
}

function ledOff() {
  if (SIM_MODE) { console.log('[SIM] LED off'); return; }
  ledFill(0x000000);
}

// --- Express + HTTP ---
const app = express();
const server = http.createServer(app);

// Disable caching so Firefox always gets the latest files
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Exit endpoint ---
app.post('/exit', (_req, res) => {
  res.sendStatus(200);
  console.log('Exit requested, shutting down...');
  setTimeout(() => process.exit(0), 500);
});

// --- Story endpoint ---
const VALID_COLORS = ['blue', 'purple', 'green', 'red'];
app.get('/story/:color', (req, res) => {
  const color = req.params.color;
  if (!VALID_COLORS.includes(color)) return res.status(404).send('Not found');
  const filePath = path.join(CONFIG_DIR, `${color}.md`);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).send('Not found');
    res.type('text/plain').send(data);
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// --- Kyber Crystal Color Map ---
// Each crystal gets a unique block of 25 cuneiform characters for the 5x5 grid.
// Plus an answer sequence (indices into that 25-glyph grid) the player must tap in order.
// Returns an array of 25 consecutive Unicode cuneiform characters starting from `start`.
function glyphBlock(start) {
  const glyphs = [];
  for (let i = 0; i < 25; i++) glyphs.push(String.fromCodePoint(start + i));
  return glyphs;
}

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  return yaml.load(raw);
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: -1 }), 'utf8');
}

let config = loadConfig();

const CRYSTAL_MAP = {};

function rebuildCrystalMap() {
  Object.keys(CRYSTAL_MAP).forEach(k => delete CRYSTAL_MAP[k]);
  for (const [hex, c] of Object.entries(config.crystals || {})) {
    CRYSTAL_MAP[hex.toUpperCase()] = {
      color: c.color,
      name: c.name,
      glyphs: glyphBlock(c.glyphStart),
      answer: c.answer,
    };
  }
}
rebuildCrystalMap();

const UNKNOWN_GLYPHS = glyphBlock(0x12200);

function lookupCrystal(tagHex) {
  const key = tagHex.toUpperCase();
  return CRYSTAL_MAP[key] || { color: 'unknown', name: '\u{12263}\u{12263}\u{12263}', glyphs: UNKNOWN_GLYPHS, answer: [0,1,2,3,4,5,6,7] };
}

// Fisher-Yates shuffle: returns shuffled glyphs + remapped answer indices
function shuffleForCrystal(info) {
  const indices = info.glyphs.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const shuffledGlyphs = indices.map(i => info.glyphs[i]);
  // reverseMap: originalPos -> newPos
  const reverseMap = new Array(info.glyphs.length);
  for (let n = 0; n < indices.length; n++) {
    reverseMap[indices[n]] = n;
  }
  const shuffledAnswer = info.answer.map(i => reverseMap[i]);
  return { glyphs: shuffledGlyphs, answer: shuffledAnswer };
}

// --- RDM6300 RFID Reader ---
let serialBuffer = '';
let currentCrystal = null;
let currentShuffled = null;
let lastSeenTime = 0;
const CRYSTAL_TIMEOUT = 500; // ms before considering crystal removed

function simulateCrystalInsert(tagHex) {
  const tagId = parseInt(tagHex, 16);
  currentCrystal = tagId;
  lastSeenTime = Date.now();
  const info = lookupCrystal(tagHex);
  const shuffled = shuffleForCrystal(info);
  currentShuffled = shuffled;
  console.log(`Crystal: ${info.color} (0x${tagHex})`);
  ledFill(LED_COLORS[info.color] || LED_COLORS.unknown);
  broadcast({ type: 'crystal', tagId, tagHex, color: info.color, name: info.name, glyphs: shuffled.glyphs, answer: shuffled.answer });
}

function simulateCrystalRemove() {
  console.log('Crystal removed');
  currentCrystal = null;
  currentShuffled = null;
  ledOff();
  broadcast({ type: 'removed' });
}

function parseRDM6300(data) {
  const version = data.substring(1, 3);
  const tagHex = data.substring(3, 11);
  const checksum = data.substring(11, 13);

  const fullHex = version + tagHex;
  let xor = 0;
  for (let i = 0; i < fullHex.length; i += 2) {
    xor ^= parseInt(fullHex.substring(i, i + 2), 16);
  }

  return {
    valid: xor === parseInt(checksum, 16),
    tagId: parseInt(tagHex, 16),
    tagHex
  };
}

if (!SIM_MODE) {
  const serial = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD });

  serial.on('open', () => {
    console.log(`Serial open: ${SERIAL_PATH} @ ${SERIAL_BAUD}`);
  });

  serial.on('error', (err) => {
    console.error('Serial error:', err.message);
  });

  serial.on('data', (chunk) => {
    serialBuffer += chunk.toString('ascii');

    while (true) {
      const start = serialBuffer.indexOf('\x02');
      const end = serialBuffer.indexOf('\x03');
      if (start === -1 || end === -1 || end < start) {
        if (start > 0) serialBuffer = serialBuffer.substring(start);
        break;
      }

      const message = serialBuffer.substring(start, end + 1);
      serialBuffer = serialBuffer.substring(end + 1);

      if (message.length === 14) {
        const tag = parseRDM6300(message);
        if (tag.valid) {
          lastSeenTime = Date.now();
          if (currentCrystal !== tag.tagId) {
            simulateCrystalInsert(tag.tagHex);
          }
        }
      }
    }
  });

  // Check for crystal removal
  setInterval(() => {
    if (currentCrystal !== null && Date.now() - lastSeenTime > CRYSTAL_TIMEOUT) {
      simulateCrystalRemove();
    }
  }, 50);
} // end !SIM_MODE RFID

// --- Kano Motion Sensor (USB CDC ACM) ---
let handOn = false;
let lastHighTime = 0;

function simulateHandOn() {
  if (!handOn) {
    handOn = true;
    console.log('Hand ON');
    broadcast({ type: 'hand-on' });
  }
}

function simulateHandOff() {
  if (handOn) {
    handOn = false;
    console.log('Hand OFF');
    broadcast({ type: 'hand-off' });
  }
}

if (!SIM_MODE) {
  try {
    const motionSerial = new SerialPort({ path: MOTION_SERIAL_PATH, baudRate: MOTION_BAUD });
    const motionParser = motionSerial.pipe(new ReadlineParser({ delimiter: '\n' }));

    motionSerial.on('open', () => {
      console.log(`Motion sensor open: ${MOTION_SERIAL_PATH} @ ${MOTION_BAUD}`);
    });

    motionSerial.on('error', (err) => {
      console.error('Motion sensor error:', err.message);
    });

    motionParser.on('data', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.name === 'proximity-data' && obj.detail) {
          const prox = obj.detail.proximity || 0;
          if (prox <= HAND_THRESHOLD) {
            lastHighTime = Date.now();
            simulateHandOn();
          }
        }
      } catch (_e) { /* ignore parse errors */ }
    });

    // Check for hand removal
    setInterval(() => {
      if (handOn && Date.now() - lastHighTime > HAND_TIMEOUT) {
        simulateHandOff();
      }
    }, 100);
  } catch (err) {
    console.warn('Motion sensor not available:', err.message);
  }
} // end !SIM_MODE motion

// Send current state to newly connected clients
wss.on('connection', (ws) => {
  // Send hand state
  ws.send(JSON.stringify({ type: handOn ? 'hand-on' : 'hand-off' }));

  if (currentCrystal !== null && currentShuffled) {
    const hex = currentCrystal.toString(16).padStart(8, '0').toUpperCase();
    const info = lookupCrystal(hex);
    ws.send(JSON.stringify({ type: 'crystal', tagId: currentCrystal, tagHex: hex, color: info.color, name: info.name, glyphs: currentShuffled.glyphs, answer: currentShuffled.answer }));
  } else {
    ws.send(JSON.stringify({ type: 'removed' }));
  }
});

// ============================================================
// --- Sites Data (Thul network, shared between player + GM) ---
// ============================================================
const SITES_FILE = path.join(CONFIG_DIR, 'sites.json');

function loadSites() {
  try {
    return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  } catch {
    return { thuls: [] };
  }
}

function saveSites(data) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// --- Player sites API (read-only, on main port 3000) ---
app.get('/api/sites', (_req, res) => {
  res.json(loadSites());
});

app.get('/api/sites/:id', (req, res) => {
  const data = loadSites();
  const site = data.thuls.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  res.json(site);
});

// ============================================================
// --- Map Pins Data (shared between player + GM) ---
// ============================================================
const PINS_FILE = path.join(CONFIG_DIR, 'pins.json');

function loadPins() {
  try {
    return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function savePins(pins) {
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2), 'utf8');
}

// Ensure file exists
if (!fs.existsSync(PINS_FILE)) savePins([]);

// --- Player pin API (read-only, on main port 3000) ---
app.get('/api/pins', (_req, res) => {
  res.json(loadPins());
});

app.get('/api/pins/:id', (req, res) => {
  const pins = loadPins();
  const pin = pins.find(p => p.id === req.params.id);
  if (!pin) return res.status(404).json({ error: 'Pin not found' });
  res.json(pin);
});

// ============================================================
// --- GM Server (port 3001) ---
// ============================================================
const gmApp = express();
const gmServer = http.createServer(gmApp);

gmApp.use(express.json());
gmApp.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
gmApp.use(express.static(path.join(__dirname, 'public-gm')));

// --- GM Pin CRUD API ---
gmApp.get('/api/pins', (_req, res) => {
  res.json(loadPins());
});

// --- GM Crystal CRUD API ---
function findCrystalKey(hexParam) {
  const normalized = hexParam.toUpperCase().replace(/^0X/, '');
  for (const key of Object.keys(config.crystals || {})) {
    if (key.toUpperCase().replace(/^0X/, '') === normalized) return key;
  }
  return null;
}

gmApp.get('/api/crystals', (_req, res) => {
  const crystals = config.crystals || {};
  const list = Object.entries(crystals).map(([hex, c]) => ({
    hex, color: c.color, name: c.name, glyphStart: c.glyphStart, answer: c.answer,
  }));
  res.json(list);
});

gmApp.post('/api/crystals', (req, res) => {
  const { hex, color, name, glyphStart, answer } = req.body;
  if (!hex || !color) return res.status(400).json({ error: 'hex and color are required' });
  const key = String(hex).toUpperCase().replace(/^0X/, '');
  if (!config.crystals) config.crystals = {};
  config.crystals[key] = {
    color: String(color).slice(0, 50),
    name: String(name || '').slice(0, 50),
    glyphStart: typeof glyphStart === 'number' ? glyphStart : 0x12000,
    answer: Array.isArray(answer) ? answer : [0,1,2,3,4,5,6,7],
  };
  saveConfig(config);
  rebuildCrystalMap();
  res.status(201).json({ hex: key, ...config.crystals[key] });
});

gmApp.put('/api/crystals/:hex', (req, res) => {
  const key = findCrystalKey(req.params.hex);
  if (!key) return res.status(404).json({ error: 'Crystal not found' });
  const { color, name, glyphStart, answer } = req.body;
  if (color !== undefined) config.crystals[key].color = String(color).slice(0, 50);
  if (name !== undefined) config.crystals[key].name = String(name).slice(0, 50);
  if (typeof glyphStart === 'number') config.crystals[key].glyphStart = glyphStart;
  if (Array.isArray(answer)) config.crystals[key].answer = answer;
  saveConfig(config);
  rebuildCrystalMap();
  res.json({ hex: key, ...config.crystals[key] });
});

gmApp.delete('/api/crystals/:hex', (req, res) => {
  const key = findCrystalKey(req.params.hex);
  if (!key) return res.status(404).json({ error: 'Crystal not found' });
  delete config.crystals[key];
  saveConfig(config);
  rebuildCrystalMap();
  res.json({ ok: true });
});

// --- GM Sites CRUD API ---
gmApp.get('/api/sites', (_req, res) => {
  res.json(loadSites());
});

gmApp.put('/api/sites', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.thuls)) return res.status(400).json({ error: 'Invalid sites data' });
  saveSites(data);
  res.json({ ok: true });
});

gmApp.put('/api/sites/:siteId', (req, res) => {
  const data = loadSites();
  const idx = data.thuls.findIndex(s => s.id === req.params.siteId);
  if (idx === -1) return res.status(404).json({ error: 'Site not found' });
  const updates = req.body;
  if (updates.name !== undefined) data.thuls[idx].name = String(updates.name).slice(0, 200);
  if (updates.glyph !== undefined) data.thuls[idx].glyph = String(updates.glyph).slice(0, 10);
  if (updates.description !== undefined) data.thuls[idx].description = String(updates.description).slice(0, 5000);
  if (typeof updates.x === 'number') data.thuls[idx].x = updates.x;
  if (typeof updates.y === 'number') data.thuls[idx].y = updates.y;
  if (updates.crystal !== undefined) data.thuls[idx].crystal = updates.crystal;
  if (Array.isArray(updates.pages)) data.thuls[idx].pages = updates.pages;
  if (Array.isArray(updates.research)) data.thuls[idx].research = updates.research;
  if (Array.isArray(updates.personnel)) data.thuls[idx].personnel = updates.personnel;
  saveSites(data);
  res.json(data.thuls[idx]);
});

gmApp.post('/api/sites', (req, res) => {
  const data = loadSites();
  const { name, glyph, description, x, y } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const site = {
    id: 'thul-' + Date.now().toString(36),
    name: String(name).slice(0, 200),
    glyph: String(glyph || '𒀭').slice(0, 10),
    description: String(description || '').slice(0, 5000),
    x: typeof x === 'number' ? x : 50,
    y: typeof y === 'number' ? y : 50,
    pages: [],
    research: [],
    personnel: [],
  };
  data.thuls.push(site);
  saveSites(data);
  res.status(201).json(site);
});

gmApp.delete('/api/sites/:siteId', (req, res) => {
  const data = loadSites();
  const len = data.thuls.length;
  data.thuls = data.thuls.filter(s => s.id !== req.params.siteId);
  if (data.thuls.length === len) return res.status(404).json({ error: 'Site not found' });
  saveSites(data);
  res.json({ ok: true });
});

gmApp.post('/api/pins', (req, res) => {
  const pins = loadPins();
  const { title, description, x, y, icon } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number' || !title) {
    return res.status(400).json({ error: 'title, x, y are required' });
  }
  const pin = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: String(title).slice(0, 200),
    description: String(description || '').slice(0, 5000),
    x, y,
    icon: String(icon || '📍').slice(0, 10),
    created: new Date().toISOString(),
  };
  pins.push(pin);
  savePins(pins);
  res.status(201).json(pin);
});

gmApp.put('/api/pins/:id', (req, res) => {
  const pins = loadPins();
  const idx = pins.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Pin not found' });
  const { title, description, x, y, icon } = req.body;
  if (title !== undefined) pins[idx].title = String(title).slice(0, 200);
  if (description !== undefined) pins[idx].description = String(description || '').slice(0, 5000);
  if (typeof x === 'number') pins[idx].x = x;
  if (typeof y === 'number') pins[idx].y = y;
  if (icon !== undefined) pins[idx].icon = String(icon).slice(0, 10);
  savePins(pins);
  res.json(pins[idx]);
});

gmApp.delete('/api/pins/:id', (req, res) => {
  let pins = loadPins();
  const len = pins.length;
  pins = pins.filter(p => p.id !== req.params.id);
  if (pins.length === len) return res.status(404).json({ error: 'Pin not found' });
  savePins(pins);
  res.json({ ok: true });
});

// --- GM map image upload ---
const MAP_FILE = 'faerunu_blank.jpg';
const MAP_IMG_PATH = path.join(__dirname, 'public', MAP_FILE);
const GM_MAP_IMG_PATH = path.join(__dirname, 'public-gm', MAP_FILE);

gmApp.post('/api/map-upload', (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'Max 20MB' });
    fs.writeFileSync(MAP_IMG_PATH, buf);
    fs.writeFileSync(GM_MAP_IMG_PATH, buf);
    res.json({ ok: true });
  });
});

// ============================================================
// --- Simulation API (only available in SIM_MODE) ---
// ============================================================
if (SIM_MODE) {
  gmApp.get('/api/sim/status', (_req, res) => {
    res.json({
      simMode: true,
      crystalActive: currentCrystal !== null,
      currentCrystal: currentCrystal ? currentCrystal.toString(16).padStart(8, '0').toUpperCase() : null,
      handOn,
      crystals: Object.entries(config.crystals || {}).map(([hex, c]) => ({ hex, color: c.color })),
    });
  });

  gmApp.post('/api/sim/crystal', express.json(), (req, res) => {
    const { hex } = req.body;
    if (!hex) return res.status(400).json({ error: 'hex required' });
    const cleanHex = String(hex).toUpperCase().replace(/^0X/, '');
    simulateCrystalInsert(cleanHex);
    res.json({ ok: true, hex: cleanHex });
  });

  gmApp.post('/api/sim/crystal-remove', (_req, res) => {
    simulateCrystalRemove();
    res.json({ ok: true });
  });

  gmApp.post('/api/sim/hand-on', (_req, res) => {
    simulateHandOn();
    res.json({ ok: true });
  });

  gmApp.post('/api/sim/hand-off', (_req, res) => {
    simulateHandOff();
    res.json({ ok: true });
  });

  // Serve simulator page
  gmApp.use('/sim', express.static(path.join(ROOT_DIR, 'dev')));
}

// --- Start both servers ---
server.listen(PORT, () => {
  console.log(`Netheril Player running at http://localhost:${PORT}`);
  if (!SIM_MODE) {
    console.log(`RGB LED Ring: ${NUM_LEDS} LEDs on GPIO ${LED_GPIO} (Pin 12)`);
  }
  console.log('');
  console.log('=== Answer Sequences ===');
  for (const [hex, crystal] of Object.entries(CRYSTAL_MAP)) {
    const glyphs = crystal.glyphs;
    const seq = crystal.answer.map((idx, step) => `  ${step + 1}. [${String(idx + 1).padStart(2, '0')}] ${glyphs[idx]}`).join('\n');
    console.log(`\n${crystal.color.toUpperCase()} (0x${hex}):`);
    console.log(seq);
  }
  console.log('');
});

gmServer.listen(GM_PORT, () => {
  console.log(`Netheril GM running at http://localhost:${GM_PORT}`);
  if (SIM_MODE) {
    console.log(`Hardware Simulator: http://localhost:${GM_PORT}/sim/`);
  }
});

// --- Cleanup on exit ---
function cleanup() {
  ledOff();
  if (!SIM_MODE) ws281x.reset();
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
