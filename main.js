const { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync } = require('child_process');
const { renderReportChart, postWebhookMultipart, sparkline } = require('./report');

const AHK_DOWNLOAD_URL = 'https://www.autohotkey.com/download/ahk-install.exe';
const AHK_WEBSITE_URL = 'https://www.autohotkey.com';

// Locate an AutoHotkey **v1.1** interpreter. The "U"/"A" exe variants
// (AutoHotkeyU64/U32/A32) are v1-only — v2 ships AutoHotkey64/32 without the
// letter — so finding one guarantees the correct version. Returns an absolute
// path, or null if no v1 interpreter can be found.
// Collect every plausible AutoHotkey install directory (registry-recorded +
// common defaults), de-duplicated. Shared by the v1 and v2 detectors.
function ahkCandidateDirs() {
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

  const seen = new Set();
  return candidateDirs.filter((d) => {
    if (!d) return false;
    const key = d.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findAhkV1() {
  // v1-only interpreter names, checked in both unified-installer (v1\) and
  // classic layouts, most-preferred first (64-bit unicode).
  const v1Exes = [
    'v1\\AutoHotkeyU64.exe', 'v1\\AutoHotkeyU32.exe', 'v1\\AutoHotkeyA32.exe',
    'AutoHotkeyU64.exe', 'AutoHotkeyU32.exe', 'AutoHotkeyA32.exe',
  ];

  const uniqueDirs = ahkCandidateDirs();

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

// Detect a v2-only interpreter (AutoHotkey64/32 — no U/A letter, so unambiguous
// v2). Used only to give a v2-only user a clearer message: v2 is a different,
// incompatible language and the macro is written for v1.1. Returns true/false.
function findAhkV2() {
  const v2Exes = [
    'v2\\AutoHotkey64.exe', 'v2\\AutoHotkey32.exe',
    'AutoHotkey64.exe', 'AutoHotkey32.exe',
  ];
  for (const dir of ahkCandidateDirs()) {
    for (const exe of v2Exes) {
      if (fs.existsSync(path.join(dir, exe))) return true;
    }
  }
  return false;
}

let statusWindow = null;
let runningProcess = null;
let currentStatusFile = null;
let currentStopFile = null;
let currentMacroRunningFile = null;
let currentStatsFile = null;
let pendingStatusMessages = [];
// Set on before-quit so shutdown paths skip chart rendering — spinning up a
// BrowserWindow while the app is tearing down is a good way to crash the exit.
let appIsQuitting = false;

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
  const iconPath = fs.existsSync(path.join(__dirname, 'Images', 'logo.png'))
    ? path.join(__dirname, 'Images', 'logo.png')
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

  const iconPath = fs.existsSync(path.join(__dirname, 'Images', 'logo.png'))
    ? path.join(__dirname, 'Images', 'logo.png')
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
// return null.
function resolveAhkOrPrompt(win) {
  const ahkPath = findAhkV1();
  if (ahkPath) return ahkPath;
  // v1 is missing. If the user has v2 installed, they likely think they're all
  // set — spell out that v2 is a different, incompatible version.
  const hasV2 = findAhkV2();
  const choice = dialog.showMessageBoxSync(win, {
    type: 'error',
    title: hasV2 ? 'Wrong AutoHotkey Version' : 'AutoHotkey 1.1 Required',
    message: hasV2
      ? 'You have AutoHotkey v2, but this macro needs v1.1.'
      : 'AutoHotkey v1.1 was not found on this PC.',
    detail: hasV2
      ? 'AutoHotkey v2 is a different, incompatible language — this macro is ' +
        'written for v1.1. Good news: v1.1 installs alongside v2, so you don\'t ' +
        'have to remove anything.\n\n' +
        'Click "Download AutoHotkey", choose the v1.1 option during setup, then ' +
        'try again.'
      : 'This macro needs AutoHotkey version 1.1 (not v2).\n\n' +
        'Click "Download AutoHotkey" to get the installer, run it, then try ' +
        'again. "Visit Website" opens autohotkey.com if you need the docs or ' +
        'a different version.',
    buttons: ['Download AutoHotkey', 'Visit Website', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (choice === 0) shell.openExternal(AHK_DOWNLOAD_URL);
  else if (choice === 1) shell.openExternal(AHK_WEBSITE_URL);
  return null;
}

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
  slowMode: false,            // low-end PCs: macro doubles its UI/load waits + load timeouts (arg 8)
  discordWebhookUrl: '',      // Discord webhook for run updates ('' = disabled)
  discordPingUserId: '',      // Discord user ID to @ping on critical alerts ('' = no ping)
  // Minutes between periodic session reports (0 = off). The report is a digest
  // with a rendered chart, so per-round messages default off in its favour.
  reportInterval: 30,
  // Per-event webhook toggles (Webhook settings modal). Key -> send that event.
  webhookEvents: {
    started: true,       // "Macro started"
    roundComplete: false, // per-round embed (coins/XP/mana) — the session report covers this
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
    // Session reports post on a timer and are gated only by their own interval,
    // not by webhookEvents. Defaulting that to 30 would silently start a new
    // notification stream for people who already tuned their webhook — some of
    // whom deliberately turned everything off. An existing settings file with
    // no reportInterval key predates the feature, so leave it off and let them
    // opt in from Settings; only fresh installs get the default cadence.
    if (!Object.prototype.hasOwnProperty.call(parsed, 'reportInterval')) {
      merged.reportInterval = 0;
    }
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
  coins: { x: 850,  y: 700, w: 268, h: 180 }, // coins number. Two hard-won constraints:
  // (1) right edge 1118 stops SHORT of the coin icon (digits end ~1115,
  //     right-aligned against it so longer numbers grow left) — any icon
  //     sliver OCRs as a trailing digit ("211" for 21 coins, live 1080p).
  //     Edge was 1127 (icon x~1133 on the 1080p-derived measurements) but a
  //     live 1440p round still caught a sliver ("330" for 33 coins) — the
  //     icon sits further left at real 1440p, so the edge hugs the digits;
  // (2) top edge 700 reaches up to the digit-free "Campaign Mode Rewards" label —
  //     Windows OCR flat-out refuses a short bare number alone in the box (a
  //     clean binarized "21" read "" at most scales!), but reads it reliably
  //     when the label fragment above anchors a text line ("Caml 21").
  // NOTE: losses DO reach this OCR — the macro's "Map completed" pixel is the
  // green difficulty label, which the Game Over dialog has too.
  // coins/exp are now FALLBACKS only (see readRewardStrip): since late 2026 an
  // event item (candy) sits between coins and XP and the exp box reads the
  // candy count ("6" for 5.4 XP). Only a labelled "N EXP" read is taken from it.
  exp:   { x: 1300, y: 750, w: 330, h: 130 },
  // PRIMARY source: the whole reward row, measured 2026-11-08 on a real 1080p
  // Game Over screenshot (new font + candy layout). y 770-870 holds ONLY the
  // reward numbers — the old 750-880 band caught the bottom of "You reached
  // Wave 25" above and "game lasted for" below, and OCR turned both into junk
  // digits. x 800-1800 spans 2- and 3-item rows plus the EXP label. The coin
  // icon is painted out before OCR (readRewardStrip), so this reads
  // "38 5.4 EXP" instead of "380 ...".
  rewards: { x: 800, y: 770, w: 1000, h: 100 },
  mana:  { x: 60,   y: 1300, w: 320, h: 130 }, // bottom-left live mana counter
  // Dialog title: "Game Over" (lost) vs "Game Complete" (won).
  title: { x: 900, y: 515, w: 760, h: 90 },
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
// savePng: optional path — ocr.ps1 also writes the raw capture there, so a
// misread round leaves the actual pixels behind for offline recalibration.
function ocrRegion(region, scale, savePng) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'ocr.ps1'),
      '-X', String(Math.round(region.x * scale)),
      '-Y', String(Math.round(region.y * scale)),
      '-W', String(Math.round(region.w * scale)),
      '-H', String(Math.round(region.h * scale)),
    ];
    if (savePng) args.push('-SavePng', savePng);
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

// OCR an image file (same engine/preprocessing as ocrRegion, no capture).
function ocrFile(file) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'ocr.ps1'), '-File', file,
      ], { windowsHide: true });
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out.trim()));
    } catch (err) {
      resolve('');
    }
  });
}

