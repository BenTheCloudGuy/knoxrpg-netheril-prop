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
const HAND_ON_THRESHOLD = 230;   // proximity >= this = hand on
const HAND_OFF_THRESHOLD = 200;  // proximity drops below this = hand off
const HAND_TIMEOUT = 1000;       // ms below off-threshold before hand-off

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
  green:   0x00FF00,
  red:     0xFF0000,
  yellow:  0xFFFF00,
  white:   0xFFFFFF,
  orange:  0xFF8000,
  pink:    0xFF0080,
  black:   0x000000,
  unknown: 0x333333,
};

// Each crystal colour maps 1:1 to a D&D school of magic.
const COLOR_TO_SCHOOL = {
  white:  'abjuration',
  blue:   'conjuration',
  yellow: 'divination',
  pink:   'enchantment',
  red:    'evocation',
  orange: 'illusion',
  black:  'necromancy',
  green:  'transmutation',
};
const VALID_SCHOOLS = new Set(Object.values(COLOR_TO_SCHOOL));
const VALID_LOCATIONS = new Set(['top', 'bottom', 'left', 'right']);

function ledFill(color) {
  if (SIM_MODE) { console.log(`[SIM] LED fill: 0x${color.toString(16).padStart(6,'0')}`); return; }
  const pixels = new Uint32Array(NUM_LEDS).fill(color);
  ws281x.render(pixels);
}

function ledOff() {
  if (SIM_MODE) { console.log('[SIM] LED off'); return; }
  ledFill(0x000000);
}

// --- Font discovery (scans src/public/fonts/) ---
const FONTS_DIR = path.join(__dirname, 'public', 'fonts');
const FONT_EXT_FORMAT = {
  '.woff2': 'woff2',
  '.woff':  'woff',
  '.otf':   'opentype',
  '.ttf':   'truetype',
};
function listFonts() {
  let entries = [];
  try { entries = fs.readdirSync(FONTS_DIR); } catch { return []; }
  const out = [];
  for (const file of entries) {
    const ext = path.extname(file).toLowerCase();
    if (!(ext in FONT_EXT_FORMAT)) continue;
    const name = path.basename(file, ext);
    out.push({ name, file: '/fonts/' + file, format: FONT_EXT_FORMAT[ext] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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

// --- School-of-magic page endpoint ---
// Serves /src/public/pages/<school>_<location>.md as plain markdown text.
app.get('/api/page/:school/:location', (req, res) => {
  const school = String(req.params.school || '').toLowerCase();
  const location = String(req.params.location || '').toLowerCase();
  if (!VALID_SCHOOLS.has(school) || !VALID_LOCATIONS.has(location)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const filePath = path.join(__dirname, 'public', 'pages', `${school}_${location}.md`);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).type('text/plain').send('Not found');
    res.type('text/plain').send(data);
  });
});

// --- Font listing endpoint (shared between player + GM) ---
app.get('/api/fonts', (_req, res) => res.json(listFonts()));

// --- WebSocket ---
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// --- Kyber Crystal Map ---
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
    const color = String(c.color || 'unknown').toLowerCase();
    const school = c.school || COLOR_TO_SCHOOL[color] || null;
    CRYSTAL_MAP[hex.toUpperCase()] = {
      color,
      school,
      name: c.name || '',
    };
  }
}
rebuildCrystalMap();

function lookupCrystal(tagHex) {
  const key = tagHex.toUpperCase();
  return CRYSTAL_MAP[key] || { color: 'unknown', school: null, name: '' };
}

// --- RDM6300 RFID Reader ---
let serialBuffer = '';
let currentCrystal = null;
let currentCrystalInfo = null;
let lastSeenTime = 0;
const CRYSTAL_TIMEOUT = 500; // ms before considering crystal removed

function simulateCrystalInsert(tagHex) {
  const tagId = parseInt(tagHex, 16);
  currentCrystal = tagId;
  lastSeenTime = Date.now();
  const info = lookupCrystal(tagHex);
  currentCrystalInfo = info;
  console.log(`Crystal: ${info.color}/${info.school || '?'} (0x${tagHex})`);
  const ledColor = (info.color in LED_COLORS) ? LED_COLORS[info.color] : LED_COLORS.unknown;
  try { ledFill(ledColor); } catch (e) { console.error('ledFill failed:', e.message); }
  broadcast({ type: 'crystal', tagId, tagHex, color: info.color, school: info.school, name: info.name });
}

