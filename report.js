// report.js — periodic Discord "session report": the branded chart image and
// the multipart upload that carries it.
//
// Why a rendered PNG instead of a chart service: Discord embeds only display
// raster images, and shipping the data to a third-party chart API would leak
// a user's farm stats off their machine. Electron already has a renderer, so
// we draw the chart offscreen and upload the bytes with the webhook POST.
// Every entry point here fails soft — a report is cosmetic and must never
// affect a run.

const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Chart geometry. All drawing code works in CHART_W x CHART_H logical units;
// the two scale factors below only decide how many real pixels come out.
//   OUT_SCALE   — offscreen window size, so the PNG itself is bigger.
//   SUPERSAMPLE — canvas backing store multiplier. Without it the compositor
//                 scales a 960x400 bitmap UP to the window size and everything
//                 goes soft; drawing into a larger buffer and letting the
//                 capture downsample is what keeps text and hairlines crisp.
const CHART_W = 960;
const CHART_H = 400;
const OUT_SCALE = 1.5;
const SUPERSAMPLE = 2;
const WIN_W = Math.round(CHART_W * OUT_SCALE);
const WIN_H = Math.round(CHART_H * OUT_SCALE);
const DRAW_SCALE = OUT_SCALE * SUPERSAMPLE;
const READY_TITLE = 'velora-chart-ready';

// Velora palette — mirrors the app UI (index.html) so a report posted in
// Discord reads as the same product.
const BRAND = {
  bg0: '#0e111a',
  bg1: '#161b28',
  grid: '#1e2434',
  text: '#e8eaf0',
  dim: '#7b849c',
  coins: '#3670f2',
  xp: '#e5b076',
  marker: '#9dc0ff',
};

// The logo is embedded in the chart HTML as a data URI — the offscreen page is
// loaded from temp, so a relative file path wouldn't resolve. Read once.
let logoCache;
function logoDataUri() {
  if (logoCache !== undefined) return logoCache;
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'Images', 'logo.png'));
    logoCache = 'data:image/png;base64,' + buf.toString('base64');
  } catch (err) {
    logoCache = null;
  }
  return logoCache;
}

// Unicode bar sparkline — the fallback when chart rendering is unavailable
// (GPU-less VM, offscreen render failure). Renders fine on Discord mobile.
const SPARK_CHARS = '▁▂▃▄▅▆▇█';
function sparkline(values, width) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return '';
  const cols = Math.max(2, Math.min(width || 24, vals.length));
  // Bucket down to `cols` columns so a 3-hour session still fits one line.
  const picked = [];
  for (let i = 0; i < cols; i++) {
    picked.push(vals[Math.round((i * (vals.length - 1)) / (cols - 1))]);
  }
  const lo = Math.min(...picked);
  const hi = Math.max(...picked);
  const span = hi - lo;
  return picked.map((v) => {
    const idx = span === 0 ? 0 : Math.round(((v - lo) / span) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[idx];
  }).join('');
}

// Self-contained chart page. Everything (data, logo, styles) is inlined so the
// offscreen window needs no network and no preload script. All drawing runs
// inside draw() — the logo decodes asynchronously even as a data URI, so the
// page must not paint a half-finished chart before it lands.
function chartHtml(data) {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: ${BRAND.bg0}; }
  canvas { display: block; width: ${WIN_W}px; height: ${WIN_H}px; }
</style>
<canvas id="c" width="${Math.round(CHART_W * DRAW_SCALE)}" height="${Math.round(CHART_H * DRAW_SCALE)}"></canvas>
<script>
var DATA = ${JSON.stringify(data)};
var LOGO = ${JSON.stringify(logoDataUri())};
var B = ${JSON.stringify(BRAND)};
var W = ${CHART_W}, H = ${CHART_H};
var FONT = '"Segoe UI", system-ui, sans-serif';