// Read the reward row from its raw capture with the coin icon painted out.
// The gold coin sits flush against the coins digits and OCR merges it in as
// a trailing digit ("380" for 38) — the old fixed-edge coins box chased that
// for months and broke again with every layout shift. Here we find the icon
// by COLOUR (gold, column-wise), black out those columns plus a margin for its
// white rim, and OCR the cleaned strip. Layout-independent: works wherever the
// icon lands, with or without the event candy. Verified on the real 1080p
// Game Over capture: raw "380 5.4 EXP" -> cleaned "38 5.4 EXP".
async function readRewardStrip(pngPath) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(pngPath);
    if (img.isEmpty()) return '';
    const { width: W, height: H } = img.getSize();
    const buf = img.toBitmap();  // BGRA
    const goldCols = [];
    for (let x = 0; x < W; x++) {
      let hits = 0;
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        const b = buf[i], g = buf[i + 1], r = buf[i + 2];
        if (r > 200 && g > 140 && g < 215 && b < 90) hits++;
      }
      if (hits >= 2) goldCols.push(x);
    }
    if (goldCols.length) {
      const a = goldCols[0];
      const z = goldCols[goldCols.length - 1];
      const pad = Math.max(3, Math.round((z - a) * 0.15));
      for (let x = Math.max(0, a - pad); x <= Math.min(W - 1, z + pad); x++) {
        for (let y = 0; y < H; y++) {
          const i = (y * W + x) * 4;
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0;
        }
      }
    }
    const cleanPath = pngPath.replace(/\.png$/i, '-clean.png');
    fs.writeFileSync(cleanPath, nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG());
    return await ocrFile(cleanPath);
  } catch (err) {
    return '';
  }
}

