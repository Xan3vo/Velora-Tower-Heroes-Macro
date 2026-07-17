#Requires AutoHotkey v1.1.37
; force: a new launch silently replaces any stale instance of this script —
; without this, an orphaned run (e.g. app closed mid-run) keeps clicking
; alongside the new one, fighting over the mouse.
#SingleInstance force

; ============================================================
;  FILE PATHS
; ============================================================

statusFile       := A_ScriptDir . "\status.txt"
stopFile         := A_ScriptDir . "\stop.txt"
macroRunningFile := A_ScriptDir . "\macro_running.txt"
statsFile        := A_ScriptDir . "\stats.txt"

; Run counters surfaced in the status overlay (rounds cleared, restarts done).
roundsCompleted := 0
restartCount    := 0
hasLaunchedOnce := false
robloxDead      := false   ; set when a disconnect is detected mid-run

; ============================================================
;  COMMAND LINE / TESTING MODE
; ============================================================

argsCount   := A_Args.Length()
testingMode := false

if (argsCount >= 1 && A_Args[1] = "test")
    testingMode := true

if (argsCount >= 5) {
    statusFile := A_Args[5]
    SplitPath, statusFile, , statusDir
    stopFile         := statusDir . "\stop.txt"
    macroRunningFile := statusDir . "\macro_running.txt"
    ; Fixed name so main.js can find/read it in the same temp dir.
    statsFile        := statusDir . "\towerheroes-stats.txt"
}

; Arg 2: map name. The whole in-game sequence (heroes, upgrades, completion)
; is identical across supported maps — only the lobby map-pick step differs.
; Castle Town is the game's default selection and needs no extra clicks.
selectedMap := "Castle Town"
if (argsCount >= 2 && A_Args[2] != "")
    selectedMap := A_Args[2]

; Arg 6 ("1"/"0"): close the leftover roblox.com browser tab after launch.
closeBrowserTab := (argsCount >= 6 && A_Args[6] = "1")

; Arg 7: launch method — "auto" (roblox:// deep link, no browser tab; falls
; back to the browser URL after 2 failed deep-link attempts) or "browser"
; (always launch via roblox.com in the default browser).
launchMethod := "auto"
if (argsCount >= 7 && A_Args[7] = "browser")
    launchMethod := "browser"
; Failed deep-link launches this run. Persists across FullRestarts on purpose:
; once the deep link has failed twice, every later restart goes straight to
; the browser instead of burning 40s rediscovering the same failure.
deeplinkFails := 0

; ============================================================
;  SCALE FACTOR
; ============================================================

; Force AHK to work in physical pixels (matches Window Spy coords)
DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")

; All coords were measured at 2560x1440 — scale proportionally to current resolution
scaleFactor := A_ScreenWidth / 2560

; ============================================================
;  RESOLUTION & SCALING CHECK
; ============================================================

; Check DPI scaling (must be 100%)
hdc        := DllCall("GetDC", "uint", 0)
currentDPI := DllCall("GetDeviceCaps", "uint", hdc, "int", 90)
DllCall("ReleaseDC", "uint", 0, "uint", hdc)
if (currentDPI != 96) {
    pct := Chr(37)
    msg := "Your Windows display scaling must be set to 100" pct ".`n`nPlease go to:`nSettings > Display > Scale and set it to 100" pct ", then rerun the macro."
    MsgBox, 48, Scaling Error, %msg%
    ExitApp
}

; Check resolution is one of the supported options
supportedRes := (A_ScreenWidth = 2560 && A_ScreenHeight = 1440)
            || (A_ScreenWidth = 1920 && A_ScreenHeight = 1080)
            || (A_ScreenWidth = 3840 && A_ScreenHeight = 2160)
if (!supportedRes) {
    MsgBox, 48, Resolution Error, Your resolution (%A_ScreenWidth%x%A_ScreenHeight%) is not supported.`n`nPlease set your resolution to one of:`n  - 2560x1440`n  - 1920x1080`n  - 3840x2160`n`nThen rerun the macro.
    ExitApp
}

; ============================================================
;  DEBUG LOGGING (startup)
; ============================================================

FileAppend, === AHK Script Started ===`n, %A_Temp%\ahk_debug.log
argsLen := A_Args.Length()
argStr  := "Number of arguments: " argsLen
FileAppend, %argStr%`n,                                          %A_Temp%\ahk_debug.log
FileAppend, Status File before arg check: %statusFile%`n,        %A_Temp%\ahk_debug.log
FileAppend, About to enter loop`n,                               %A_Temp%\ahk_debug.log
Loop, % argsLen {
    argValue := A_Args[A_Index]
    idx      := A_Index
    FileAppend, Arg[%idx%]: %argValue%`n, %A_Temp%\ahk_debug.log
}
FileAppend, Loop completed`n, %A_Temp%\ahk_debug.log
TrayTip, Debug, Status File: %statusFile%, 5

; ============================================================
;  STATUS & DEBUG FUNCTIONS
; ============================================================

WriteStatus(text) {
    global statusFile
    if FileExist(statusFile)
        FileDelete, %statusFile%
    FileAppend, %text%, %statusFile%
    TrayTip, Status Update, %text%, 1
}

UpdateStatus(text) {
    WriteStatus(text)
}

; Write the run counters ("rounds|restarts") for the status overlay to read.
WriteStats() {
    global statsFile, roundsCompleted, restartCount
    data := roundsCompleted . "|" . restartCount
    if FileExist(statsFile)
        FileDelete, %statsFile%
    FileAppend, %data%, %statsFile%
}

DebugLog(text) {
    global testingMode
    if (!testingMode)
        return
    FileAppend, %A_Now% - %text%`n, %A_Temp%\ahk_test_debug.log
}

; ============================================================
;  STOP / SLEEP HELPERS
; ============================================================