function simulateCrystalRemove() {
  console.log('Crystal removed');
  currentCrystal = null;
  currentCrystalInfo = null;
  serialBuffer = ''; // discard any partial frame left over from the moment of removal
  try { ledOff(); } catch (e) { console.error('ledOff failed:', e.message); }
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
    // Use 'latin1' so all 256 byte values round-trip intact (ascii masks the high bit).
    serialBuffer += chunk.toString('latin1');

    // Cap buffer so noise without an STX can never grow unbounded.
    if (serialBuffer.length > 256) {
      serialBuffer = serialBuffer.substring(serialBuffer.length - 256);
    }

    while (true) {
      const start = serialBuffer.indexOf('\x02');
      if (start === -1) {
        // No frame start at all — drop everything so junk can't accumulate.
        serialBuffer = '';
        break;
      }
      if (start > 0) serialBuffer = serialBuffer.substring(start);

      // A complete frame needs STX + 12 chars + ETX = 14 bytes.
      if (serialBuffer.length < 14) break;

      // If the byte at position 13 isn't ETX, this frame is corrupt — discard
      // just this STX and resync on the next one.
      if (serialBuffer.charCodeAt(13) !== 0x03) {
        serialBuffer = serialBuffer.substring(1);
        continue;
      }

      const message = serialBuffer.substring(0, 14);
      serialBuffer = serialBuffer.substring(14);

      const tag = parseRDM6300(message);
      if (tag.valid) {
        lastSeenTime = Date.now();
        if (currentCrystal !== tag.tagId) {
          simulateCrystalInsert(tag.tagHex);
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
let lastDataTime = Date.now();

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
          lastDataTime = Date.now();
          // High proximity = hand approaching, trigger ON
          if (prox >= HAND_ON_THRESHOLD) {
            simulateHandOn();
          }
        }
      } catch (_e) { /* ignore */ }
    });

    // Hand stays ON while data is silent (sensor blocked by hand).
    // Hand goes OFF when data resumes with low values for 1 second.
    let lowSince = 0;
    setInterval(() => {
      const silence = Date.now() - lastDataTime;
      if (handOn) {
        // If data is silent, hand is still covering — stay ON
        if (silence > 500) return;
        // Data is flowing again — track how long it's been low
        if (!lowSince) lowSince = Date.now();
        if (Date.now() - lowSince > HAND_TIMEOUT) {
          simulateHandOff();
          lowSince = 0;
        }
      } else {
        lowSince = 0;
      }
    }, 100);
  } catch (err) {
    console.warn('Motion sensor not available:', err.message);
  }
} // end !SIM_MODE motion

// Send current state to newly connected clients
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: handOn ? 'hand-on' : 'hand-off' }));

  if (currentCrystal !== null && currentCrystalInfo) {
    const hex = currentCrystal.toString(16).padStart(8, '0').toUpperCase();
    const info = currentCrystalInfo;
    ws.send(JSON.stringify({ type: 'crystal', tagId: currentCrystal, tagHex: hex, color: info.color, school: info.school, name: info.name }));
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
// Make font assets available to the GM editor for previewing.
gmApp.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts')));

// --- Font listing for GM editor ---
gmApp.get('/api/fonts', (_req, res) => res.json(listFonts()));

// --- Push a hard reload to every connected player display ---
gmApp.post('/api/reload-player', (_req, res) => {
  broadcast({ type: 'reload' });
  res.json({ ok: true });
});

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
    hex, color: c.color, school: c.school || COLOR_TO_SCHOOL[c.color] || null, name: c.name,
  }));
  res.json(list);
});

gmApp.post('/api/crystals', (req, res) => {
  const { hex, color, name } = req.body;
  if (!hex || !color) return res.status(400).json({ error: 'hex and color are required' });
  const key = String(hex).toUpperCase().replace(/^0X/, '');
  const colorLc = String(color).slice(0, 50).toLowerCase();
  if (!config.crystals) config.crystals = {};
  config.crystals[key] = {
    color: colorLc,
    school: COLOR_TO_SCHOOL[colorLc] || null,
    name: String(name || '').slice(0, 100),
  };
  saveConfig(config);
  rebuildCrystalMap();
  res.status(201).json({ hex: key, ...config.crystals[key] });
});