function draw(logoImg) {
  var ctx = document.getElementById('c').getContext('2d');
  // Everything below is authored in logical units; this maps them onto the
  // oversized backing store.
  ctx.scale(${DRAW_SCALE}, ${DRAW_SCALE});
  var PAD = { l: 66, r: 66, t: 74, b: 50 };
  var plotW = W - PAD.l - PAD.r;
  var plotH = H - PAD.t - PAD.b;

  function fmt(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(Math.round(n * 10) / 10);
  }

  // --- background ---------------------------------------------------------
  var bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, B.bg1);
  bg.addColorStop(1, B.bg0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  var pts = DATA.points || [];
  var t0 = pts.length ? pts[0].t : 0;
  var t1 = pts.length ? pts[pts.length - 1].t : 1;
  if (t1 <= t0) t1 = t0 + 1;
  // Second series is coins/hr over a trailing window, not cumulative XP:
  // cumulative XP rises in lockstep with cumulative coins, so plotting it
  // just traces the same curve twice. Pace shows the thing the numbers in
  // the embed can't — whether the run is still earning at its earlier rate.
  var PACE_WINDOW = 600;
  var pace = [];
  for (var p = 0; p < pts.length; p++) {
    var j = p;
    while (j > 0 && pts[p].t - pts[j].t < PACE_WINDOW) j--;
    var dt = pts[p].t - pts[j].t;
    pace.push(dt > 0 ? ((pts[p].coins - pts[j].coins) / dt) * 3600 : 0);
  }

  // Round the axes up to a readable maximum, so gridline labels land on 60 /
  // 120 / 180 instead of 54.9 / 109.7 / 164.6.
  var LADDER = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  function niceStep(x) {
    var mag = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
    var n = x / mag;
    for (var q = 0; q < LADDER.length; q++) {
      if (n <= LADDER[q] + 1e-9) return LADDER[q] * mag;
    }
    return 10 * mag;
  }
  function axisMax(v) {
    if (!(v > 0)) return 4;
    var step = niceStep((v * 1.12) / 4);
    var max = step * 4;
    return max < v ? Math.ceil(v / step) * step : max;
  }
  var rawCoins = 0, rawPace = 0;
  for (var i = 0; i < pts.length; i++) {
    if (pts[i].coins > rawCoins) rawCoins = pts[i].coins;
    if (pace[i] > rawPace) rawPace = pace[i];
  }
  var coinsMax = axisMax(rawCoins);
  var paceMax = axisMax(rawPace);

  function sx(t) { return PAD.l + ((t - t0) / (t1 - t0)) * plotW; }
  function syCoins(v) { return PAD.t + plotH - (v / coinsMax) * plotH; }
  function syPace(v) { return PAD.t + plotH - (v / paceMax) * plotH; }

  // --- grid + value axes --------------------------------------------------
  ctx.font = '11px ' + FONT;
  ctx.textBaseline = 'middle';
  for (var g = 0; g <= 4; g++) {
    var y = PAD.t + (plotH * g) / 4;
    ctx.strokeStyle = B.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, y + 0.5);
    ctx.lineTo(PAD.l + plotW, y + 0.5);
    ctx.stroke();

    var frac = 1 - g / 4;
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'right';
    ctx.fillStyle = B.coins;
    ctx.fillText(fmt(coinsMax * frac), PAD.l - 10, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = B.xp;
    ctx.fillText(fmt(paceMax * frac), PAD.l + plotW + 10, y);
    ctx.globalAlpha = 1;
  }

  // Time axis.
  ctx.textAlign = 'center';
  ctx.fillStyle = B.dim;
  for (var k = 0; k <= 4; k++) {
    var tv = t0 + ((t1 - t0) * k) / 4;
    ctx.fillText(Math.round(tv / 60) + 'm', sx(tv), PAD.t + plotH + 18);
  }

  // --- coins area + XP line -----------------------------------------------
  if (pts.length >= 2) {
    var area = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + plotH);
    area.addColorStop(0, 'rgba(54,112,242,0.42)');
    area.addColorStop(1, 'rgba(54,112,242,0.02)');
    ctx.beginPath();
    ctx.moveTo(sx(pts[0].t), PAD.t + plotH);
    for (var a = 0; a < pts.length; a++) ctx.lineTo(sx(pts[a].t), syCoins(pts[a].coins));
    ctx.lineTo(sx(pts[pts.length - 1].t), PAD.t + plotH);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.beginPath();
    for (var b = 0; b < pts.length; b++) {
      var bx = sx(pts[b].t), by = syCoins(pts[b].coins);
      if (b === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    }
    ctx.strokeStyle = B.coins;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(54,112,242,0.55)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    for (var d = 0; d < pts.length; d++) {
      var dx = sx(pts[d].t), dy = syPace(pace[d]);
      if (d === 0) ctx.moveTo(dx, dy); else ctx.lineTo(dx, dy);
    }
    ctx.strokeStyle = B.xp;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot each point where the round counter ticked up — a flat stretch with
    // no dots is exactly the "macro is stuck" signal a report should show.
    var seen = pts[0].rounds;
    for (var m = 1; m < pts.length; m++) {
      if (pts[m].rounds > seen) {
        seen = pts[m].rounds;
        ctx.beginPath();
        ctx.arc(sx(pts[m].t), syCoins(pts[m].coins), 3.2, 0, Math.PI * 2);
        ctx.fillStyle = B.marker;
        ctx.fill();
      }
    }
  }

  // --- header / footer ----------------------------------------------------
  var textX = 26;
  if (logoImg) {
    ctx.drawImage(logoImg, 24, 21, 36, 36);
    textX = 70;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = B.text;
  ctx.font = 'bold 19px ' + FONT;
  ctx.fillText('VELORA', textX, 41);
  var brandW = ctx.measureText('VELORA').width;
  ctx.fillStyle = B.dim;
  ctx.font = '12px ' + FONT;
  ctx.fillText('SESSION REPORT', textX + brandW + 10, 41);
  ctx.fillText(DATA.subtitle || '', textX, 59);

  ctx.textAlign = 'right';
  ctx.fillStyle = B.xp;
  ctx.fillText('\\u254C coins/hr', W - 24, 41);
  ctx.fillStyle = B.coins;
  ctx.fillText('\\u25CF total coins', W - 122, 41);
  ctx.fillStyle = B.dim;
  ctx.fillText(DATA.stamp || '', W - 24, 59);

  ctx.globalAlpha = 0.75;
  ctx.font = '11px ' + FONT;
  ctx.fillText('\\u25CF round completed', W - 24, H - 14);
  ctx.textAlign = 'left';
  ctx.fillText('towerheroesmacro.site', 24, H - 14);
  ctx.globalAlpha = 1;

  document.title = '${READY_TITLE}';
}

if (LOGO) {
  var img = new Image();
  img.onload = function() { draw(img); };
  img.onerror = function() { draw(null); };
  img.src = LOGO;
} else {
  draw(null);
}
</script>`;
}

// Render the chart in an offscreen window and return PNG bytes, or null if
// anything goes wrong (no GPU, render timeout, app shutting down). Callers
// treat null as "post the report without an image".
let renderSeq = 0;

function renderReportChart(data) {
  return new Promise((resolve) => {
    let win = null;
    let done = false;
    let lastFrame = null;
    // Unique per render: a "Preview" click can overlap a scheduled report, and
    // a shared filename would let one render's page swap in under the other —
    // posting a real report with the preview's synthetic data.
    renderSeq += 1;
    const htmlPath = path.join(os.tmpdir(),
      `velora-report-chart-${process.pid}-${renderSeq}.html`);

    const finish = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (err) { /* ignore */ }
      try { fs.unlinkSync(htmlPath); } catch (err) { /* best effort */ }
      resolve(buf && buf.length ? buf : null);
    };
    const timer = setTimeout(() => {
      // Timed out waiting for the ready signal — ship the latest frame if the
      // page painted at all, otherwise give up and let the caller post text.
      try { finish(lastFrame ? lastFrame.toPNG() : null); } catch (err) { finish(null); }
    }, 8000);

    try {
      fs.writeFileSync(htmlPath, chartHtml(data), 'utf8');

      win = new BrowserWindow({
        width: WIN_W,
        height: WIN_H,
        show: false,
        frame: false,
        webPreferences: {
          offscreen: true,
          backgroundThrottling: false,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      // Offscreen rendering hands us each composited frame directly, which is
      // more dependable for a never-shown window than capturePage(). We keep
      // the newest frame and grab it once the page reports it finished drawing
      // (via document.title) — the title change and the final paint can land in
      // either order, so the short delay lets the last paint settle.
      win.webContents.on('paint', (event, dirty, image) => { lastFrame = image; });
      win.webContents.on('page-title-updated', (event, title) => {
        if (title !== READY_TITLE || done) return;
        setTimeout(() => {
          try { finish(lastFrame ? lastFrame.toPNG() : null); } catch (err) { finish(null); }
        }, 200);
      });
      win.webContents.on('render-process-gone', () => finish(null));
      win.loadFile(htmlPath).catch(() => finish(null));
    } catch (err) {
      finish(null);
    }
  });
}

// POST a webhook message with a file attachment (multipart/form-data). Discord
// pairs the upload with the embed through an `attachment://<filename>` URL, so
// the caller must reference the same filename it passes here.
function postWebhookMultipart(url, payload, file) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const u = new URL(url);
      const boundary = '----VeloraForm' + Date.now().toString(16) + Math.random().toString(16).slice(2);
      const head = Buffer.from(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="payload_json"\r\n' +
        'Content-Type: application/json\r\n\r\n' +
        JSON.stringify(payload) + '\r\n' +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files[0]"; filename="${file.filename}"\r\n` +
        'Content-Type: image/png\r\n\r\n', 'utf8');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const body = Buffer.concat([head, file.buffer, tail]);

      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: 'request timed out' }); });
      req.write(body);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// chartHtml is exported so the chart can be opened in a normal browser during
// development without spinning up the whole app.
module.exports = { renderReportChart, postWebhookMultipart, sparkline, chartHtml };
