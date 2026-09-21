'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const PORT = Number(process.env.LAUNCHER_PORT) || 3000;
const ROOT = path.join(__dirname, '..'); // prop repo root
const APPS_DIR = path.join(ROOT, 'apps');
const APERTURE_FILE = path.join(APPS_DIR, 'dungeon-runner', 'config', 'screen-aperture.json');

const app = express();

app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- App manifests ---
function loadApps() {
  const out = [];
  if (!fs.existsSync(APPS_DIR)) return out;
  for (const id of fs.readdirSync(APPS_DIR)) {
    const manifestPath = path.join(APPS_DIR, id, 'app.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    } catch (e) {
      console.error('Bad manifest for', id, e.message);
    }
  }
  return out;
}

// --- Network info (SSID + IP) ---
function getNetworkInfo() {
  let ssid = '';
  try {
    ssid = execSync('iwgetid -r', { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { /* not on wifi or tool missing */ }

  let ip = '';
  try {
    const ifaces = os.networkInterfaces();
    const order = Object.keys(ifaces).sort((a, b) => (b.startsWith('wl') ? 1 : 0) - (a.startsWith('wl') ? 1 : 0));
    for (const name of order) {
      for (const i of ifaces[name] || []) {
        if (i.family === 'IPv4' && !i.internal) { ip = i.address; break; }
      }
      if (ip) break;
    }
  } catch (e) { /* ignore */ }

  return { ssid: ssid || 'not connected', ip: ip || 'unknown', hostname: os.hostname() };
}

// --- Running app child processes ---
const running = {}; // id -> { proc, startedAt }

function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForPort(port, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function stopApp(id) {
  const r = running[id];
  if (!r) return false;
  try { r.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  delete running[id];
  return true;
}

// --- API ---
app.get('/api/status', (_req, res) => {
  const apps = loadApps().map((a) => ({
    id: a.id,
    name: a.name,
    short: a.short || a.name,
    school: a.school || null,
    description: a.description || '',
    playerUrl: a.playerUrl,
    gmUrl: a.gmUrl,
    running: !!running[a.id],
  }));
  res.json({ prop: 'Scrying Stone Prop', network: getNetworkInfo(), apps });
});

// Shared foam aperture (same physical screen as the apps)
app.get('/api/aperture', (_req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(APERTURE_FILE, 'utf8')));
  } catch (e) {
    res.json({ designWidth: 1920, designHeight: 1080, safe: { top: 64, right: 150, bottom: 168, left: 140 }, polygon: [] });
  }
});

app.post('/api/apps/:id/start', async (req, res) => {
  const a = loadApps().find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'unknown app' });

  if (running[a.id]) {
    return res.json({ ok: true, url: a.playerUrl, already: true });
  }

  // Only one app at a time on the kiosk: stop any others first.
  for (const id of Object.keys(running)) stopApp(id);

  const cwd = path.join(ROOT, a.start.cwd);
  const env = { ...process.env, ...(a.start.env || {}) };
  let proc;
  try {
    proc = spawn(a.start.cmd, a.start.args, { cwd, env, stdio: 'inherit' });
  } catch (e) {
    return res.status(500).json({ error: 'failed to spawn: ' + e.message });
  }
  running[a.id] = { proc, startedAt: Date.now() };
  proc.on('exit', (code) => {
    console.log(`App ${a.id} exited with code ${code}`);
    delete running[a.id];
  });

  const ready = await waitForPort(a.readyPort || a.playerPort, 25000);
  if (!ready) {
    return res.status(504).json({ error: 'app did not become ready', url: a.playerUrl });
  }
  console.log(`App ${a.id} ready on ${a.playerUrl}`);
  res.json({ ok: true, url: a.playerUrl });
});

app.post('/api/apps/:id/stop', (req, res) => {
  const stopped = stopApp(req.params.id);
  res.json({ ok: true, stopped });
});

app.post('/api/apps/stop-all', (_req, res) => {
  const ids = Object.keys(running);
  ids.forEach(stopApp);
  res.json({ ok: true, stopped: ids });
});

process.on('SIGTERM', () => { Object.keys(running).forEach(stopApp); process.exit(0); });
process.on('SIGINT', () => { Object.keys(running).forEach(stopApp); process.exit(0); });

http.createServer(app).listen(PORT, () => {
  console.log(`Scrying Stone Prop launcher listening on ${PORT}`);
});