gmApp.put('/api/crystals/:hex', (req, res) => {
  const key = findCrystalKey(req.params.hex);
  if (!key) return res.status(404).json({ error: 'Crystal not found' });
  const { color, name } = req.body;
  if (color !== undefined) {
    const colorLc = String(color).slice(0, 50).toLowerCase();
    config.crystals[key].color = colorLc;
    config.crystals[key].school = COLOR_TO_SCHOOL[colorLc] || null;
  }
  if (name !== undefined) config.crystals[key].name = String(name).slice(0, 100);
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

// --- GM School Pages CRUD (markdown files under public/pages/) ---
const SCHOOL_PAGES_DIR = path.join(__dirname, 'public', 'pages');

gmApp.get('/api/school-pages', (_req, res) => {
  const list = [];
  for (const school of VALID_SCHOOLS) {
    for (const location of VALID_LOCATIONS) {
      const fp = path.join(SCHOOL_PAGES_DIR, `${school}_${location}.md`);
      let exists = false, size = 0, title = '';
      try {
        const st = fs.statSync(fp);
        exists = true; size = st.size;
        const data = fs.readFileSync(fp, 'utf8');
        const m = data.match(/^#\s+(.+)$/m);
        if (m) title = m[1].trim();
      } catch { /* missing */ }
      list.push({ school, location, exists, size, title });
    }
  }
  res.json(list);
});

gmApp.get('/api/school-pages/:school/:location', (req, res) => {
  const school = String(req.params.school || '').toLowerCase();
  const location = String(req.params.location || '').toLowerCase();
  if (!VALID_SCHOOLS.has(school) || !VALID_LOCATIONS.has(location)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const fp = path.join(SCHOOL_PAGES_DIR, `${school}_${location}.md`);
  fs.readFile(fp, 'utf8', (err, data) => {
    res.json({ school, location, content: err ? '' : data });
  });
});

gmApp.put('/api/school-pages/:school/:location', (req, res) => {
  const school = String(req.params.school || '').toLowerCase();
  const location = String(req.params.location || '').toLowerCase();
  if (!VALID_SCHOOLS.has(school) || !VALID_LOCATIONS.has(location)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const content = String((req.body && req.body.content) || '').slice(0, 50000);
  const fp = path.join(SCHOOL_PAGES_DIR, `${school}_${location}.md`);
  try {
    fs.mkdirSync(SCHOOL_PAGES_DIR, { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
    res.json({ ok: true, school, location, size: Buffer.byteLength(content, 'utf8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

const { execSync } = require('child_process');
const { spawn } = require('child_process');

// --- GM Git Update API (SSE stream) ---
gmApp.get('/api/update', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  function send(data) {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  send({ type: 'info', text: '$ git pull' });

  const proc = spawn('git', ['pull'], { cwd: ROOT_DIR });

  proc.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'stdout', text: line }));
  });

  proc.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'stderr', text: line }));
  });

  proc.on('close', (code) => {
    if (code === 0) {
      send({ type: 'info', text: '' });
      send({ type: 'info', text: '$ npm install --production' });

      const npmProc = spawn('npm', ['install', '--production'], { cwd: ROOT_DIR });

      npmProc.stdout.on('data', (chunk) => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'stdout', text: line }));
      });

      npmProc.stderr.on('data', (chunk) => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'stderr', text: line }));
      });

      npmProc.on('close', (npmCode) => {
        send({ type: 'done', code: npmCode, text: npmCode === 0 ? 'Update complete. Restart the service to apply.' : 'npm install failed (exit ' + npmCode + ')' });
        res.end();
      });
    } else {
      send({ type: 'done', code, text: 'git pull failed (exit ' + code + ')' });
      res.end();
    }
  });

  proc.on('error', (err) => {
    send({ type: 'done', code: 1, text: 'Error: ' + err.message });
    res.end();
  });

  req.on('close', () => {
    proc.kill();
  });
});

gmApp.post('/api/restart', (_req, res) => {
  res.json({ ok: true, text: 'Restarting in 2 seconds...' });
  setTimeout(() => {
    try {
      execSync('systemctl restart netheril 2>/dev/null || true');
    } catch (_e) { /* ignore */ }
    process.exit(0);
  }, 2000);
});

gmApp.post('/api/reboot', (_req, res) => {
  res.json({ ok: true, text: 'Rebooting Pi in 3 seconds...' });
  setTimeout(() => {
    try { execSync('reboot'); } catch (_e) { /* ignore */ }
  }, 3000);
});

gmApp.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true, text: 'Shutting down Pi in 3 seconds...' });
  setTimeout(() => {
    try { execSync('shutdown -h now'); } catch (_e) { /* ignore */ }
  }, 3000);
});

// --- GM Live Logs (SSE stream of journalctl) ---
gmApp.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const proc = spawn('journalctl', ['-u', 'netheril', '-f', '-n', '80', '--no-pager', '-o', 'short-iso'], {});

  proc.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      res.write('data: ' + JSON.stringify({ text: line }) + '\n\n');
    });
  });

  proc.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      res.write('data: ' + JSON.stringify({ text: line, err: true }) + '\n\n');
    });
  });

  proc.on('close', () => {
    res.write('data: ' + JSON.stringify({ text: '[journalctl exited]', err: true }) + '\n\n');
    res.end();
  });

  req.on('close', () => {
    proc.kill();
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
  console.log('=== Crystal → School Map ===');
  for (const [hex, crystal] of Object.entries(CRYSTAL_MAP)) {
    console.log(`  0x${hex}  ${crystal.color.padEnd(8)} → ${crystal.school || '(none)'}  ${crystal.name}`);
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