// Parse the cleaned reward row: "38 5.4 EXP" (or "38 6 5.4 EXP" if the candy
// count survives). XP = the number before the EXP label, else the LAST
// number; coins = the FIRST number, as long as it isn't the XP itself.
function parseRewardStrip(text) {
  const t = text || '';
  const nums = (t.match(/\d+(?:[.,]\d+)?/g) || []).map((s) => parseFloat(s.replace(',', '.')));
  const labeled = t.match(/(\d+(?:[.,]\d+)?)\s*(?:E\s*X\s*P|EXP|XP)/i);
  let xp = labeled ? parseFloat(labeled[1].replace(',', '.')) : null;
  if (xp === null && nums.length >= 2) xp = nums[nums.length - 1];
  let coins = null;
  if (nums.length >= 2 || (nums.length === 1 && xp === null)) coins = Math.round(nums[0]);
  if (!Number.isFinite(coins)) coins = null;
  if (!Number.isFinite(xp)) xp = null;
  return { coins, xp };
}

// Round outcome from the dialog title: 'lost' (Game Over / You have died),
// 'won' (Game Complete), or null if OCR couldn't tell.
function parseRoundOutcome(text) {
  if (/over|died/i.test(text || '')) return 'lost';
  if (/compl|victory|win/i.test(text || '')) return 'won';
  return null;
}

// Pull the first number out of OCR text. Keeps decimals ("9.2" XP) and strips
// thousands separators ("1,250" -> 1250). Returns null if nothing numeric.
function parseOcrNumber(text) {
  const m = (text || '').match(/\d[\d.,]*/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Coins-specific parse. A round's coin reward realistically never reaches 100
// (it's a two-digit number), but at higher resolutions the coin icon sits flush
// against the digits and OCR nondeterministically merges it as a trailing digit
// ("330" for 33, "211" for 21). So if we ever read 3+ digits, drop the extras
// and keep the first two — the real value.
function parseOcrCoins(text) {
  const m = (text || '').match(/\d[\d.,]*/);
  if (!m) return null;
  let digits = m[0].replace(/[.,]/g, '');
  if (digits.length > 2) digits = digits.slice(0, 2);
  const n = parseInt(digits, 10);
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

// ---- Public maps-completed counter -----------------------------------------
// Fire-and-forget GET that bumps the counter shown on towerheroesmacro.site.
// Sends nothing but the hit itself (no user data). Failures are logged and
// swallowed — a down counter must never affect a run.
const MAP_COUNTER_URL = 'https://countapi.mileshilliard.com/api/v1/hit/velora_tower_heroes_maps_xan3vo';
function hitMapCounter() {
  try {
    const https = require('https');
    const req = https.get(MAP_COUNTER_URL, (res) => {
      res.resume();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.error('Map counter hit failed: HTTP', res.statusCode);
      }
    });
    req.on('error', (err) => console.error('Map counter hit failed:', err.message));
    req.setTimeout(8000, () => { req.destroy(); });
  } catch (err) {
    console.error('Map counter hit failed:', err.message);
  }
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

// Allowed periodic-report intervals, in minutes (0 = off). The renderer's
// dropdown mirrors this list; anything else falls back to the default.
const REPORT_INTERVALS = [0, 15, 30, 60];
const CHART_FILENAME = 'velora-report.png';

// Embed number formatting: thousands separators, at most one decimal (XP is
// fractional), and an em dash for "no reading" (OCR missed / not sampled yet).
function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// "3 restarts" / "1 restart".
function plural(n, word) {
  return `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
}

// Monospace label/value block for an embed field, labels padded so the
// values line up across rows.
function statBlock(rows) {
  return '```\n' + rows.map(([k, v]) => `${k.padEnd(7)}${v}`).join('\n') + '\n```';
}

// The session-report embed, shared by the scheduled report and the Settings
// "Preview" button so the two can never drift apart. `last`/`session`/`pace`
// are {rounds, coins, xp}; pace is per hour.
function buildReportEmbed({ title, map, difficulty, elapsedSec, windowLabel, last, session, pace, mana, restarts, footer }) {
  const stuck = last.rounds === 0;
  const lines = [`**${map}** · ${difficulty} · running for ${formatDuration(elapsedSec)}`];
  if (stuck) lines.push(`No rounds finished in the ${windowLabel.toLowerCase()}. The macro may be stuck.`);
  else if (last.lost) lines.push(`${plural(last.lost, 'round')} lost in the ${windowLabel.toLowerCase()}.`);
  return makeEmbed({
    title,
    color: stuck ? 'warn' : 'info',
    description: lines.join('\n'),
    fields: [
      { name: windowLabel, inline: true, value: statBlock([
        ['Rounds', fmtNum(last.rounds)], ['Coins', fmtNum(last.coins)], ['XP', fmtNum(last.xp)]]) },
      { name: 'Session', inline: true, value: statBlock([
        ['Rounds', fmtNum(session.rounds)], ['Coins', fmtNum(session.coins)], ['XP', fmtNum(session.xp)]]) },
      { name: 'Pace', inline: true, value: statBlock([
        ['Rounds', `${fmtNum(pace.rounds)}/hr`], ['Coins', `${fmtNum(pace.coins)}/hr`], ['XP', `${fmtNum(pace.xp)}/hr`]]) },
      { name: 'Mana', value: fmtNum(mana), inline: true },
      { name: 'Restarts', value: fmtNum(restarts), inline: true },
    ],
    footer,
  });
}

// Minutes the user picked for session reports, or 0 when they're off.
function reportIntervalMinutes(settings) {
  const raw = parseInt((settings || loadSettings()).reportInterval, 10);
  return REPORT_INTERVALS.indexOf(raw) >= 0 ? raw : SETTINGS_DEFAULTS.reportInterval;
}

// "1h 12m" / "8m 30s" — used in report embeds and chart captions.
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// Post an embed with the session chart attached. Chart rendering is allowed to
// fail (headless VM, shutdown) — the message still goes out, with a unicode
// sparkline standing in for the graph. `eventKey` gates it like any other
// message; pass null for reports, which are gated by the interval setting.
function postDiscordWebhookWithChart(payload, eventKey, chartData) {
  const settings = loadSettings();
  const url = (settings.discordWebhookUrl || '').trim();
  if (!url.startsWith('https://')) return Promise.resolve();
  if (eventKey && settings.webhookEvents && settings.webhookEvents[eventKey] === false) {
    return Promise.resolve();
  }
  const canRender = !appIsQuitting && (chartData.points || []).length >= 2;
  const chart = canRender ? renderReportChart(chartData) : Promise.resolve(null);
  return chart.then((buf) => {
    const embed = payload.embeds[0];
    if (buf) {
      embed.image = { url: `attachment://${CHART_FILENAME}` };
      return postWebhookMultipart(url, payload, { filename: CHART_FILENAME, buffer: buf });
    }
    if (chartData.sparkline) {
      embed.description = `${embed.description || ''}\n\`\`\`\n${chartData.sparkline}\n\`\`\``;
    }
    return postWebhookOnce(url, payload);
  }).then((r) => {
    if (r && !r.ok) console.error('Report post failed:', r.error || `HTTP ${r.status}`);
  }).catch((err) => console.error('Report post failed:', err.message));
}

