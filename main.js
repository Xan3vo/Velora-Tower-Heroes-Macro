const { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync } = require('child_process');

const AHK_DOWNLOAD_URL = 'https://www.autohotkey.com/download/ahk-v1.exe';

// Locate an AutoHotkey **v1.1** interpreter. The "U"/"A" exe variants
// (AutoHotkeyU64/U32/A32) are v1-only — v2 ships AutoHotkey64/32 without the
// letter — so finding one guarantees the correct version. Returns an absolute
// path, or null if no v1 interpreter can be found.
function findAhkV1() {
  const candidateDirs = [];

  // 1. Registry-recorded install dir (covers non-default install locations).
  for (const root of ['HKLM', 'HKCU']) {
    for (const key of ['SOFTWARE\\AutoHotkey', 'SOFTWARE\\WOW6432Node\\AutoHotkey']) {
      try {
        const out = execSync(`reg query "${root}\\${key}" /v InstallDir`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = out.match(/InstallDir\s+REG_SZ\s+(.+)/i);
        if (m) candidateDirs.push(m[1].trim());
      } catch (err) { /* key not present */ }
    }
  }

  // 2. Common default install locations.
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'];
  candidateDirs.push(path.join(pf, 'AutoHotkey'));
  candidateDirs.push(path.join(pfx86, 'AutoHotkey'));
  if (local) candidateDirs.push(path.join(local, 'Programs', 'AutoHotkey'));

  // v1-only interpreter names, checked in both unified-installer (v1\) and
  // classic layouts, most-preferred first (64-bit unicode).
  const v1Exes = [
    'v1\\AutoHotkeyU64.exe', 'v1\\AutoHotkeyU32.exe', 'v1\\AutoHotkeyA32.exe',
    'AutoHotkeyU64.exe', 'AutoHotkeyU32.exe', 'AutoHotkeyA32.exe',
  ];

  const seen = new Set();
  const uniqueDirs = candidateDirs.filter((d) => {
    if (!d) return false;
    const key = d.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const dir of uniqueDirs) {
    for (const exe of v1Exes) {
      const full = path.join(dir, exe);
      if (fs.existsSync(full)) return full;
    }
  }

  // 3. Last resort: a bare AutoHotkey.exe. In a classic v1 install this IS the
  // v1 interpreter; in a unified install it's a launcher that dispatches by the
  // script's `#Requires AutoHotkey v1.1.37` directive to v1 (if v1 is present).
  for (const dir of uniqueDirs) {
    const full = path.join(dir, 'AutoHotkey.exe');
    if (fs.existsSync(full)) return full;
  }

  return null;
}

let statusWindow = null;
let runningProcess = null;
let currentStatusFile = null;
let currentStopFile = null;
let currentMacroRunningFile = null;
let currentStatsFile = null;
let pendingStatusMessages = [];

function sendStatusUpdate(message) {
  const mainWindow = BrowserWindow.getAllWindows().find(win => win !== statusWindow);
  if (mainWindow) {
    mainWindow.webContents.send('status-update', message);
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    const statusWc = statusWindow.webContents;
    if (statusWc.isLoading() || statusWc.isLoadingMainFrame()) {
      pendingStatusMessages.push(message);
    } else {
      statusWc.send('status-update', message);
    }
  }
}

function createWindow() {
  const iconPath = fs.existsSync(path.join(__dirname, 'logo.png'))
    ? path.join(__dirname, 'logo.png')
    : path.join(__dirname, 'Logo.ico');

  const win = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    frame: false,           // removes default OS title bar
    backgroundColor: '#1a1d23',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  // Register global hotkeys
  globalShortcut.register('F1', () => {
    const mainWindow = BrowserWindow.getAllWindows().find(win => win !== statusWindow);
    if (mainWindow) {
      mainWindow.webContents.send('hotkey', 'play');
    }
  });
  globalShortcut.register('F3', () => {
    console.log('F3 pressed, runningProcess:', !!runningProcess);
    if (runningProcess) {
      const stopFile = currentStopFile;
      console.log('Writing stop signal to:', stopFile);
      try {
        fs.writeFileSync(stopFile, 'stop', 'utf8');
      } catch (err) {
        console.error('Could not create stop file:', err);
      }
      
      setTimeout(() => {
        if (runningProcess) {
          console.log('Force killing process');
          runningProcess.kill();
          runningProcess = null;
          sendStatusUpdate('Macro stopped by user');
          
          const mainWindow = BrowserWindow.getAllWindows().find(win => win !== statusWindow);
          if (statusWindow && !statusWindow.isDestroyed()) {
            setTimeout(() => {
              if (statusWindow && !statusWindow.isDestroyed()) {
                statusWindow.close();
              }
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
              }
            }, 500);
          } else {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
            }
          }
        }
      }, 500);
    } else {
      console.log('No process running');
    }
  });
  globalShortcut.register('F4', () => {
    const mainWindow = BrowserWindow.getAllWindows().find(win => win !== statusWindow);
    if (mainWindow && mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.show();
      statusWindow.focus();
    }
  });
}

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return; // Window already exists and is valid
  }

  // Clean up any destroyed window reference
  if (statusWindow && statusWindow.isDestroyed()) {
    statusWindow = null;
  }

  const iconPath = fs.existsSync(path.join(__dirname, 'logo.png'))
    ? path.join(__dirname, 'logo.png')
    : path.join(__dirname, 'Logo.ico');

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  const windowWidth = 320;
  const windowHeight = 176;
  const x = Math.floor(width - windowWidth - 20);
  const y = Math.floor((height - windowHeight) / 2);

  const alwaysOnTop = loadSettings().overlayAlwaysOnTop;

  statusWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    resizable: false,
    frame: false,
    alwaysOnTop: alwaysOnTop,
    skipTaskbar: true,  // Don't show in taskbar
    backgroundColor: '#1a1d23',
    icon: iconPath,
    show: true,  // Show immediately to prevent disappearing
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  statusWindow.loadFile('status.html').catch(err => {
    console.error('Failed to load status.html:', err);
  });

  statusWindow.webContents.once('did-finish-load', () => {
    console.log('Status window finished loading');
    if (!statusWindow || statusWindow.isDestroyed()) return;
    pendingStatusMessages.forEach((msg) => {
      statusWindow.webContents.send('status-update', msg);
    });
    pendingStatusMessages = [];
  });

  // Focus window after a short delay to ensure it's stable
  setTimeout(() => {
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.focus();
      if (alwaysOnTop) {
        statusWindow.setAlwaysOnTop(true, 'screen-saver');
        statusWindow.setVisibleOnAllWorkspaces(true);
      }
    }
  }, 100);

  statusWindow.on('closed', () => {
    statusWindow = null;
  });

  statusWindow.on('unresponsive', () => {
    console.error('Status window became unresponsive');
  });

  statusWindow.webContents.on('crashed', (event, killed) => {
    console.error('Status window crashed:', killed);
  });

  // Debug: log when window is created
  console.log('Status window created and shown');
}