CheckForStop() {
    global stopFile
    if (FileExist(stopFile)) {
        FileDelete, %stopFile%
        UpdateStatus("Macro stopped by user.")
        ExitApp
    }
}

SleepWithStop(ms) {
    interval  := 1000
    loops     := Floor(ms / interval)
    remainder := ms - (loops * interval)
    Loop, %loops% {
        CheckForStop()
        Sleep, %interval%
    }
    if (remainder > 0)
        Sleep, %remainder%
}

; ============================================================
;  LEFTOVER BROWSER TAB CLEANUP
; ============================================================

; The Run of the roblox.com URL opens a tab in the default browser, which
; stays behind after the Roblox client launches. When enabled (arg 6), find a
; browser window whose ACTIVE tab title mentions Roblox and Ctrl+W just that
; tab. Matching by browser exe (not window class) so the Roblox client itself
; (title is also "Roblox") can never receive the Ctrl+W. Best-effort: if the
; user switched tabs meanwhile, the title won't match and nothing is closed.
CloseLeftoverBrowserTab() {
    global closeBrowserTab
    if (!closeBrowserTab)
        return
    prevMatchMode := A_TitleMatchMode
    SetTitleMatchMode, 2
    browserExes := ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"]
    for index, exe in browserExes {
        WinGet, hwnd, ID, Roblox ahk_exe %exe%
        if (hwnd) {
            WinActivate, ahk_id %hwnd%
            Sleep, 500
            WinGetTitle, activeTitle, A
            if (WinActive("ahk_id " . hwnd) && InStr(activeTitle, "Roblox")) {
                Send, ^w
                Sleep, 400
                UpdateStatus("Closed leftover browser tab")
            }
            Break
        }
    }
    SetTitleMatchMode, %prevMatchMode%
    ; Hand focus back to the Roblox client before the macro continues.
    WinActivate, ahk_exe RobloxPlayerBeta.exe
    Sleep, 500
}

; ============================================================
;  ROBLOX LAUNCH HELPERS
; ============================================================

; Resolve RobloxPlayerBeta.exe directly instead of trusting the roblox://
; protocol registration. Live-found failure mode: a stale HKCU\Software\
; Classes\roblox key from a deleted per-user install shadows the valid HKLM
; machine-wide one, so ShellExecute reports "Application not found" even
; though Roblox is installed. Reading every registration and validating the
; exe on disk sidesteps that for any machine. Re-resolved on every launch on
; purpose — a Roblox self-update mid-session moves the version-* folder.
; Returns "" if no valid player exe was found.
FindRobloxPlayerExe() {
    keys := ["HKEY_CURRENT_USER\Software\Classes\roblox\shell\open\command"
           , "HKEY_LOCAL_MACHINE\Software\Classes\roblox\shell\open\command"
           , "HKEY_CURRENT_USER\Software\Classes\roblox-player\shell\open\command"
           , "HKEY_LOCAL_MACHINE\Software\Classes\roblox-player\shell\open\command"]
    for i, key in keys {
        RegRead, cmd, %key%
        if (!ErrorLevel && RegExMatch(cmd, "i)""([^""]+RobloxPlayerBeta\.exe)""", m) && FileExist(m1))
            return m1
    }
    ; No valid registration — scan the known install roots for the exe.
    EnvGet, localAppData, LOCALAPPDATA
    EnvGet, pf86, ProgramFiles(x86)
    roots := [localAppData . "\Roblox\Versions", pf86 . "\Roblox\Versions", A_ProgramFiles . "\Roblox\Versions"]
    for i, root in roots {
        Loop, Files, %root%\RobloxPlayerBeta.exe, R
            return A_LoopFileLongPath
    }
    return ""
}

; ============================================================
;  ROBLOX WINDOW HELPERS
; ============================================================

; True while Roblox is still up — either the game client window OR a browser
; window still titled "Roblox". Used to detect a disconnect / crash so the run
; can auto-rejoin instead of clicking into a dead window forever.
RobloxAlive() {
    if WinExist("ahk_exe RobloxPlayerBeta.exe")
        return true
    WinGet, ids, List, ahk_class Chrome_WidgetWin_1
    Loop, %ids% {
        id := ids%A_Index%
        WinGetTitle, t, ahk_id %id%
        if (InStr(t, "Roblox"))
            return true
    }
    return false
}

CloseRobloxWindows() {
    WinClose, ahk_exe RobloxPlayerBeta.exe
    WinGet, windows, List, ahk_class Chrome_WidgetWin_1
    Loop, %windows% {
        id := windows%A_Index%
        WinGetTitle, title, ahk_id %id%
        if (InStr(title, "Roblox"))
            WinClose, ahk_id %id%
    }
    Sleep, 2000
}

; ============================================================
;  HERO SLOT DETECTION
; ============================================================

FindHeroSlot(baseX, baseY) {
    global scaleFactor, testingMode
    Loop, 10 {
        x := Round(baseX * scaleFactor)
        y := Round(baseY * scaleFactor) + (A_Index - 1) * Round(87 * scaleFactor)
        PixelGetColor, color, %x%, %y%, RGB
        if (testingMode)
            DebugLog("FindHeroSlot scan slot " A_Index " at (" x ", " y "): " color)
        if ((color & 0xFFFFFF) = 0xFFFFFF) {
            if (testingMode)
                DebugLog("Found white slot at " A_Index)
            return A_Index
        }
    }
    if (testingMode)
        DebugLog("No white slot found for baseX " baseX ", baseY " baseY)
    return 0
}