// "<@id> " mention prefix for critical alerts (restart-loop guard, errors),
// or '' when no ping user ID is configured. Digits-only sanitize so a pasted
// "@name" or "<@123>" still works.
function discordPing() {
  const id = (loadSettings().discordPingUserId || '').replace(/\D/g, '');
  return id ? `<@${id}> ` : '';
}

// Every webhook message posts as "Velora" with our logo, overriding whatever
// name/avatar the user gave the webhook in Discord. The avatar is the logo in
// the public repo, served raw so Discord can fetch it.
const WEBHOOK_NAME = 'Velora';
const WEBHOOK_AVATAR = 'https://raw.githubusercontent.com/Xan3vo/Velora-Tower-Heroes-Macro/main/Images/logo.png';

// Build a one-embed payload. Every webhook message is an embed for a uniform
// look; `ping` (a "<@id> " prefix or '') goes in `content` because mentions
// inside embeds render but never actually notify the user. House style: plain
// sentence-case titles with no emoji (the colour stripe carries the kind),
// "**Map** · Difficulty" as the context line, numbers through fmtNum, and a
// footer that always ends in the app version, plus a timestamp.
const EMBED_COLORS = {
  info: 0x2563eb,     // blue  — rounds, placements
  success: 0x22c55e,  // green — started, test, upgrades/maxed
  warn: 0xf59e0b,     // amber — restarts
  error: 0xef4444,    // red   — errors, loop guard
  neutral: 0x64748b,  // grey  — stopped
};
function makeEmbed({ title, description, color, fields, footer, ping }) {
  const embed = {
    title,
    color: EMBED_COLORS[color] || EMBED_COLORS.info,
    timestamp: new Date().toISOString(),
  };
  if (description) embed.description = description;
  if (fields) embed.fields = fields;
  const version = `Velora v${app.getVersion()}`;
  embed.footer = { text: footer ? `${footer} · ${version}` : version };
  const payload = { username: WEBHOOK_NAME, avatar_url: WEBHOOK_AVATAR, embeds: [embed] };
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
    title: 'Webhook connected',
    description: 'Velora will post updates here while the macro runs.',
    color: 'success',
  }));
});