// Resolve the AHK v1.1 interpreter, or show the friendly install dialog and
// return null. Shared by the macro launcher and the pixel-inspector launcher.
function resolveAhkOrPrompt(win) {
  const ahkPath = findAhkV1();
  if (ahkPath) return ahkPath;
  const choice = dialog.showMessageBoxSync(win, {
    type: 'error',
    title: 'AutoHotkey 1.1 Required',
    message: 'AutoHotkey v1.1 was not found on this PC.',
    detail:
      'This macro needs AutoHotkey version 1.1 (not v2).\n\n' +
      'Click "Download AutoHotkey 1.1" to get the correct installer, run it, ' +
      'then try again.',
    buttons: ['Download AutoHotkey 1.1', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice === 0) shell.openExternal(AHK_DOWNLOAD_URL);
  return null;
}

// Launch an .ahk tool script detached from the app (copies to temp first so it
// works in a packaged/asar build). Returns true if spawned.
function launchAhkTool(scriptName, win) {
  const ahkPath = resolveAhkOrPrompt(win);
  if (!ahkPath) return false;

  let scriptPath = path.join(__dirname, scriptName);
  const tempScriptPath = path.join(require('os').tmpdir(), scriptName);
  try {
    fs.copyFileSync(scriptPath, tempScriptPath);
    scriptPath = tempScriptPath;
  } catch (err) {
    console.error(`Could not copy ${scriptName} to temp:`, err);
  }

  try {
    const proc = spawn(ahkPath, [scriptPath], { detached: true, stdio: 'ignore' });
    proc.unref();
    return true;
  } catch (err) {
    console.error(`Could not launch ${scriptName}:`, err);
    return false;
  }
}

ipcMain.on('launch-inspector', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ok = launchAhkTool('PixelInspector.ahk', win);
  event.sender.send('status-update', ok
    ? 'Pixel Inspector launched — hover a pixel and press F8 (F9 to quit).'
    : 'Error: could not launch Pixel Inspector.');
});

// ---- Persistent user settings ---------------------------------------------
const SETTINGS_DEFAULTS = {
  closeRobloxOnStop: false,   // kill Roblox when the macro stops/finishes
  showStatusOverlay: true,    // show the small floating status window
  overlayAlwaysOnTop: true,   // keep that overlay pinned above other windows
  closeBrowserTab: false,     // close the leftover roblox.com browser tab after launch (AHK-side)
  // How the macro launches Roblox: 'auto' = roblox:// deep link (no browser
  // tab), falling back to the browser URL after 2 failed deep-link attempts;
  // 'browser' = always launch via roblox.com in the default browser.
  launchMethod: 'auto',
  restartLoopGuard: true,     // auto-stop after 5 straight restarts with no completed round
  discordWebhookUrl: '',      // Discord webhook for run updates ('' = disabled)
  discordPingUserId: '',      // Discord user ID to @ping on critical alerts ('' = no ping)
  // Per-event webhook toggles (Webhook settings modal). Key -> send that event.
  webhookEvents: {
    started: true,       // "Macro started"
    roundComplete: true, // round-complete embed (coins/XP/mana)
    placements: false,   // hero placed messages
    upgrades: false,     // hero upgrade progress / maxed messages
    restarts: true,      // Roblox restarts / recovery + error details
    stopped: true,       // "Macro stopped" summary
  },
  // OCR region overrides from the hidden debug calibrator (null = use the
  // built-in OCR_REGION_DEFAULTS). Shape mirrors OCR_REGION_DEFAULTS.
  ocrRegions: null,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const merged = Object.assign({}, SETTINGS_DEFAULTS, parsed);
    // Deep-merge the nested toggle map so new event keys get their defaults.
    merged.webhookEvents = Object.assign({}, SETTINGS_DEFAULTS.webhookEvents, parsed.webhookEvents || {});
    return merged;
  } catch (err) {
    return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  }
}

function saveSettings(partial) {
  const merged = Object.assign(loadSettings(), partial || {});
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save settings:', err);
  }
  return merged;
}