FindSlimeSlot() {
    global scaleFactor, testingMode

    ; Check slot 1
    x := Round(1059 * scaleFactor)
    y := Round(433  * scaleFactor)
    PixelGetColor, color, %x%, %y%, RGB
    if (testingMode)
        DebugLog("FindSlimeSlot slot 1 at (" x ", " y "): " color)
    if ((color & 0xFFFFFF) = 0xFFFFFF) {
        if (testingMode)
            DebugLog("Slime King in slot 1")
        return 1
    }

    ; Check slot 2
    x := Round(1059 * scaleFactor)
    y := Round(515  * scaleFactor)
    PixelGetColor, color, %x%, %y%, RGB
    if (testingMode)
        DebugLog("FindSlimeSlot slot 2 at (" x ", " y "): " color)
    if ((color & 0xFFFFFF) = 0xFFFFFF) {
        if (testingMode)
            DebugLog("Slime King in slot 2")
        return 2
    }

    if (testingMode)
        DebugLog("Slime King not found in slot 1 or 2")
    return 0
}

; ============================================================
;  TEST MODE
; ============================================================

TestSlimeKingDetection() {
    WinGet, robloxID, ID, ahk_exe RobloxPlayerBeta.exe
    if (robloxID) {
        WinActivate, ahk_id %robloxID%
        Sleep, 500
    }
    UpdateStatus("Test mode: scanning Slime King slot coordinates")
    tempSlimeSlot := FindSlimeSlot()
    if (tempSlimeSlot > 0)
        UpdateStatus("Slime King slot detected at index " tempSlimeSlot)
    else
        UpdateStatus("Slime King slot NOT detected at index scan")
}

; ============================================================
;  AUTO-SKIP CHECK
; ============================================================

CheckAutoSkip() {
    global scaleFactor
    UpdateStatus("Checking auto-skip setting")

    ; Open settings
    settingsX := Round(106  * scaleFactor)
    settingsY := Round(991  * scaleFactor)
    MouseClick, Left, %settingsX%, %settingsY%
    SleepWithStop(500)

    ; Open interference settings
    interfX := Round(1127 * scaleFactor)
    interfY := Round(479  * scaleFactor)
    MouseClick, Left, %interfX%, %interfY%
    SleepWithStop(500)

    ; Check auto-skip toggle color
    checkX        := Round(722 * scaleFactor)
    checkY        := Round(796 * scaleFactor)
    expectedColor := 0x42D425
    PixelGetColor, foundColor, %checkX%, %checkY%, RGB

    if ((foundColor & 0xFFFFFF) = (expectedColor & 0xFFFFFF)) {
        UpdateStatus("Auto-skip is enabled")
        closeX := Round(1866 * scaleFactor)
        closeY := Round(383  * scaleFactor)
        MouseClick, Left, %closeX%, %closeY%
        SleepWithStop(300)
        return true
    }

    ; Not enabled — toggle it on
    UpdateStatus("Enabling auto-skip")
    toggleX := Round(728 * scaleFactor)
    toggleY := Round(795 * scaleFactor)
    MouseClick, Left, %toggleX%, %toggleY%
    SleepWithStop(300)

    ; Verify
    PixelGetColor, newColor, %checkX%, %checkY%, RGB
    if ((newColor & 0xFFFFFF) = (expectedColor & 0xFFFFFF))
        UpdateStatus("Auto-skip enabled successfully")
    else
        UpdateStatus("Warning: Auto-skip may not be enabled")

    closeX := Round(1868 * scaleFactor)
    closeY := Round(383  * scaleFactor)
    Click, %closeX%, %closeY%
    SleepWithStop(300)
    return true
}

; ============================================================
;  CAMERA / VIEW PREP
; ============================================================

PreparePlacementView() {
    global scaleFactor
    UpdateStatus("Preparing placement")
    WinActivate, ahk_exe RobloxPlayerBeta.exe
    Sleep, 500

    centerX := Round(A_ScreenWidth  / 2)
    centerY := Round(A_ScreenHeight / 2)
    MouseMove, %centerX%, %centerY%, 0
    SleepWithStop(200)

    ; Zoom out
    Loop, 6 {
        CheckForStop()
        Send, {WheelDown}
        SleepWithStop(150)
    }

    ; Tilt camera down via RMB drag
    MouseMove, %centerX%, %centerY%, 0
    SleepWithStop(150)
    Send, {RButton down}
    SleepWithStop(120)
    MouseMove, %centerX%, % (centerY + Round(260 * scaleFactor)), 100
    SleepWithStop(200)
    Send, {RButton up}
    SleepWithStop(300)
}

; ============================================================
;  UPGRADE / MAXED DETECTION
;  Primary: OCR the hero-row button text (IsMaxedSmart).
;  Fallback: legacy 12-pixel white check (IsMaxed) when OCR
;  is unavailable on the machine.
; ============================================================

IsMaxed(offsetY) {
    global scaleFactor
    coords := [[1439,426],[1456,438],[1466,436],[1500,424]
             , [1472,435],[1441,429],[1471,426],[1469,429]
             , [1485,424],[1500,439],[1495,430],[1446,436]]
    for i, pt in coords {
        x := Round(pt[1] * scaleFactor)
        y := Round(pt[2] * scaleFactor) + offsetY
        PixelGetColor, c, %x%, %y%, RGB
        if ((c & 0xFFFFFF) != 0xFFFFFF)
            return false
    }
    return true
}

