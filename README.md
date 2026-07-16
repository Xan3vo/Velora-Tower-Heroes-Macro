<div align="center">

# ⚔️ Velora — Tower Heroes Macro

**A polished desktop auto-farmer for Roblox _Tower Heroes_.**
Electron UI on top of a pixel-perfect AutoHotkey engine, with OCR-driven game reading,
a floating status overlay, and Discord webhook reporting.

<img src="Images/Kart1.webp" alt="Kart Kid" height="96" /> <img src="Images/Slimeking1.webp" alt="Slime King" height="96" />

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-29-47848F?logo=electron&logoColor=white)
![AutoHotkey](https://img.shields.io/badge/AutoHotkey-v1.1-334455)
![OCR](https://img.shields.io/badge/OCR-Windows.Media.Ocr-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## ✨ What it does

Velora plays *Tower Heroes* for you, end to end: it launches your server, readies up,
picks the map, places **Kart Kid + Slime King**, upgrades them to **MAX**, waits for the
win, collects, and loops — for hours, unattended.

- 🗺️ **5 maps supported** (Easy): Castle Town, Radiant Reef, Oddport Academy, Corporate Chaos, Glowing Glacier
- 🔎 **OCR game-reading** — map tiles, the selected-map header, hero upgrade buttons ("Upgrade All **MAX**"),
  and end-of-round **coins / XP** rewards are read with Windows' built-in offline OCR engine (no installs, no cloud)
- 📊 **Floating status overlay** — live mana, rounds, coins and XP while the macro runs
- 🔔 **Discord webhooks** — round-complete embeds, start/stop summaries, restart alerts with
  optional @you pings on critical failures; every event individually toggleable
- 🧠 **Self-healing** — stuck-state detection with automatic full restarts, plus a restart-loop
  guard that stops the macro (and pings you) instead of thrashing all night
- 📈 **Lifetime stats** — rounds, coins, XP and hours accumulated across all sessions
- 🎛️ **Built-in OCR calibrator** — Settings → Advanced lets you nudge and live-test every
  OCR region against your own screen, no code edits needed

## 🖥️ Requirements

| Requirement | Why |
|---|---|
| Windows 10/11 | Uses Windows' built-in OCR + AutoHotkey |
| [AutoHotkey **v1.1**](https://www.autohotkey.com/) (not v2) | The macro engine (`AutoHotkeyU64.exe`) |
| Display scale **100%** | Pixel coordinates must not be DPI-virtualized |
| Resolution **2560×1440**, **1920×1080**, or **3840×2160** | Coordinates are calibrated at 1440p and scaled |
| Roblox in **fullscreen** | The macro verifies and enforces this |

> The app checks all of this on launch and tells you exactly what's off.

## 🚀 Quick start

```bash
git clone https://github.com/Xan3vo/Velora-Tower-Heroes-Macro.git
cd Velora-Tower-Heroes-Macro
npm install
npm start
```

Build a Windows installer (NSIS):

```bash
npm run build   # → dist/
```

Then: pick a map, pick **Easy**, hit **Play** (or `F1`) and walk away.

## ⌨️ Hotkeys

| Key | Action |
|---|---|
| `F1` | Start the macro |
| `F3` | Stop the macro |
| `F4` | Bring the app windows to front |

Hotkeys are global — they work while Roblox has focus.

## ⚙️ Settings

- **General** — close Roblox on stop, status overlay + always-on-top, close the leftover
  browser tab after launch, restart-loop guard, lifetime stats
- **Discord** — webhook URL with a one-click test, optional user ID to @ping on critical
  alerts, and a per-event toggle for every message type
- **Advanced** — the OCR region calibrator: X/Y/W/H per region on the 1440p baseline with
  a live **Test** button per row

Settings persist to `%APPDATA%/tower-heroes-macro/settings.json`.

## 🔬 How it works

```
┌────────────┐   spawn + args    ┌──────────────────┐   pixel & OCR reads   ┌────────┐
│  Electron   │ ────────────────▶ │  AutoHotkey v1.1  │ ────────────────────▶ │ Roblox │
│  (main.js)  │ ◀──────────────── │  (macro engine)   │ ◀──────────────────── │        │
└────────────┘   status file     └──────────────────┘   clicks & hotkeys    └────────┘
      │                                    │
      │ Windows.Media.Ocr (ocr.ps1)        │ stop.txt / stats file (file-based control)
      ▼                                    ▼
  coins/XP/mana OCR, Discord embeds,   graceful stop, run counters
  overlay stats, lifetime totals
```

1. **Launch** — the app validates your display, spawns the macro, and starts polling its status file
2. **Lobby** — the macro readies up and picks your map by **OCR-reading the map tiles** (scrolling as needed), then verifies the selection against the lobby header
3. **Round** — places both heroes, confirms placement via card-slot pixels, detects which hero
   landed in which slot by OCR, and upgrades each until the button literally says **MAX**
4. **Collect** — on the win screen it OCRs the coins/XP rewards, fires your Discord embed, returns to lobby, and loops

Every OCR read is logged (`ocr-debug.log` in the app's data folder) so misreads are diagnosable —
and fixable from the in-app calibrator.

## 📁 Project layout

| File | Role |
|---|---|
| `main.js` | Electron main process — process management, settings, stats, OCR, webhooks |
| `index.html` | The UI (frameless window, intro animation, settings + guide modals) |
| `status.html` | Floating status overlay |
| `preload.js` | IPC bridge |
| `CastleTown_Easy.ahk` | The macro engine (shared by all supported maps) |
| `ocr.ps1` | Windows.Media.Ocr wrapper — screen-region → text, with scale-retry ladder |
| `PixelInspector.ahk` | Dev tool: live cursor position/color logger for calibration |
| `CLAUDE.md` | Engineering notes (architecture, calibration history, gotchas) |

## ⚠️ Disclaimer

This is an automation/botting tool. Using macros in Roblox may violate the
[Roblox Terms of Use](https://en.help.roblox.com/hc/en-us/articles/115004647846) and could
put your account at risk — use it on an account you're prepared to lose, at your own risk.
This project is provided for educational purposes, without warranty of any kind (see [LICENSE](LICENSE)).

---

<div align="center">
Made with ⚔️ by <a href="https://github.com/Xan3vo">Xan3vo</a>
</div>