// Close the Roblox game client (used when closeRobloxOnStop is enabled).
function closeRoblox() {
  exec('taskkill /F /IM RobloxPlayerBeta.exe', () => { /* ignore if not running */ });
}

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('save-settings', (e, partial) => { saveSettings(partial); });

// ---- Lifetime stats (persisted to userData/lifetime-stats.json) ------------
// Cumulative across all sessions; a session's totals are added when the macro
// process closes. Display-only, so read/write failures are swallowed.
const LIFETIME_DEFAULTS = { rounds: 0, coins: 0, xp: 0, timeSec: 0, sessions: 0 };

function lifetimeStatsPath() {
  return path.join(app.getPath('userData'), 'lifetime-stats.json');
}

function loadLifetimeStats() {
  try {
    const raw = fs.readFileSync(lifetimeStatsPath(), 'utf8');
    return Object.assign({}, LIFETIME_DEFAULTS, JSON.parse(raw));
  } catch (err) {
    return Object.assign({}, LIFETIME_DEFAULTS);
  }
}

function addLifetimeStats(delta) {
  const t = loadLifetimeStats();
  t.rounds += delta.rounds || 0;
  t.coins += delta.coins || 0;
  t.xp = Math.round((t.xp + (delta.xp || 0)) * 10) / 10;
  t.timeSec += delta.timeSec || 0;
  t.sessions += 1;
  try {
    fs.writeFileSync(lifetimeStatsPath(), JSON.stringify(t, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save lifetime stats:', err);
  }
  return t;
}

ipcMain.handle('get-lifetime-stats', () => loadLifetimeStats());

// ---- Screen OCR (Windows.Media.Ocr via ocr.ps1) -----------------------------
// Regions are calibrated at the 2560x1440 baseline and scaled at capture time.
// Boxes are deliberately generous — OCR tolerates padding, unlike pixel checks.
// Boxes are intentionally WIDE — OCR ignores non-text padding, and the first
// number found is parsed out, so overshooting beats missing a shifted dialog.
// Reward-dialog boxes measured from a real end-of-round screenshot (2560x1440):
// number row sits at y 792-851; "You reached Wave N" ends at y~742 above it and
// "game lasted for M:SS" starts at y~899 below — the y 750-880 band captures
// ONLY the reward numbers. (Critical for the rewards strip: overshooting
// vertically leaks "Wave 7" / "1:57" digits in, and the coins fallback takes
// the first number it sees.)
const OCR_REGION_DEFAULTS = {
  coins: { x: 850,  y: 700, w: 277, h: 180 }, // coins number. Two hard-won constraints:
  // (1) right edge 1127 stops SHORT of the coin icon (icon x~1133-1210, digits
  //     end ~1115, right-aligned against it so longer numbers grow left) —
  //     any icon sliver OCRs as a trailing digit ("211" for 21 coins, live 1080p);
  // (2) top edge 700 reaches up to the digit-free "Campaign Mode Rewards" label —
  //     Windows OCR flat-out refuses a short bare number alone in the box (a
  //     clean binarized "21" read "" at most scales!), but reads it reliably
  //     when the label fragment above anchors a text line ("Caml 21").
  // This dialog is only OCR'd on WINS, so the Game Over variant's "You reached
  // Wave N" (digits!) can't leak into the taller box.
  exp:   { x: 1300, y: 750, w: 330, h: 130 }, // XP number + "EXP" label (label anchors parseOcrXP)
  // Whole reward row in one box (coins + XP together). Backup source: the
  // split boxes can miss a shifted dialog; here XP is found by its "EXP" label
  // and coins as the first number, wherever they landed inside the strip.
  rewards: { x: 830, y: 750, w: 850, h: 130 },
  mana:  { x: 60,   y: 1300, w: 320, h: 130 }, // bottom-left live mana counter
};

// Effective OCR regions: defaults overlaid with any user overrides from the
// debug calibrator. Read at capture time so calibration applies immediately.
// Malformed overrides fall back to the default per region.
function getOcrRegions() {
  const overrides = loadSettings().ocrRegions || {};
  const out = {};
  for (const key of Object.keys(OCR_REGION_DEFAULTS)) {
    const o = overrides[key];
    const valid = o && [o.x, o.y, o.w, o.h].every((v) => Number.isFinite(v)) && o.w > 0 && o.h > 0;
    out[key] = valid ? { x: o.x, y: o.y, w: o.w, h: o.h } : OCR_REGION_DEFAULTS[key];
  }
  return out;
}

// OCR a screen region; resolves to the recognized text ('' on any failure —
// OCR is cosmetic (stats/webhook), so it must never break a run).
function ocrRegion(region, scale) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'ocr.ps1'),
      '-X', String(Math.round(region.x * scale)),
      '-Y', String(Math.round(region.y * scale)),
      '-W', String(Math.round(region.w * scale)),
      '-H', String(Math.round(region.h * scale)),
    ];
    let out = '';
    try {
      const p = spawn('powershell.exe', args, { windowsHide: true });
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out.trim()));
    } catch (err) {
      resolve('');
    }
  });
}