// "Preview report" button: posts a session report built from sample data, so
// the user can see the real embed and chart without sitting through an actual
// interval. Uses the URL currently in the input, saved or not.
ipcMain.handle('test-report', async (e, url) => {
  const target = (url || '').trim();
  if (!target.startsWith('https://')) {
    return { ok: false, error: 'URL must start with https://' };
  }
  // A plausible half-hour: a round lands every ~6 minutes.
  const points = [];
  let coins = 0;
  let xp = 0;
  let rounds = 0;
  for (let m = 0; m <= 30; m++) {
    if (m > 0 && m % 6 === 0) {
      rounds += 1;
      coins += 26 + (m % 3) * 5;
      xp = Math.round((xp + 9.3) * 10) / 10;
    }
    points.push({ t: m * 60, coins, xp, rounds });
  }
  const totals = { rounds, coins, xp };
  const payload = buildReportEmbed({
    title: 'Session report (preview)',
    map: 'Castle Town',
    difficulty: 'Easy',
    elapsedSec: 30 * 60,
    windowLabel: 'Last 30m',
    last: totals,
    session: totals,
    pace: { rounds: rounds * 2, coins: coins * 2, xp: Math.round(xp * 2) },
    mana: 14674,
    restarts: 0,
    footer: 'Sample data',
  });

  const buf = await renderReportChart({
    points,
    subtitle: 'Castle Town · Easy',
    stamp: `30m · ${rounds} rounds`,
  });
  if (buf) {
    payload.embeds[0].image = { url: `attachment://${CHART_FILENAME}` };
    return postWebhookMultipart(target, payload, { filename: CHART_FILENAME, buffer: buf });
  }
  payload.embeds[0].description += `\n\`\`\`\n${sparkline(points.map((p) => p.coins), 28)}\n\`\`\``;
  return postWebhookOnce(target, payload);
});

