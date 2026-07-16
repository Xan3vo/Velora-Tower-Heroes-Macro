; ============================================================
;  Tower Heroes — Pixel Inspector (calibration helper)
; ------------------------------------------------------------
;  A tiny standalone tool to capture exact screen coordinates and
;  pixel colors from the live game, so macro pixel-checks (like the
;  hero "maxed" detection) can be calibrated to real values.
;
;  HOW TO USE
;    1. Set your display to the SAME resolution + 100% scale you use
;       when running the macro (so coordinates match the macro).
;    2. Open Roblox / Tower Heroes and get to the state you want to
;       measure (e.g. a hero fully upgraded, hero panel open).
;    3. Double-click this file to run it. A tooltip follows your mouse
;       showing live X, Y and the color under the cursor.
;    4. Hover the exact pixel you care about and press  F8  to log it.
;    5. Repeat for each point. Press  F9  (or Esc) to quit.
;    6. Send the log file:  %A_Temp%\towerheroes-pixels.log
;       (paste its contents — the path is shown on screen too).
; ============================================================

#Requires AutoHotkey v1.1.37
#SingleInstance force
#Persistent
#NoEnv

; Match the macro's coordinate system: DPI-aware, physical pixels,
; screen-relative — so logged coords line up with the macro's coords.
DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
CoordMode, Mouse,   Screen
CoordMode, ToolTip, Screen

logFile     := A_Temp . "\towerheroes-pixels.log"
scaleFactor := A_ScreenWidth / 2560   ; macro coords are calibrated at 2560x1440
logCount    := 0

; Fresh log per session, with a header describing the environment.
FileDelete, %logFile%
FileAppend, === Tower Heroes Pixel Inspector ===`n, %logFile%
FileAppend, Resolution: %A_ScreenWidth%x%A_ScreenHeight%`n, %logFile%
FileAppend, ScaleFactor (vs 2560 baseline): %scaleFactor%`n, %logFile%
FileAppend, Columns: [#] actualX,actualY  ->  baseX,baseY (2560-normalized)  color`n`n, %logFile%

SetTimer, ShowReadout, 60
return

ShowReadout:
    MouseGetPos, mx, my
    PixelGetColor, col, %mx%, %my%, RGB
    hex   := Format("0x{:06X}", col & 0xFFFFFF)
    baseX := Round(mx / scaleFactor)
    baseY := Round(my / scaleFactor)
    tip := "X: " mx "   Y: " my "`n"
         . "base (2560): " baseX ", " baseY "`n"
         . "color: " hex "`n"
         . "logged: " logCount "`n"
         . "-----------------`n"
         . "[F8] log point   [F9] quit"
    ToolTip, %tip%, % mx + 22, % my + 22
return

F8::
    MouseGetPos, mx, my
    PixelGetColor, col, %mx%, %my%, RGB
    hex     := Format("0x{:06X}", col & 0xFFFFFF)
    baseX   := Round(mx / scaleFactor)
    baseY   := Round(my / scaleFactor)
    logCount += 1
    line := "[" logCount "]  " mx "," my "  ->  " baseX "," baseY "  " hex
    FileAppend, %line%`n, %logFile%
    ; Flash a confirmation so it's obvious the point was captured.
    ToolTip, % "LOGGED #" logCount ":`n" line, % mx + 22, % my + 22
    Sleep, 450
return

F9::
Esc::
    FileAppend, `n--- session end (%logCount% points) ---`n, %logFile%
    ToolTip
    ExitApp
return