; OCR a screen region via ocr.ps1 (Windows' built-in OCR, no install needed).
; Coordinates are physical pixels. Returns "" if the helper is missing or OCR
; is unavailable — callers must treat "" as "no answer", not "no".
OcrScreenRegion(x, y, w, h) {
    psPath := A_ScriptDir . "\ocr.ps1"
    if (!FileExist(psPath))
        return ""
    outFile := A_Temp . "\towerheroes-ocr-read.txt"
    FileDelete, %outFile%
    cmd := "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ . psPath . """"
         . " -X " . x . " -Y " . y . " -W " . w . " -H " . h
         . " -OutFile """ . outFile . """"
    RunWait, %cmd%, , Hide
    if (!FileExist(outFile))
        return ""
    FileRead, txt, %outFile%
    return Trim(txt)
}

; Read the hero-row action button ("Upgrade All <cost>" / "Upgrade All MAX" /
; "Ability All 20K") in the Hero Data menu via OCR.
OcrHeroButton(offsetY) {
    global scaleFactor
    x := Round(1140 * scaleFactor)
    y := Round(396  * scaleFactor) + offsetY
    w := Round(420  * scaleFactor)
    h := Round(66   * scaleFactor)
    txt := OcrScreenRegion(x, y, w, h)
    FileAppend, % A_Now . " heroBtn(offset " . offsetY . "): """ . txt . """`n", %A_Temp%\towerheroes-ocr-ahk.log
    return txt
}

; Read the slot-1 hero row's title ("Slime King x1" / "Kart Kid x1") in the
; Hero Data menu via OCR — used for slot detection.
OcrHeroRowTitle() {
    global scaleFactor
    x := Round(745 * scaleFactor)
    y := Round(398 * scaleFactor)
    w := Round(345 * scaleFactor)
    h := Round(66  * scaleFactor)
    txt := OcrScreenRegion(x, y, w, h)
    FileAppend, % A_Now . " heroRow1: """ . txt . """`n", %A_Temp%\towerheroes-ocr-ahk.log
    return txt
}

; OCR-first maxed check with the old pixel check as fallback.
; Maxed shows "Upgrade All MAX"; once Slime King's ability unlocks (~15s after
; max) the button becomes green "Ability All 20K" — both count as maxed. A cost
; number means keep upgrading. "" (OCR unavailable) falls back to pixels.
IsMaxedSmart(offsetY) {
    txt := OcrHeroButton(offsetY)
    if (txt != "") {
        if (InStr(txt, "MAX") || InStr(txt, "Ability"))
            return true
        return false
    }
    return IsMaxed(offsetY)
}

; ============================================================
;  MAP SELECTION (Maps tab list)
; ============================================================

; All coords on the 2560x1440 baseline, from a user screenshot of the lobby:
; tiles are ~141px apart, first tile top at y~512, titles in the tile's top
; band, list column centered at x~1114. The left panel header (y~314) shows
; the currently selected map's name.

; OCR the selected-map header in the left panel ("Castle Town", ...).
OcrSelectedMapHeader() {
    global scaleFactor
    x := Round(165 * scaleFactor)
    y := Round(295 * scaleFactor)
    w := Round(620 * scaleFactor)
    h := Round(95  * scaleFactor)
    txt := OcrScreenRegion(x, y, w, h)
    FileAppend, % A_Now . " mapHeader: """ . txt . """`n", %A_Temp%\towerheroes-ocr-ahk.log
    return txt
}

; Find and click mapName's tile in the Maps list, scrolling if it isn't
; visible. OCR-driven (tile titles), so it survives list reordering and new
; maps; ImageSearch thumbnails wouldn't survive resolution changes. When OCR
; is unavailable, falls back to fixed clicks for the maps visible without
; scrolling. Returns true once the header confirms (or best-effort click).
SelectMapTile(mapName) {
    global scaleFactor
    listX     := Round(1114 * scaleFactor)
    firstTop  := 512    ; baseline y of the first tile's top edge
    pitch     := 141    ; baseline distance between tile tops
    slots     := 4      ; fully visible tiles per screen

    ; Fixed fallbacks (no OCR): tiles visible without scrolling.
    fallbackY := 0
    if (mapName = "Corporate Chaos")
        fallbackY := firstTop + pitch + 70
    else if (mapName = "Glowing Glacier")
        fallbackY := firstTop + (2 * pitch) + 70

    ; Probe slot 0 (always has a title) to learn whether OCR works at all.
    probe := OcrMapTileTitle(0, firstTop, pitch)
    if (probe = "") {
        if (fallbackY = 0)
            return false
        cy := Round(fallbackY * scaleFactor)
        MouseClick, left, %listX%, %cy%
        Sleep, 800
        return true
    }

    deadline := A_TickCount + 45000
    Loop {
        CheckForStop()
        Loop, %slots% {
            i := A_Index - 1
            txt := (probe != "") ? probe : OcrMapTileTitle(i, firstTop, pitch)
            probe := ""   ; the probe read doubles as slot 0's first read
            if (txt != "" && InStr(txt, mapName)) {
                cy := Round((firstTop + (pitch * i) + 80) * scaleFactor)
                MouseClick, left, %listX%, %cy%
                Sleep, 1200
                ; Verify via the left-panel header; a miss = keep searching.
                hdr := OcrSelectedMapHeader()
                if (hdr = "" || InStr(hdr, mapName))
                    return true
            }
        }
        if (A_TickCount >= deadline)
            return false
        ; Not on screen — hover the list (a click would select a map) and
        ; scroll down a full screenful (one tick barely moves the list, so
        ; rescanning after each tick mostly re-reads the same tiles), then
        ; re-read.
        hoverY := Round(800 * scaleFactor)
        MouseMove, %listX%, %hoverY%
        Loop, 4 {
            Send, {WheelDown}
            Sleep, 150
        }
        Sleep, 700
    }
}

; OCR the title band of list slot i (0-based, top to bottom).
OcrMapTileTitle(i, firstTop, pitch) {
    global scaleFactor
    x := Round(875 * scaleFactor)
    y := Round((firstTop + (pitch * i)) * scaleFactor)
    w := Round(480 * scaleFactor)
    h := Round(110 * scaleFactor)   ; taller than the title so scroll drift still catches it
    txt := OcrScreenRegion(x, y, w, h)
    FileAppend, % A_Now . " mapTile[" . i . "]: """ . txt . """`n", %A_Temp%\towerheroes-ocr-ahk.log
    return txt
}

; ============================================================
;  PLACEMENT / UPGRADE HELPERS
; ============================================================

; Three randomized clicks inside the placement zone to drop the currently
; selected hero. Placement is coordinate-random (not path-aware) — see notes.
RandomPlaceClicks() {
    global scaleFactor
    Loop, 3 {
        CheckForStop()
        Random, px, % Round(826 * scaleFactor), % Round(1728 * scaleFactor)
        Random, py, % Round(370 * scaleFactor), % Round(996  * scaleFactor)
        MouseClick, left, %px%, %py%
        Sleep, 150
    }
    Sleep, 1000
}

; Place a hero by hotkey and confirm via a white card pixel. Leaves the hero
; panel OPEN on success. Returns true if placed, false if retries exhausted.
PlaceHeroByCard(hotkey, label, cardCheckX, cardCheckY, closeHeroX, closeHeroY) {
    retries    := 0
    maxRetries := 10
    Loop {
        CheckForStop()
        if (retries >= maxRetries)
            return false
        retries += 1
        UpdateStatus("Placing " label ", attempt " retries)

        Send, %hotkey%
        Sleep, 500
        RandomPlaceClicks()

        Send, %hotkey%   ; deselect
        Sleep, 500
        Send, n          ; open hero panel
        Sleep, 2000

        PixelGetColor, cardColor, %cardCheckX%, %cardCheckY%, RGB
        if ((cardColor & 0xFFFFFF) = 0xFFFFFF) {
            UpdateStatus(label " placed successfully")
            return true
        }

        UpdateStatus(label " not placed, retrying")
        MouseClick, left, %closeHeroX%, %closeHeroY%
        Sleep, 1000
    }
}

; Place Slime King (hotkey 2) and confirm via FindSlimeSlot (it can land in
; slot 1 or 2). Leaves the hero panel OPEN on success.
PlaceSlimeKing(closeHeroX, closeHeroY) {
    retries    := 0
    maxRetries := 10
    Loop {
        CheckForStop()
        if (retries >= maxRetries)
            return false
        retries += 1
        UpdateStatus("Placing Slime King, attempt " retries)

        Send, 2
        Sleep, 500
        RandomPlaceClicks()

        Send, 2          ; deselect
        Sleep, 500
        Send, n          ; open hero panel
        Sleep, 2000

        if (FindSlimeSlot() > 0) {
            UpdateStatus("Slime King placed successfully")
            return true
        }

        UpdateStatus("Slime King not placed, retrying")
        MouseClick, left, %closeHeroX%, %closeHeroY%
        Sleep, 1000
    }
}

; True if color c is within +/- tol on every RGB channel of reference ref.
; Used for card-slot "placed" detection where art can vary by a few values.
ColorClose(c, ref, tol) {
    r1 := (c   >> 16) & 0xFF, g1 := (c   >> 8) & 0xFF, b1 := c   & 0xFF
    r2 := (ref >> 16) & 0xFF, g2 := (ref >> 8) & 0xFF, b2 := ref & 0xFF
    return (Abs(r1 - r2) <= tol && Abs(g1 - g2) <= tol && Abs(b1 - b2) <= tol)
}

; True if any pixel in a short vertical strip around (x, yc) matches the grey
; "filled" color. Scanning a strip (rather than one pixel) tolerates a few px
; of drift in the thin grey trim of a filled card slot.
SlotFilledGrey(x, yc, ref, tol) {
    dy := -6
    while (dy <= 6) {
        PixelGetColor, c, % x, % (yc + dy), RGB
        if (ColorClose(c, ref, tol))
            return true
        dy += 2
    }
    return false
}

; Upgrade a hero (hero panel must be open) by clicking its upgrade button until
; IsMaxed() reports maxed, bounded by [minSeconds, maxSeconds].
;   offsetY    : vertical offset for the hero's slot (0 = top slot)
;   minSeconds : always upgrade at least this long before trusting IsMaxed
;                (guards against a false-positive "maxed" pixel read)
;   maxSeconds : hard cap so a miscalibrated IsMaxed can never hang the run
UpgradeHeroUntilMaxed(upgradeX, upgradeY, offsetY, minSeconds, maxSeconds, label) {
    global robloxDead
    consecutiveMax := 0
    deadReads      := 0
    upgradeStart   := A_TickCount
    Loop {
        CheckForStop()

        ; Bail out early if Roblox died — no point clicking a dead window.
        ; Require a few consecutive misses so a transient hiccup won't trip it.
        if (!RobloxAlive()) {
            deadReads += 1
            if (deadReads >= 3) {
                robloxDead := true
                UpdateStatus("Roblox closed during upgrade — restarting")
                return
            }
            Sleep, 1000
            continue
        }
        deadReads := 0

        elapsed := Floor((A_TickCount - upgradeStart) / 1000)

        if (elapsed >= minSeconds && IsMaxedSmart(offsetY)) {
            consecutiveMax += 1
            if (consecutiveMax >= 2) {
                UpdateStatus(label " maxed (" elapsed "s)")
                return
            }
        } else {
            consecutiveMax := 0
        }

        if (elapsed >= maxSeconds) {
            UpdateStatus(label " upgrade cap reached (" elapsed "s)")
            return
        }

        UpdateStatus("Upgrading " label " (" elapsed "s)")
        MouseClick, left, %upgradeX%, %upgradeY%
        Sleep, 5000
    }
}

; ============================================================
;  ENTRY POINT
; ============================================================

UpdateStatus("Macro started")
UpdateStatus("Closing existing Roblox windows")
CloseRobloxWindows()

if (A_Args.Length > 0 && A_Args[1] = "stop") {
    UpdateStatus("Macro stopped by user.")
    ExitApp
}

if (testingMode) {
    UpdateStatus("Test mode enabled")
    TestSlimeKingDetection()
    ExitApp
}

; ============================================================
;  FULL RESTART  (first launch + after fatal errors)
; ============================================================

FullRestart:
; A stop pressed just before a restart must win — otherwise we'd relaunch
; Roblox (and open a fresh browser tab) on our way out.
CheckForStop()
; Count every restart after the first launch (initial fall-through is not one).
if (hasLaunchedOnce) {
    restartCount += 1
    WriteStats()
}
hasLaunchedOnce := true
robloxDead := false

FileDelete, %macroRunningFile%
FileAppend, running, %macroRunningFile%

WriteStats()
; Up to 3 attempts in auto mode: deep link, deep link, then the browser URL.
; In browser mode the first (browser) attempt failing is fatal, as before.
usedBrowserLaunch := false
robloxID := 0
Loop, 3 {
    CheckForStop()
    useDeeplink := (launchMethod = "auto" && deeplinkFails < 2)
    if (useDeeplink) {
        UpdateStatus("Launching Roblox (deep link)")
        deepUrl := "roblox://experiences/start?placeId=4646477729&linkCode=30153874208011614870924132818489"
        ; Prefer invoking the player exe directly — identical to what the
        ; protocol handler does ("RobloxPlayerBeta.exe" %1) but immune to
        ; stale/broken roblox:// registrations (see FindRobloxPlayerExe).
        ; UseErrorLevel: a plain failed Run throws a blocking error dialog
        ; and kills the thread — the fallback would never fire. Swallow it
        ; and count the attempt as failed immediately (no 20s wait).
        playerExe := FindRobloxPlayerExe()
        if (playerExe != "")
            Run, "%playerExe%" "%deepUrl%", , UseErrorLevel
        else
            Run, %deepUrl%, , UseErrorLevel
        if (ErrorLevel) {
            deeplinkFails += 1
            UpdateStatus(deeplinkFails >= 2 ? "Deep link unavailable - switching to browser launch" : "Deep link launch failed - retrying")
            Continue
        }
    } else {
        UpdateStatus("Launching Roblox (browser)")
        Run, https://www.roblox.com/games/4646477729/Tower-Heroes?privateServerLinkCode=30153874208011614870924132818489
        usedBrowserLaunch := true
    }
    SleepWithStop(15000)

    WinGet, robloxID, ID, ahk_exe RobloxPlayerBeta.exe
    if (!robloxID) {
        UpdateStatus("Waiting for Roblox to start")
        Sleep, 5000
        WinGet, robloxID, ID, ahk_exe RobloxPlayerBeta.exe
    }
    if (robloxID)
        Break
    if (!useDeeplink)
        Break
    deeplinkFails += 1
    UpdateStatus(deeplinkFails >= 2 ? "Deep link failed twice - switching to browser launch" : "Deep link launch failed - retrying")
}

if (robloxID) {
    UpdateStatus("Roblox launcher detected")
    ; Only a browser launch leaves a tab behind — the deep link never opens one.
    if (usedBrowserLaunch)
        CloseLeftoverBrowserTab()
    WinActivate, ahk_id %robloxID%
    Sleep, 1000
    Sleep, 5000
} else {
    MsgBox, 48, Roblox Launch Error, Roblox player was not detected. Please ensure Roblox is installed and logged in, then rerun.
    ExitApp
}

; Fullscreen check
WinGetPos, X, Y, Width, Height, ahk_id %robloxID%
if (Width < A_ScreenWidth - 5 || Height < A_ScreenHeight - 5) {
    UpdateStatus("Roblox not fullscreen, attempting fullscreen")
    WinActivate, ahk_exe RobloxPlayerBeta.exe
    Sleep, 500
    Send, {F11}
    Sleep, 2000
    startFS := A_TickCount
    Loop {
        CheckForStop()
        WinGetPos, X, Y, Width, Height, ahk_id %robloxID%
        if (X = 0 && Y = 0 && Width = A_ScreenWidth && Height = A_ScreenHeight) {
            UpdateStatus("Roblox is now fullscreen")
            Break
        }
        elapsedFS := Floor((A_TickCount - startFS) / 1000)
        if (elapsedFS >= 10) {
            UpdateStatus("Fullscreen check timeout, proceeding anyway")
            Break
        }
        Sleep, 500
    }
}

; Play button pixel search coords (set once, reused each round)
playX      := Round(1167 * scaleFactor)
playY      := Round(1194 * scaleFactor)
scanRadius := 5
playX1     := playX - scanRadius
playY1     := playY - scanRadius
playX2     := playX + scanRadius
playY2     := playY + scanRadius

; ============================================================
;  RESTART GAME  (re-entry after each completed round)
; ============================================================

RestartGame:
WinGet, robloxID, ID, ahk_exe RobloxPlayerBeta.exe
WinActivate, ahk_id %robloxID%
Sleep, 500

; --- Wait for play button ---
UpdateStatus("Looking for play button")
start := A_TickCount
Loop {
    CheckForStop()
    elapsed := Floor((A_TickCount - start) / 1000)
    UpdateStatus("Looking for play button (" elapsed "s)")
    PixelSearch, FoundX, FoundY, %playX1%, %playY1%, %playX2%, %playY2%, 0x66DF51, 50, Fast RGB
    if (!ErrorLevel) {
        UpdateStatus("Play button found at " elapsed "s")
        Break
    }
    if (elapsed >= 30) {
        UpdateStatus("Play button timeout, full restart")
        Goto FullRestart
    }
    Sleep, 1000
}

Sleep, 500
UpdateStatus("Game loaded — checking auto-skip")
CheckAutoSkip()
SleepWithStop(3000)

WinGet, robloxID, ID, ahk_exe RobloxPlayerBeta.exe
if (!robloxID)
    WinGet, robloxID, ID, ahk_class Chrome_WidgetWin_1

; --- Activate window ---
UpdateStatus("Starting Game")
WinActivate, ahk_exe RobloxPlayerBeta.exe
Sleep, 500
if (!WinExist("ahk_exe RobloxPlayerBeta.exe")) {
    WinActivate, ahk_class Chrome_WidgetWin_1
    Sleep, 500
}

; --- Lobby clicks ---
x1 := Round(80  * scaleFactor) , y1 := Round(813  * scaleFactor)
x2 := Round(480 * scaleFactor) , y2 := Round(1131 * scaleFactor)
x3 := Round(468 * scaleFactor) , y3 := Round(571  * scaleFactor)
x4 := Round(427 * scaleFactor) , y4 := Round(541  * scaleFactor)
x5 := Round(327 * scaleFactor) , y5 := Round(1131 * scaleFactor)

MouseClick, left, %x1%, %y1%
Sleep, 1000
CheckForStop()
MouseClick, left, %x2%, %y2%
Sleep, 1000
CheckForStop()
MouseClick, left, %x3%, %y3%
Sleep, 1000
CheckForStop()

; --- Map selection ---
; Castle Town is the game's default selection, so it skips straight to the
; next click. Other maps: click the Maps tab, then find the map's tile in the
; scrollable list (SelectMapTile — OCR the tile titles, scrolling as needed).
if (selectedMap != "Castle Town") {
    UpdateStatus("Selecting map: " . selectedMap)
    mapsTabX := Round(1119 * scaleFactor)
    mapsTabY := Round(349  * scaleFactor)
    MouseClick, left, %mapsTabX%, %mapsTabY%
    Sleep, 1000
    CheckForStop()
    if (!SelectMapTile(selectedMap)) {
        UpdateStatus("Could not find map '" . selectedMap . "' — full restart")
        Goto FullRestart
    }
    UpdateStatus("Map selected: " . selectedMap)
    Sleep, 1000
    CheckForStop()
}

MouseClick, left, %x4%, %y4%
Sleep, 1000
CheckForStop()
MouseClick, left, %x5%, %y5%
Sleep, 1000
SleepWithStop(10000)

; --- Wait for ready button ---
readyX      := Round(1135 * scaleFactor)
readyY      := Round(1174 * scaleFactor)
readyRadius := 5
readyX1     := readyX - readyRadius
readyY1     := readyY - readyRadius
readyX2     := readyX + readyRadius
readyY2     := readyY + readyRadius

mapCheckX := Round(1051 * scaleFactor)
mapCheckY := Round(59   * scaleFactor)
mapColor  := 0x7FCE34

start2 := A_TickCount
Loop {
    CheckForStop()
    elapsed2 := Floor((A_TickCount - start2) / 1000)
    UpdateStatus("Waiting for ready button (" elapsed2 "s)")
    PixelSearch, FoundX2, FoundY2, %readyX1%, %readyY1%, %readyX2%, %readyY2%, 0x66DF51, 50, Fast RGB
    if (!ErrorLevel) {
        UpdateStatus("Ready button found at " elapsed2 "s")
        Sleep, 2000
        MouseClick, left, %readyX%, %readyY%

        ; Wait for map to load
        startMap := A_TickCount
        Loop {
            CheckForStop()
            PixelGetColor, mapPixel, %mapCheckX%, %mapCheckY%, RGB
            if ((mapPixel & 0xFFFFFF) = mapColor) {
                UpdateStatus("Map loaded")
                Break
            }
            elapsedMap := Floor((A_TickCount - startMap) / 1000)
            if (elapsedMap >= 30) {
                UpdateStatus("Map load timeout")
                Break
            }
            Sleep, 1000
        }
        Break
    }
    if (elapsed2 >= 30) {
        UpdateStatus("Ready button timeout, full restart")
        Goto FullRestart
    }
    Sleep, 1000
}

; ============================================================
;  PLACEMENT SETUP
; ============================================================

UpdateStatus("Gathering Mana")
manaStart := A_TickCount
manaDead  := 0
Loop {
    CheckForStop()
    if (!RobloxAlive()) {
        manaDead += 1
        if (manaDead >= 3) {
            UpdateStatus("Roblox closed while gathering mana — restarting")
            Goto FullRestart
        }
    } else {
        manaDead := 0
    }
    if (Floor((A_TickCount - manaStart) / 1000) >= 30)
        Break
    Sleep, 1000
}
PreparePlacementView()

closeHeroX := Round(1889 * scaleFactor)
closeHeroY := Round(320  * scaleFactor)

; ============================================================
;  PHASE 1 — PLACE BOTH HEROES, THEN CONFIRM VIA CARD SLOTS
;  Run the placement sequence for BOTH heroes (Kart Kid = hotkey 1,
;  Slime King = hotkey 2), then open the hero menu once and check the
;  two hero-card slots. A slot reading its logged "used up" color means
;  that hero is placed; both used up = both heroes on the field.
;  Card-slot coords + "placed" colors were captured with PixelInspector.
; ============================================================

; A placed hero greys its card slot out (~0x575857). An EMPTY slot is
; transparent, so its color depends on the background and can't be matched —
; we therefore only detect the grey "filled" state (grey = placed, anything
; else = not placed). Coords are real grey samples logged with PixelInspector.
card1X := Round(1872 * scaleFactor)   ; slot 1 (Kart Kid, placed first)
card1Y := Round(422  * scaleFactor)
card2X := Round(1870 * scaleFactor)   ; slot 2 (Slime King, placed second)
card2Y := Round(516  * scaleFactor)
CARD_GREY := 0x575857                  ; grey shown on a filled/used card slot
CARD_TOL  := 24                        ; per-channel color tolerance

placed1 := false
placed2 := false
placeAttempts    := 0
maxPlaceAttempts := 10

Loop {
    CheckForStop()
    if (placeAttempts >= maxPlaceAttempts) {
        UpdateStatus("Hero placement failed, full restart")
        Goto FullRestart
    }
    placeAttempts += 1

    ; Run the placement sequence for whichever heroes aren't confirmed yet.
    if (!placed1) {
        UpdateStatus("Placing Kart Kid (attempt " placeAttempts ")")
        Send, 1
        Sleep, 500
        RandomPlaceClicks()
    }
    if (!placed2) {
        UpdateStatus("Placing Slime King (attempt " placeAttempts ")")
        Send, 2
        Sleep, 500
        RandomPlaceClicks()
    }

    ; Deselect, then open the hero menu to confirm placement.
    Send, 2
    Sleep, 300
    Send, n
    Sleep, 2000

    ; Scan a short vertical strip around each logged point so a few px of drift
    ; still catches the grey trim of a filled card.
    placed1 := SlotFilledGrey(card1X, card1Y, CARD_GREY, CARD_TOL)
    placed2 := SlotFilledGrey(card2X, card2Y, CARD_GREY, CARD_TOL)

    ; Log the center colors seen so the references can be tuned if needed.
    PixelGetColor, c1, %card1X%, %card1Y%, RGB
    PixelGetColor, c2, %card2X%, %card2Y%, RGB
    h1 := Format("0x{:06X}", c1 & 0xFFFFFF)
    h2 := Format("0x{:06X}", c2 & 0xFFFFFF)
    UpdateStatus("Cards: s1 " h1 " (" (placed1 ? "placed" : "empty") "), s2 " h2 " (" (placed2 ? "placed" : "empty") ")")

    if (placed1 && placed2) {
        UpdateStatus("Both heroes placed")
        Break
    }

    ; Close the menu before retrying the placement sequence.
    MouseClick, left, %closeHeroX%, %closeHeroY%
    Sleep, 1000
}

; ============================================================
;  SLOT DETECTION
;  The hero menu can put Slime King in slot 1 or slot 2. Primary: OCR the
;  slot-1 row title ("Slime King x1" / "Kart Kid x1"). Fallback (OCR
;  unavailable): white pixel at the logged spot = Slime King in slot 1.
;  The pixel probe alone proved unreliable at 1080p — it sits at the very
;  edge of the title text and lands on grey background there.
; ============================================================

row1Title := OcrHeroRowTitle()
if (InStr(row1Title, "Slime")) {
    slimeSlot := 1
} else if (InStr(row1Title, "Kart")) {
    slimeSlot := 2
} else {
    slimeCheckX := Round(1069 * scaleFactor)
    slimeCheckY := Round(425  * scaleFactor)
    PixelGetColor, slotCheckColor, %slimeCheckX%, %slimeCheckY%, RGB
    if (ColorClose(slotCheckColor, 0xFFFFFF, 24))
        slimeSlot := 1
    else
        slimeSlot := 2
}
kartSlot := (slimeSlot = 1) ? 2 : 1
UpdateStatus("Slots — Slime King: slot " slimeSlot ", Kart Kid: slot " kartSlot)

; ============================================================
;  PHASE 2 — UPGRADE BOTH HEROES (slot-1 hero first, until maxed)
; ============================================================

; Upgrade-button coords + IsMaxed row offset per slot (slot 1 = top row).
slot1UpX := Round(1262 * scaleFactor), slot1UpY := Round(425 * scaleFactor)
slot2UpX := Round(1327 * scaleFactor), slot2UpY := Round(512 * scaleFactor)
slot2OffsetY := Round(87 * scaleFactor)

if (slimeSlot = 1) {
    ; Slime King in slot 1 -> upgrade Slime King first, then Kart Kid.
    UpgradeHeroUntilMaxed(slot1UpX, slot1UpY, 0,            60, 210, "Slime King (slot 1)")
    UpgradeHeroUntilMaxed(slot2UpX, slot2UpY, slot2OffsetY, 60, 180, "Kart Kid (slot 2)")
} else {
    ; Kart Kid in slot 1 -> upgrade Kart Kid first, then Slime King.
    UpgradeHeroUntilMaxed(slot1UpX, slot1UpY, 0,            60, 180, "Kart Kid (slot 1)")
    UpgradeHeroUntilMaxed(slot2UpX, slot2UpY, slot2OffsetY, 60, 210, "Slime King (slot 2)")
}

; A disconnect during upgrades trips this flag — rejoin instead of pressing on.
if (robloxDead)
    Goto FullRestart

; ============================================================
;  PHASE 3 — WAIT FOR MAP COMPLETION
; ============================================================

MouseClick, left, %closeHeroX%, %closeHeroY%
Sleep, 500
UpdateStatus("Waiting for map completion")
SleepWithStop(10000)

mapCompleteX := Round(1641 * scaleFactor)
mapCompleteY := Round(641  * scaleFactor)
returnX      := Round(1535 * scaleFactor)
returnY      := Round(995  * scaleFactor)

consecutiveMatches := 0
mapDead := 0
Loop {
    CheckForStop()

    ; Auto-rejoin if Roblox drops while we wait for the map to finish.
    if (!RobloxAlive()) {
        mapDead += 1
        if (mapDead >= 3) {
            UpdateStatus("Roblox closed before map finished — restarting")
            Goto FullRestart
        }
        Sleep, 1000
        continue
    }
    mapDead := 0

    PixelGetColor, mapCompleteColor, %mapCompleteX%, %mapCompleteY%, RGB
    if ((mapCompleteColor & 0xFFFFFF) = 0x7FCE34)
        consecutiveMatches += 1
    else
        consecutiveMatches := 0

    if (consecutiveMatches >= 3) {
        UpdateStatus("Map completed")
        Break
    }
    Sleep, 1000
}

; Round cleared — bump the counter shown in the overlay.
roundsCompleted += 1
WriteStats()

; Hold the "Game Complete" dialog briefly so the app can OCR the coins/XP
; rewards off it (main.js triggers the capture on the "Map completed" status).
SleepWithStop(4000)

MouseClick, left, %returnX%, %returnY%
Sleep, 5000
Goto RestartGame

; ============================================================
;  IDLE LOOP
; ============================================================

FileDelete, %macroRunningFile%
Loop {
    CheckForStop()
    Sleep, 1000
}