// Pull the first number out of OCR text. Keeps decimals ("9.2" XP) and strips
// thousands separators ("1,250" -> 1250). Returns null if nothing numeric.
function parseOcrNumber(text) {
  const m = (text || '').match(/\d[\d.,]*/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// XP-specific parse: prefer the number sitting next to an EXP/XP label so a
// wide capture that also contains the coins number can't be mistaken for XP.
// Falls back to the first plain number when no label was recognized.
function parseOcrXP(text) {
  const t = text || '';
  const labeled = t.match(/(\d[\d.,]*)\s*(?:E\s*X\s*P|EXP|XP)/i)   // "9.2 EXP"
               || t.match(/(?:E\s*X\s*P|EXP|XP)\s*(\d[\d.,]*)/i);  // "EXP 9.2"
  if (labeled) {
    const n = parseFloat(labeled[1].replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return parseOcrNumber(t);
}

// Debug calibrator IPC: expose the baseline regions and run a one-off OCR of
// an arbitrary region so the user can tune boxes live against the game screen.
ipcMain.handle('get-ocr-defaults', () => OCR_REGION_DEFAULTS);
ipcMain.handle('test-ocr-region', async (e, region) => {
  const r = region || {};
  const valid = [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) && r.w > 0 && r.h > 0;
  if (!valid) return { ok: false, error: 'Invalid region (need numeric X/Y and positive W/H)' };
  const { screen } = require('electron');
  const d = screen.getPrimaryDisplay();
  const physW = Math.round(d.size.width * (d.scaleFactor || 1));
  const text = await ocrRegion({ x: r.x, y: r.y, w: r.w, h: r.h }, physW / 2560);
  return { ok: true, text };
});

// Log raw OCR reads to userData\ocr-debug.log so misreads can be diagnosed
// from a real run without a console attached.
function ocrDebugLog(line) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'ocr-debug.log'),
      `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (err) { /* never let logging break anything */ }
}

// ---- Discord webhook --------------------------------------------------------
// Fire-and-forget POST to the user's webhook URL (settings). Errors are logged
// and swallowed — notifications must never affect the run. `eventKey` names the
// per-event toggle (settings.webhookEvents) that gates this message.
function postDiscordWebhook(payload, eventKey) {
  const settings = loadSettings();
  const url = (settings.discordWebhookUrl || '').trim();
  if (!url.startsWith('https://')) return;
  if (eventKey && settings.webhookEvents && settings.webhookEvents[eventKey] === false) return;
  postWebhookOnce(url, payload).then((r) => {
    if (!r.ok) console.error('Webhook post failed:', r.error || `HTTP ${r.status}`);
  });
}

// "<@id> " mention prefix for critical alerts (restart-loop guard, errors),
// or '' when no ping user ID is configured. Digits-only sanitize so a pasted
// "@name" or "<@123>" still works.
function discordPing() {
  const id = (loadSettings().discordPingUserId || '').replace(/\D/g, '');
  return id ? `<@${id}> ` : '';
}

// Build a one-embed payload. Every webhook message is an embed for a uniform
// look; `ping` (a "<@id> " prefix or '') goes in `content` because mentions
// inside embeds render but never actually notify the user.
const EMBED_COLORS = {
  info: 0x2563eb,     // blue  — rounds, placements
  success: 0x22c55e,  // green — started, test, upgrades/maxed
  warn: 0xf59e0b,     // amber — restarts
  error: 0xef4444,    // red   — errors, loop guard
  neutral: 0x64748b,  // grey  — stopped
};
function makeEmbed({ title, description, color, fields, footer, ping }) {
  const embed = { title, color: EMBED_COLORS[color] || EMBED_COLORS.info };
  if (description) embed.description = description;
  if (fields) embed.fields = fields;
  if (footer) embed.footer = { text: footer };
  const payload = { username: 'Tower Heroes Macro', embeds: [embed] };
  if (ping) payload.content = ping.trim();
  return payload;
}

// One awaited POST to a webhook URL; resolves { ok, status?, error? }. Used by
// postDiscordWebhook and by the "Test webhook" button (which needs the result).
function postWebhookOnce(url, payload) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const u = new URL(url);
      const body = JSON.stringify(payload);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: 'request timed out' }); });
      req.write(body);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// "Test webhook" button: posts a sample message to the URL currently in the
// input (not necessarily saved yet) and reports success/failure to the UI.
ipcMain.handle('test-webhook', (e, url) => {
  const target = (url || '').trim();
  if (!target.startsWith('https://')) {
    return { ok: false, error: 'URL must start with https://' };
  }
  return postWebhookOnce(target, makeEmbed({
    title: '✅ Test message',
    description: 'This webhook is set up correctly!',
    color: 'success',
  }));
});

// Supported physical resolutions (macro coords are calibrated to these).
const SUPPORTED_RESOLUTIONS = [
  [2560, 1440],
  [1920, 1080],
  [3840, 2160],
];

// Check the primary display's real resolution and scaling against what the
// macro supports. Returns { ok, physW, physH, scalePct, title, detail }.
// Mirrors the checks inside TowerHeroesMacro.ahk, but runs up front so the user
// is told before Roblox launches — not after a confusing restart loop.
function checkDisplaySupport() {
  const { screen } = require('electron');
  const d = screen.getPrimaryDisplay();
  const scale = d.scaleFactor || 1;
  const scalePct = Math.round(scale * 100);
  // .size is in DIPs; multiply by scaleFactor to recover physical pixels.
  const physW = Math.round(d.size.width * scale);
  const physH = Math.round(d.size.height * scale);

  if (scale !== 1) {
    return {
      ok: false,
      physW, physH, scalePct,
      title: 'Display Scaling Must Be 100%',
      detail:
        `Your Windows display scaling is ${scalePct}%. The macro needs 100%.\n\n` +
        'Fix: Settings > System > Display > Scale — set it to 100%, then start the macro again.',
    };
  }

  // NOTE: this exact match is only reached when scale === 1 (the check above
  // returns otherwise), so DIP size equals physical pixels and there's no
  // rounding error. At non-100% scale, physW can round off by 1px
  // (e.g. 1707 DIP * 1.5 = 2560.5 -> 2561) — but we never get here in that case.
  const supported = SUPPORTED_RESOLUTIONS.some(([w, h]) => w === physW && h === physH);
  if (!supported) {
    return {
      ok: false,
      physW, physH, scalePct,
      title: 'Unsupported Resolution',
      detail:
        `Your resolution (${physW}x${physH}) isn't supported.\n\n` +
        'Fix: Settings > System > Display > Display resolution — set it to one of:\n' +
        '   - 2560 x 1440\n   - 1920 x 1080\n   - 3840 x 2160\n\n' +
        'Then start the macro again.',
    };
  }

  return { ok: true, physW, physH, scalePct };
}