// Supported physical resolutions (macro coords are calibrated to these).
const SUPPORTED_RESOLUTIONS = [
  [2560, 1440],
  [1920, 1080],
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
        '   - 2560 x 1440\n   - 1920 x 1080\n\n' +
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
  let sessionLosses = 0;    // rounds that ended on the Game Over dialog
  let sessionXP = 0;
  let sessionMana = null;   // latest live-mana read (null until first success)
  // Live-mana OCR only makes sense inside a match — the mana counter isn't on
  // screen in the lobby/loading, so reading it there just yields junk. Gate the
  // poll on this: flipped true when the macro reports it's in the match
  // ("Map loaded" / "Gathering Mana"), false once the round ends.
  let inMatch = false;

  // ---- Periodic session report ----------------------------------------------
  // A digest every N minutes (settings.reportInterval) in place of a live feed
  // of per-round messages: what moved since the last report, session totals,
  // pace, and a rendered chart of the run so far.
  const reportMinutes = reportIntervalMinutes(loadSettings());
  const REPORT_POINT_CAP = 1500;  // ~25h of one-a-minute samples
  const reportPoints = [];        // cumulative {t, coins, xp, rounds} samples
  let reportSeq = 0;
  let lastReport = { t: 0, rounds: 0, coins: 0, xp: 0, lost: 0 };

  const sampleReportPoint = () => {
    if (!reportMinutes) return;
    reportPoints.push({
      t: Math.floor((Date.now() - runStartTime) / 1000),
      coins: sessionCoins,
      xp: sessionXP,
      rounds: statsRounds,
    });
    if (reportPoints.length > REPORT_POINT_CAP) reportPoints.shift();
  };

  // Chart payload — shared by the periodic report and the closing summary.
  const buildReportChartData = (elapsedSec) => ({
    points: reportPoints.slice(),
    subtitle: `${map} · ${difficulty}`,
    stamp: `${formatDuration(elapsedSec)} · ${statsRounds} rounds`,
    sparkline: sparkline(reportPoints.map((p) => p.coins), 28),
  });

  const sendSessionReport = () => {
    const elapsed = Math.floor((Date.now() - runStartTime) / 1000);
    sampleReportPoint();
    reportSeq += 1;

    const dRounds = statsRounds - lastReport.rounds;
    const dCoins = sessionCoins - lastReport.coins;
    const dXP = Math.round((sessionXP - lastReport.xp) * 10) / 10;
    // Floor the window at a minute so the first report can't divide by ~0 and
    // report an absurd hourly pace.
    const windowSec = Math.max(60, elapsed - lastReport.t);
    const perHour = (v) => Math.round((v / windowSec) * 3600);

    postDiscordWebhookWithChart(buildReportEmbed({
      title: 'Session report',
      map,
      difficulty,
      elapsedSec: elapsed,
      windowLabel: `Last ${reportMinutes}m`,
      last: { rounds: dRounds, coins: dCoins, xp: dXP, lost: sessionLosses - lastReport.lost },
      session: { rounds: statsRounds, coins: sessionCoins, xp: sessionXP, lost: sessionLosses },
      pace: { rounds: perHour(dRounds), coins: perHour(dCoins), xp: perHour(dXP) },
      mana: sessionMana,
      restarts: statsRestarts,
      footer: `Report #${reportSeq}`,
    }), null, buildReportChartData(elapsed));

    lastReport = { t: elapsed, rounds: statsRounds, coins: sessionCoins, xp: sessionXP, lost: sessionLosses };
  };

  const sendRoundWebhook = (roundCoins, roundXP, outcome) => {
    const sec = Math.floor((Date.now() - runStartTime) / 1000);
    const lost = outcome === 'lost';
    postDiscordWebhook(makeEmbed({
      title: lost ? `Round ${statsRounds} lost` : `Round ${statsRounds} complete`,
      color: lost ? 'warn' : 'info',
      description: `**${map}** · ${difficulty}`
        + (lost ? '\nThe base fell before the last wave. Rewards were still collected.' : ''),
      fields: [
        { name: 'Coins', value: roundCoins === null ? '—' : `+${fmtNum(roundCoins)}`, inline: true },
        { name: 'XP', value: roundXP === null ? '—' : `+${fmtNum(roundXP)}`, inline: true },
        { name: 'Mana', value: fmtNum(sessionMana), inline: true },
        { name: 'Session coins', value: fmtNum(sessionCoins), inline: true },
        { name: 'Session XP', value: fmtNum(sessionXP), inline: true },
        { name: 'Running for', value: formatDuration(sec), inline: true },
      ],
      footer: statsRestarts ? `${plural(statsRestarts, 'restart')} this session` : null,
    }), 'roundComplete');
  };

  // Status-driven webhook events (placement / upgrade / restart messages).
  // Statuses come from the macro's status file; each pattern maps a family of
  // status texts to a per-event toggle in Webhook settings.
  // Raw macro statuses ("Play button timeout, full restart") are terse log
  // lines; each match below rewrites one into a readable title + sentence.
  // NOTE: deliberately not matching the per-tick "Upgrading X (12s)" ticker —
  // it changes every few seconds and would flood the channel / rate limit.
  const RESTART_SUFFIX = /[\s,—\-�]*(?:full restart|restarting)$/;
  const RESTART_REASONS = {
    'Play button timeout': 'The Play button never appeared.',
    'Ready button timeout': 'The Ready button never appeared.',
    'Hero placement failed': "Couldn't place every hero after 10 tries.",
    "Deep link didn't join": 'Roblox opened but never joined the server. Trying the deep link once more.',
    "Deep link didn't join twice": 'The deep link failed twice, so Velora is switching to the browser launch.',
  };
  const sendStatusWebhook = (statusText) => {
    let m;
    let eventKey = null;
    let embed = null;
    if ((m = statusText.match(/^(.+) placed successfully$/))) {
      eventKey = 'placements';
      embed = { title: `${m[1]} placed`, color: 'info' };
    } else if (/^(Both|All) heroes placed$/.test(statusText)) {
      eventKey = 'placements';
      embed = { title: 'All heroes placed', color: 'info', description: 'Moving on to upgrades.' };
    } else if ((m = statusText.match(/^(.+) maxed \((\d+)s\)$/))) {
      eventKey = 'upgrades';
      embed = { title: `${m[1]} maxed`, color: 'success',
        description: `Fully upgraded in ${formatDuration(Number(m[2]))}.` };
    } else if ((m = statusText.match(/^(.+) upgrade cap reached \((\d+)s\)$/))) {
      eventKey = 'upgrades';
      embed = { title: `${m[1]} hit the upgrade time limit`, color: 'warn',
        description: `Stopped upgrading after ${formatDuration(Number(m[2]))}. It may not be fully maxed.` };
    } else if (RESTART_SUFFIX.test(statusText)) {
      // The status says WHY (which timeout / crash); the fields add where the
      // run was when it happened.
      const raw = statusText.replace(RESTART_SUFFIX, '').trim();
      const reason = RESTART_REASONS[raw] || `${raw.charAt(0).toUpperCase()}${raw.slice(1)}.`;
      const sec = Math.floor((Date.now() - runStartTime) / 1000);
      eventKey = 'restarts';
      embed = { title: 'Restarting Roblox', color: 'warn', description: reason,
        fields: [
          { name: 'Rounds done', value: fmtNum(statsRounds), inline: true },
          { name: 'Running for', value: formatDuration(sec), inline: true },
          { name: 'Earlier restarts', value: fmtNum(statsRestarts), inline: true },
        ] };
    }
    if (eventKey) postDiscordWebhook(makeEmbed(embed), eventKey);
  };

  const captureRewardsOnce = () => {
    const R = getOcrRegions();
    // Keep the raw round captures (overwritten each round) so a misread can be
    // recalibrated offline from the real pixels — see userData\ocr-captures.
    const capDir = path.join(app.getPath('userData'), 'ocr-captures');
    try { fs.mkdirSync(capDir, { recursive: true }); } catch (err) { /* capture is best-effort */ }
    const stripPng = path.join(capDir, 'rewards-last.png');
    return Promise.all([
      ocrRegion(R.coins, ocrScale, path.join(capDir, 'coins-last.png')),
      ocrRegion(R.exp, ocrScale, path.join(capDir, 'exp-last.png')),
      // The strip's own OCR text is unused — what matters is the saved PNG,
      // re-read with the coin icon painted out.
      ocrRegion(R.rewards, ocrScale, stripPng).then(() => readRewardStrip(stripPng)),
      ocrRegion(R.mana, ocrScale),
      ocrRegion(R.title, ocrScale),
    ]);
  };
  // The cleaned strip is the primary source for both values. Fallbacks only
  // when it misses one: the coins box (parseOcrCoins trims an icon-merged
  // third digit) and the exp box ONLY when it read a labelled "N EXP" — its
  // bare first number is the event candy count now, not XP.
  const parseRewards = (coinsText, expText, stripText) => {
    let { coins, xp } = parseRewardStrip(stripText);
    if (coins === null) coins = parseOcrCoins(coinsText);
    if (xp === null) {
      const labeled = (expText || '').match(/(\d[\d.,]*)\s*(?:E\s*X\s*P|EXP|XP)/i);
      if (labeled) {
        const n = parseFloat(labeled[1].replace(/,/g, ''));
        if (Number.isFinite(n)) xp = n;
      }
    }
    return { coins, xp };
  };
  const captureRoundRewards = () => {
    const finish = (coins, xp, mana, outcome) => {
      if (coins !== null) sessionCoins += coins;
      if (xp !== null) sessionXP = Math.round((sessionXP + xp) * 10) / 10;
      if (mana !== null) sessionMana = mana;
      if (outcome === 'lost') sessionLosses += 1;
      // Pin a chart sample to the round itself, so the step up lands on the
      // real completion time rather than the next minute tick.
      sampleReportPoint();
      sendRoundWebhook(coins, xp, outcome);
    };
    captureRewardsOnce().then(([coinsText, expText, stripText, manaText, titleText]) => {
      const outcome = parseRoundOutcome(titleText);
      ocrDebugLog(`round try1: title="${titleText}" (${outcome || '?'}) strip="${stripText}" coins="${coinsText}" exp="${expText}" mana="${manaText}"`);
      const { coins, xp } = parseRewards(coinsText, expText, stripText);
      if (coins === null || xp === null) {
        // Something's still missing — dialog may still be animating in. One
        // more pass inside the macro's 5s hold, keeping whatever try1 got.
        // Short delay: try1 alone takes ~2-3s (capture + cleaned-strip OCR).
        setTimeout(() => {
          captureRewardsOnce().then(([c2, x2, r2, m2, t2]) => {
            ocrDebugLog(`round try2: title="${t2}" strip="${r2}" coins="${c2}" exp="${x2}" mana="${m2}"`);
            const second = parseRewards(c2, x2, r2);
            finish(coins !== null ? coins : second.coins,
                   xp !== null ? xp : second.xp,
                   parseOcrNumber(m2),
                   outcome || parseRoundOutcome(t2));
          });
        }, 300);
      } else {
        finish(coins, xp, parseOcrNumber(manaText), outcome);
      }
    });
  };

  // Live mana for the overlay + webhook: light OCR poll while the macro runs.
  const manaPoll = setInterval(() => {
    if (!inMatch) return; // don't OCR the mana region until we're in a match
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
        // Gate live-mana OCR to when we're actually in the match: on once the
        // map loads / mana-gather begins, off once the round ends (the counter
        // leaves the screen in the lobby, so reading it there is just noise).
        if (statusText === 'Map loaded' || statusText === 'Gathering Mana') inMatch = true;
        else if (statusText === 'Map completed') inMatch = false;
        // Edge-trigger on the transition into "Map completed": the macro holds
        // the results dialog open ~4s, during which we OCR the rewards.
        if (statusText === 'Map completed') {
          captureRoundRewards();
          hitMapCounter();
        }
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
      title: 'Macro stopped: stuck restarting',
      description: `Roblox was restarted ${streak} times in a row without finishing a round, `
        + 'so Velora stopped the macro. Check that the game still loads and reaches the lobby.',
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
  // Sample once a minute regardless of round pace — a flat line between round
  // markers is exactly how a stuck macro shows up on the chart.
  const reportSamplePoll = reportMinutes ? setInterval(sampleReportPoint, 60000) : null;
  const reportTimer = reportMinutes ? setInterval(sendSessionReport, reportMinutes * 60000) : null;
  sampleReportPoint();
  readStatusFile();
  readStatsFile();
  console.log('Status polling started for:', statusFile);

  // Arg 6: "1" = close the leftover roblox.com browser tab after launch.
  // Arg 7: launch method — 'auto' (deep link + browser fallback) or 'browser'.
  // Arg 8: wait multiplier — "2" = slow mode (low-end PCs), "1" = normal.
  const launchSettings = loadSettings();
  const closeTabFlag = launchSettings.closeBrowserTab ? '1' : '0';
  const launchMethod = launchSettings.launchMethod === 'browser' ? 'browser' : 'auto';
  const slowFlag = launchSettings.slowMode ? '2' : '1';
  const args = [scriptPath, action, map, difficulty, resParam, statusFile, closeTabFlag, launchMethod, slowFlag];
  console.log('Spawning AHK with args:', JSON.stringify(args));
  console.log('Total args count:', args.length);
  
  runningProcess = spawn(ahkPath, args);

  console.log('AHK process spawned, PID:', runningProcess.pid);
  const startMins = reportIntervalMinutes(launchSettings);
  postDiscordWebhook(makeEmbed({
    title: 'Macro started',
    description: `**${map}** · ${difficulty}`
      + (startMins ? `\nSession reports every ${startMins} minutes.` : ''),
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
    clearInterval(reportSamplePoll);
    clearInterval(reportTimer);
    runningProcess = null;
    currentStatusFile = null;
    currentStopFile = null;
    currentMacroRunningFile = null;
    currentStatsFile = null;
    try { fs.unlinkSync(statsFile); } catch (err) { /* ignore */ }
    console.error(`Error running AHK script: ${error.message}`);
    postDiscordWebhook(makeEmbed({
      title: 'Macro failed to start',
      description: `\`\`\`\n${error.message}\n\`\`\``,
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
    clearInterval(reportSamplePoll);
    clearInterval(reportTimer);
    const stopSec = Math.floor((Date.now() - runStartTime) / 1000);
    const lifetime = addLifetimeStats({
      rounds: statsRounds, coins: sessionCoins, xp: sessionXP, timeSec: stopSec,
    });
    const stoppedEmbed = makeEmbed({
      title: 'Macro stopped',
      description: `**${map}** · ${difficulty} · ran for ${formatDuration(stopSec)}`,
      color: 'neutral',
      fields: [
        { name: 'Rounds', value: fmtNum(statsRounds) + (sessionLosses ? ` (${fmtNum(sessionLosses)} lost)` : ''), inline: true },
        { name: 'Coins', value: fmtNum(sessionCoins), inline: true },
        { name: 'XP', value: fmtNum(sessionXP), inline: true },
        { name: 'All time', value: `${plural(lifetime.rounds, 'round')} · ${fmtNum(lifetime.coins)} coins`
          + ` · ${fmtNum(lifetime.xp)} XP · ${plural(lifetime.sessions, 'session')}` },
      ],
      footer: statsRestarts ? `${plural(statsRestarts, 'restart')} this session` : null,
    });
    // With reports enabled the stop message doubles as the final report — same
    // embed, plus the chart for the whole session.
    if (reportMinutes) {
      sampleReportPoint();
      postDiscordWebhookWithChart(stoppedEmbed, 'stopped', buildReportChartData(stopSec));
    } else {
      postDiscordWebhook(stoppedEmbed, 'stopped');
    }
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
        title: 'Macro error',
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
// clicks "Update now" in the renderer's toast (autoDownload=false). Accepting
// hands over to the renderer's full-screen update screen, which downloads and
// then installs SILENTLY and relaunches — no NSIS wizard (see install-update).
// quitAndInstall fires before-quit, so a running macro is stopped first; if the
// user picks "later", it still installs silently on the next normal quit.
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
  // isSilent=true runs the NSIS installer with /S — no setup wizard, the user
  // just sees our own update screen until the app relaunches itself
  // (isForceRunAfter=true). Silent is only safe because nsis.perMachine is
  // false: Velora installs under %LOCALAPPDATA%, so there's no UAC prompt to
  // answer. Turning on perMachine would need this back to false, or the
  // install would stall behind an elevation dialog with no window to click.
  autoUpdater.quitAndInstall(true, true);
  return true;
});
ipcMain.handle('get-app-version', () => app.getVersion());

// ---- Update notes -------------------------------------------------------
// changelog.json ships with the app (newest first). On launch the renderer
// asks for it; `unseen` is every entry newer than the last version this
// install has shown notes for, capped at the running version. The "seen"
// marker (settings.lastSeenVersion) is written right here, so the popup shows
// once per update even if the user closes the app without dismissing it.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
ipcMain.handle('get-whats-new', () => {
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'));
  } catch (err) {
    return { current: app.getVersion(), entries: [], unseen: [] };
  }
  const current = app.getVersion();
  // Read the raw file, not loadSettings(): defaults would hide whether the
  // key exists. No settings file at all = fresh install → nothing is "new".
  // A settings file WITHOUT the key = updated from a version that predates
  // update notes → show this version's notes only, not the whole history.
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (err) { /* fresh install */ }
  let unseen = [];
  if (raw && raw.lastSeenVersion) {
    unseen = entries.filter((e) => compareVersions(e.version, raw.lastSeenVersion) > 0
      && compareVersions(e.version, current) <= 0);
  } else if (raw) {
    unseen = entries.filter((e) => compareVersions(e.version, current) === 0);
  }
  if (!raw || raw.lastSeenVersion !== current) saveSettings({ lastSeenVersion: current });
  return { current, entries: entries.filter((e) => compareVersions(e.version, current) <= 0), unseen };
});

// Open one of a fixed set of project links in the user's browser. Keyed rather
// than URL-passing so the renderer can never hand shell.openExternal an
// arbitrary target.
const EXTERNAL_LINKS = {
  website: 'https://towerheroesmacro.site',
  github: 'https://github.com/Xan3vo/Velora-Tower-Heroes-Macro',
};
ipcMain.on('open-link', (event, key) => {
  const url = EXTERNAL_LINKS[key];
  if (url) shell.openExternal(url);
});

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

// Closing the app must take the macro down with it — an orphaned AHK process
// keeps clicking the screen with no way to stop it except Task Manager (and a
// later relaunch would run two macros at once, fighting over the mouse).
app.on('before-quit', () => {
  appIsQuitting = true;
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