// Window control IPC handlers
ipcMain.on('window-minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender).minimize();
});
ipcMain.on('window-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window-close', (e) => {
  BrowserWindow.fromWebContents(e.sender).close();
});

// Run AHK script handler
ipcMain.on('run-script', (event, action, map, difficulty, resolution) => {
  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  
  // Handle stop action
  if (action === 'stop') {
    if (runningProcess) {
      // First try to signal via stop file (graceful stop)
      const stopFile = currentStopFile || path.join(require('os').tmpdir(), 'stop.txt');
      try {
        fs.writeFileSync(stopFile, 'stop', 'utf8');
      } catch (err) {
        console.error('Could not create stop file:', err);
      }
      
      // Give it a moment to respond to the stop file
      setTimeout(() => {
        // If still running, force kill it
        if (runningProcess) {
          runningProcess.kill();
          runningProcess = null;
          event.sender.send('status-update', 'Macro stopped.');
          if (statusWindow) {
            statusWindow.webContents.send('status-update', 'Macro stopped.');
            setTimeout(() => {
              if (statusWindow && !statusWindow.isDestroyed()) {
                statusWindow.close();
              }
              // Show main window when status window closes
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
              }
            }, 500);
          } else {
            // Show main window if status window doesn't exist
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
            }
          }
        }
      }, 500);
    } else {
      event.sender.send('status-update', 'No macro running.');
    }
    return;
  }

  // Handle start action
  if (runningProcess) {
    event.sender.send('status-update', 'Macro already running.');
    return;
  }

  // Locate a valid AutoHotkey v1.1 interpreter before doing anything else.
  // If it's missing we tell the user how to fix it (via resolveAhkOrPrompt)
  // instead of crashing with a raw "spawn ... ENOENT" uncaught exception.
  const ahkPath = resolveAhkOrPrompt(mainWindow);
  if (!ahkPath) {
    event.sender.send('status-update', 'Error: AutoHotkey v1.1 not found.');
    return;
  }

  // Verify the display resolution/scaling is supported before launching Roblox,
  // so an unsupported setup gets a clear message instead of an endless
  // "Looking for play button" restart loop.
  const display = checkDisplaySupport();
  if (!display.ok) {
    event.sender.send('status-update', `Error: ${display.title}`);
    dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: display.title,
      message: display.title,
      detail: display.detail,
      buttons: ['OK'],
      noLink: true,
    });
    return;
  }

  // Hide main window when script starts
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  // Open status window when script starts (unless disabled in settings)
  if (loadSettings().showStatusOverlay) {
    createStatusWindow();
  }
  event.sender.send('status-update', 'Macro starting...');
  pendingStatusMessages.push('Macro starting...');

  // One shared engine script: the in-game sequence (heroes, upgrades,
  // completion) is identical across these maps — only the lobby map-pick
  // step differs, and the script branches on the map name it gets as arg 2.
  let scriptPath = path.join(__dirname, 'TowerHeroesMacro.ahk');

  // For packaged app, copy script to temp directory
  const tempDir = require('os').tmpdir();
  const tempScriptPath = path.join(tempDir, path.basename(scriptPath));
  try {
    fs.copyFileSync(scriptPath, tempScriptPath);
    scriptPath = tempScriptPath;
  } catch (err) {
    console.error('Could not copy AHK script to temp:', err);
  }
  // The macro shells out to ocr.ps1 (MAX detection) via A_ScriptDir — keep the
  // helper next to the copied script.
  try {
    fs.copyFileSync(path.join(__dirname, 'ocr.ps1'), path.join(tempDir, 'ocr.ps1'));
  } catch (err) {
    console.error('Could not copy ocr.ps1 to temp:', err);
  }

  // Use the real detected resolution (the renderer always sends 2560x1440).
  const resParam = `${display.physW}x${display.physH}`;
  const statusFile = path.join(tempDir, `towerheroes-status-${Date.now()}.txt`);
  // Fixed names: the macro derives these from the status file's directory as
  // "stop.txt" / "macro_running.txt" — timestamped names here would mean the
  // stop signal lands in a file the macro never reads.
  const stopFile = path.join(tempDir, 'stop.txt');
  const macroRunningFile = path.join(tempDir, 'macro_running.txt');
  // Fixed name (the macro derives the same path from the status file's dir).
  const statsFile = path.join(tempDir, 'towerheroes-stats.txt');

  currentStatusFile = statusFile;
  currentStopFile = stopFile;
  currentMacroRunningFile = macroRunningFile;
  currentStatsFile = statsFile;

  console.log('Using status file:', statusFile);
  console.log('Using stop file:', stopFile);
  console.log('Using macro running file:', macroRunningFile);

  try { fs.writeFileSync(statusFile, '', 'utf8'); } catch (err) { console.error('Could not reset status file', err); }
  try { fs.unlinkSync(stopFile); } catch (err) { /* ignore */ }
  try { fs.writeFileSync(macroRunningFile, '', 'utf8'); } catch (err) { console.error('Could not reset macro_running file', err); }
  try { fs.writeFileSync(statsFile, '0|0', 'utf8'); } catch (err) { console.error('Could not reset stats file', err); }

  // Session reward totals, filled by OCR of the "Game Complete" dialog.
  const ocrScale = display.physW / 2560;
  let sessionCoins = 0;
  let sessionXP = 0;
  let sessionMana = null;   // latest live-mana read (null until first success)

  const sendRoundWebhook = (roundCoins, roundXP) => {
    const sec = Math.floor((Date.now() - runStartTime) / 1000);
    postDiscordWebhook(makeEmbed({
      title: '🏰 Round complete',
      color: 'info',
      fields: [
        { name: 'Rounds', value: String(statsRounds), inline: true },
        { name: 'Coins (round)', value: roundCoins === null ? '—' : String(roundCoins), inline: true },
        { name: 'XP (round)', value: roundXP === null ? '—' : String(roundXP), inline: true },
        { name: 'Total coins', value: String(sessionCoins), inline: true },
        { name: 'Total XP', value: String(sessionXP), inline: true },
        { name: 'Mana', value: sessionMana === null ? '—' : String(sessionMana), inline: true },
      ],
      footer: `Session ${Math.floor(sec / 60)}m ${sec % 60}s · ${statsRestarts} restarts`,
    }), 'roundComplete');
  };

  // Status-driven webhook events (placement / upgrade / restart messages).
  // Statuses come from the macro's status file; each pattern maps a family of
  // status texts to a per-event toggle in Webhook settings.
  const sendStatusWebhook = (statusText) => {
    let eventKey = null;
    let emoji = null;
    let color = 'info';
    if (/placed successfully$|^Both heroes placed$/.test(statusText)) {
      eventKey = 'placements'; emoji = '🦸';
    // NOTE: deliberately not matching the per-tick "Upgrading X (12s)" ticker —
    // it changes every few seconds and would flood the channel / rate limit.
    } else if (/maxed \(|upgrade cap reached/.test(statusText)) {
      eventKey = 'upgrades'; emoji = '⬆️'; color = 'success';
    } else if (/full restart|— restarting/.test(statusText)) {
      eventKey = 'restarts'; emoji = '🔁'; color = 'warn';
    }
    if (!eventKey) return;
    let footer = null;
    if (eventKey === 'restarts') {
      // Restart messages carry session context — the status already says WHY
      // (which timeout / crash), this adds where the run was when it happened.
      const sec = Math.floor((Date.now() - runStartTime) / 1000);
      footer = `Round ${statsRounds} · ${Math.floor(sec / 60)}m ${sec % 60}s in · ${statsRestarts} restarts so far`;
    }
    postDiscordWebhook(makeEmbed({ title: `${emoji} ${statusText}`, color, footer }), eventKey);
  };

  const captureRewardsOnce = () => {
    const R = getOcrRegions();
    return Promise.all([
      ocrRegion(R.coins, ocrScale),
      ocrRegion(R.exp, ocrScale),
      ocrRegion(R.rewards, ocrScale),
      ocrRegion(R.mana, ocrScale),
    ]);
  };
  // Merge the split-box reads with the full-strip read: split boxes win when
  // they parsed, the strip backfills XP (anchored to its EXP label). The strip
  // is NEVER used for coins: the coin icon sits mid-strip right after the
  // digits and OCR merges it into the number (live 1080p: "210 9.3" for
  // 21 coins) — a corrupt backfill is worse than a missed one.
  const parseRewards = (coinsText, expText, rewardsText) => {
    let coins = parseOcrNumber(coinsText);
    let xp = parseOcrXP(expText);
    if (xp === null) {
      const stripXP = (rewardsText || '').match(/(\d[\d.,]*)\s*(?:E\s*X\s*P|EXP|XP)/i);
      if (stripXP) xp = parseFloat(stripXP[1].replace(/,/g, ''));
      if (xp !== null && !Number.isFinite(xp)) xp = null;
    }
    return { coins, xp };
  };
  const captureRoundRewards = () => {
    const finish = (coins, xp, mana) => {
      if (coins !== null) sessionCoins += coins;
      if (xp !== null) sessionXP = Math.round((sessionXP + xp) * 10) / 10;
      if (mana !== null) sessionMana = mana;
      sendRoundWebhook(coins, xp);
    };
    captureRewardsOnce().then(([coinsText, expText, rewardsText, manaText]) => {
      ocrDebugLog(`round try1: coins="${coinsText}" exp="${expText}" strip="${rewardsText}" mana="${manaText}"`);
      const { coins, xp } = parseRewards(coinsText, expText, rewardsText);
      if (coins === null || xp === null) {
        // Something's still missing — dialog may still be animating in.
        // One more pass inside the 4s hold, keeping whatever try1 did get.
        setTimeout(() => {
          captureRewardsOnce().then(([c2, x2, r2, m2]) => {
            ocrDebugLog(`round try2: coins="${c2}" exp="${x2}" strip="${r2}" mana="${m2}"`);
            const second = parseRewards(c2, x2, r2);
            finish(coins !== null ? coins : second.coins,
                   xp !== null ? xp : second.xp,
                   parseOcrNumber(m2));
          });
        }, 1500);
      } else {
        finish(coins, xp, parseOcrNumber(manaText));
      }
    });
  };

  // Live mana for the overlay + webhook: light OCR poll while the macro runs.
  const manaPoll = setInterval(() => {
    ocrRegion(getOcrRegions().mana, ocrScale).then((t) => {
      const v = parseOcrNumber(t);
      if (v !== null) sessionMana = v;
    });
  }, 5000);

  let lastStatusText = '';
  const readStatusFile = () => {
    try {
      const statusText = fs.readFileSync(statusFile, 'utf8').trim();
      // Only log/forward when the status actually CHANGES — the file is polled
      // every 300ms and re-sending the same text just spams the console(s).
      if (statusText && statusText !== lastStatusText) {
        lastStatusText = statusText;
        console.log('Status:', statusText);
        sendStatusUpdate(statusText);
        sendStatusWebhook(statusText);
        // Edge-trigger on the transition into "Map completed": the macro holds
        // the results dialog open ~4s, during which we OCR the rewards.
        if (statusText === 'Map completed') captureRoundRewards();
      }
    } catch (err) {
      console.error('Status read error', err.message);
    }
  };

  // Run stats: the macro writes "rounds|restarts"; elapsed is timed here.
  const runStartTime = Date.now();
  let statsRounds = 0;
  let statsRestarts = 0;

  // Restart-loop guard: if the macro keeps doing full restarts without ever
  // completing a round, something is broken (bad server, changed UI, wrong
  // resolution) — stop it instead of relaunching Roblox forever.
  const RESTART_LOOP_LIMIT = 5;
  const guardEnabled = loadSettings().restartLoopGuard !== false;
  let guardTriggered = false;
  let lastSeenRounds = 0;
  let restartsAtLastRound = 0;
  const checkRestartLoop = () => {
    if (!guardEnabled || guardTriggered) return;
    if (statsRounds > lastSeenRounds) {
      // A round completed — the run is healthy; reset the streak baseline.
      lastSeenRounds = statsRounds;
      restartsAtLastRound = statsRestarts;
      return;
    }
    const streak = statsRestarts - restartsAtLastRound;
    if (streak < RESTART_LOOP_LIMIT) return;
    guardTriggered = true;
    const msg = `Restart-loop guard: ${streak} restarts without completing a round — stopping the macro.`;
    console.error(msg);
    sendStatusUpdate(msg);
    postDiscordWebhook(makeEmbed({
      title: '🛑 Restart-loop guard triggered',
      description: msg,
      color: 'error',
      ping: discordPing(),
    }), 'restarts');
    // Graceful stop via the stop file; force-kill if the macro doesn't exit.
    try { fs.writeFileSync(stopFile, 'stop', 'utf8'); } catch (err) { /* ignore */ }
    setTimeout(() => {
      if (runningProcess) runningProcess.kill();
    }, 5000);
  };

  const readStatsFile = () => {
    try {
      const raw = fs.readFileSync(statsFile, 'utf8').trim();
      if (raw) {
        const parts = raw.split('|');
        statsRounds = parseInt(parts[0], 10) || 0;
        statsRestarts = parseInt(parts[1], 10) || 0;
      }
    } catch (err) { /* not written yet */ }
    checkRestartLoop();
    const stats = {
      rounds: statsRounds,
      restarts: statsRestarts,
      elapsedSec: Math.floor((Date.now() - runStartTime) / 1000),
      coins: sessionCoins,
      xp: sessionXP,
      mana: sessionMana,
    };
    if (statusWindow && !statusWindow.isDestroyed()) {
      const wc = statusWindow.webContents;
      if (!(wc.isLoading() || wc.isLoadingMainFrame())) wc.send('stats-update', stats);
    }
    const mainWin = BrowserWindow.getAllWindows().find((w) => w !== statusWindow);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('stats-update', stats);
  };

  const statusPoll = setInterval(() => { readStatusFile(); readStatsFile(); }, 300);
  readStatusFile();
  readStatsFile();
  console.log('Status polling started for:', statusFile);

  // Arg 6: "1" = close the leftover roblox.com browser tab after launch.
  // Arg 7: launch method — 'auto' (deep link + browser fallback) or 'browser'.
  const launchSettings = loadSettings();
  const closeTabFlag = launchSettings.closeBrowserTab ? '1' : '0';
  const launchMethod = launchSettings.launchMethod === 'browser' ? 'browser' : 'auto';
  const args = [scriptPath, action, map, difficulty, resParam, statusFile, closeTabFlag, launchMethod];
  console.log('Spawning AHK with args:', JSON.stringify(args));
  console.log('Total args count:', args.length);
  
  runningProcess = spawn(ahkPath, args);

  console.log('AHK process spawned, PID:', runningProcess.pid);
  postDiscordWebhook(makeEmbed({
    title: '▶️ Macro started',
    description: `${map} — ${difficulty}`,
    color: 'success',
  }), 'started');

  // NOTE: do not early-return if pid is missing. A failed spawn (e.g. ENOENT)
  // reports asynchronously via the 'error' event below, which handles cleanup.
  // Returning here would leave statusPoll running and the error unhandled,
  // producing the "Uncaught Exception" crash dialog.
  if (!runningProcess.pid) {
    console.error('AHK process has no PID yet; awaiting error/close event');
  }

  let stdout = '';
  let stderr = '';

  if (runningProcess.stdout) {
    runningProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
  }

  if (runningProcess.stderr) {
    runningProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
  }

  runningProcess.on('error', (error) => {
    clearInterval(statusPoll);
    clearInterval(manaPoll);
    runningProcess = null;
    currentStatusFile = null;
    currentStopFile = null;
    currentMacroRunningFile = null;
    currentStatsFile = null;
    try { fs.unlinkSync(statsFile); } catch (err) { /* ignore */ }
    console.error(`Error running AHK script: ${error.message}`);
    postDiscordWebhook(makeEmbed({
      title: '⚠️ Macro failed to launch',
      description: error.message,
      color: 'error',
      ping: discordPing(),
    }), 'restarts');
    event.sender.send('status-update', `Error: ${error.message}`);
    if (statusWindow) statusWindow.webContents.send('status-update', `Error: ${error.message}`);

    // Restore the UI to a usable state after a failed launch.
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  runningProcess.on('close', (code, signal) => {
    clearInterval(statusPoll);
    clearInterval(manaPoll);
    const stopSec = Math.floor((Date.now() - runStartTime) / 1000);
    const lifetime = addLifetimeStats({
      rounds: statsRounds, coins: sessionCoins, xp: sessionXP, timeSec: stopSec,
    });
    postDiscordWebhook(makeEmbed({
      title: '⏹ Macro stopped',
      color: 'neutral',
      fields: [
        { name: 'Rounds', value: String(statsRounds), inline: true },
        { name: 'Coins', value: String(sessionCoins), inline: true },
        { name: 'XP', value: String(sessionXP), inline: true },
        { name: 'Session time', value: `${Math.floor(stopSec / 60)}m ${stopSec % 60}s`, inline: true },
      ],
      footer: `Lifetime: ${lifetime.rounds} rounds · ${lifetime.coins} coins · ${lifetime.xp} XP · ${lifetime.sessions} sessions`,
    }), 'stopped');
    runningProcess = null; // Clear the reference when process ends
    currentStatusFile = null;
    currentStopFile = null;
    currentMacroRunningFile = null;
    currentStatsFile = null;

    // Optionally close Roblox when the macro ends (setting-controlled).
    if (loadSettings().closeRobloxOnStop) closeRoblox();

    // Clean up temp script
    try { fs.unlinkSync(tempScriptPath); } catch (err) { }

    if (stderr) {
      console.error(`AHK stderr: ${stderr}`);
      postDiscordWebhook(makeEmbed({
        title: '⚠️ Macro error output',
        description: `\`\`\`\n${stderr.trim().slice(0, 900)}\n\`\`\``,
        color: 'error',
        ping: discordPing(),
      }), 'restarts');
      event.sender.send('status-update', `AHK stderr: ${stderr}`);
      if (statusWindow) statusWindow.webContents.send('status-update', `AHK stderr: ${stderr}`);
    }
    if (stdout) {
      console.log(`AHK stdout: ${stdout}`);
      event.sender.send('status-update', stdout.trim());
      if (statusWindow) statusWindow.webContents.send('status-update', stdout.trim());
    }

    // Clean up temp files
    try { fs.unlinkSync(stopFile); } catch (err) { }
    try { fs.unlinkSync(macroRunningFile); } catch (err) { }
    try { fs.unlinkSync(statsFile); } catch (err) { }

    // Close status window and show main window when script finishes
    if (statusWindow) {
      setTimeout(() => {
        if (statusWindow && !statusWindow.isDestroyed()) {
          statusWindow.close();
        }
        // Show main window when script finishes
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      }, 1000);
    } else {
      // Show main window if status window doesn't exist
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
});

// ---- Auto-update (GitHub releases via electron-updater) --------------------
// Checks shortly after launch and every 4h. Nothing downloads until the user
// clicks "Update now" in the renderer's toast (autoDownload=false). Once
// downloaded, "Restart & install" applies it immediately (quitAndInstall —
// which fires before-quit, so a running macro is stopped first); if the user
// picks "later", it still installs silently on the next normal quit.
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (err) { /* optional dep */ }

function sendUpdateEvent(payload) {
  const mainWin = BrowserWindow.getAllWindows().find((w) => w !== statusWindow);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-event', payload);
}

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return; // dev runs have no update feed
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => sendUpdateEvent({ type: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => sendUpdateEvent({
    type: 'progress',
    percent: p.percent,
    transferred: p.transferred,
    total: p.total,
    bytesPerSecond: p.bytesPerSecond,
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateEvent({ type: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => sendUpdateEvent({ type: 'error', message: String((err && err.message) || err) }));
  const check = () => { autoUpdater.checkForUpdates().catch(() => { /* offline is fine */ }); };
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

ipcMain.handle('download-update', () => {
  if (!autoUpdater || !app.isPackaged) return false;
  autoUpdater.downloadUpdate().catch((err) => sendUpdateEvent({ type: 'error', message: String((err && err.message) || err) }));
  return true;
});
ipcMain.handle('install-update', () => {
  if (!autoUpdater || !app.isPackaged) return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
});
ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

// Closing the app must take the macro down with it — an orphaned AHK process
// keeps clicking the screen with no way to stop it except Task Manager (and a
// later relaunch would run two macros at once, fighting over the mouse).
app.on('before-quit', () => {
  if (runningProcess) {
    if (currentStopFile) {
      try { fs.writeFileSync(currentStopFile, 'stop', 'utf8'); } catch (err) { /* ignore */ }
    }
    try { runningProcess.kill(); } catch (err) { /* ignore */ }
    runningProcess = null;
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });