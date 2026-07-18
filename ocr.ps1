# ocr.ps1 — read on-screen text via Windows' built-in OCR engine.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File ocr.ps1 -X 1600 -Y 620 -W 240 -H 70 [-Digits]
#   powershell -ExecutionPolicy Bypass -File ocr.ps1 -File C:\path\img.png [-Digits]
#
# Captures a screen rectangle (or reads an image file), runs Windows.Media.Ocr,
# and prints the recognized text to stdout. With -Digits, prints only the digits
# (handy for coin/number reads). Prints nothing (and exits 2) if OCR is
# unavailable on this machine.

param(
    [int]$X = 0,
    [int]$Y = 0,
    [int]$W = 0,
    [int]$H = 0,
    [string]$File = "",
    [string]$OutFile = "",   # write result here instead of stdout (AHK-friendly)
    [string]$SavePng = "",   # also save the RAW capture (pre-upscale) here, for offline recalibration
    [int]$Scale = 3,
    [int]$Pad = 8,
    [switch]$Digits,
    [switch]$NoRetry    # internal: set on self-spawned retry passes
)

$ErrorActionPreference = "Stop"

try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    # Work in PHYSICAL pixels (same convention as the macro and main.js).
    # Without this, Windows DPI-virtualizes CopyFromScreen coordinates at any
    # display scale other than 100% and the capture lands in the wrong place.
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiFix { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
    [DpiFix]::SetProcessDPIAware() | Out-Null

    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

    # --- await helper for WinRT IAsyncOperation<T> in PowerShell 5.1 ---
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    function Await($op, $resultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $task = $asTask.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        return $task.Result
    }

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        [Console]::Error.WriteLine("OCR_UNAVAILABLE: no OCR language pack installed")
        exit 2
    }

    # --- obtain a System.Drawing.Bitmap (from file or screen capture) ---
    if ($File -ne "") {
        $src = New-Object System.Drawing.Bitmap $File
    } else {
        $src = New-Object System.Drawing.Bitmap $W, $H
        $g = [System.Drawing.Graphics]::FromImage($src)
        $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
        $g.Dispose()
    }

    # Keep the raw pixels when asked — a misread can then be reproduced and the
    # region recalibrated offline (crop + re-OCR) instead of nudging blind.
    if ($SavePng -ne "") {
        try { $src.Save($SavePng, [System.Drawing.Imaging.ImageFormat]::Png) } catch {}
    }

    # Upscale (+ a padded margin) and OCR. Small on-screen numbers read far
    # more reliably enlarged, and a margin stops edge glyphs being clipped/lost.
    function Invoke-OcrPass([System.Drawing.Bitmap]$srcBmp, [int]$passScale) {
        if ($passScale -lt 1) { $passScale = 1 }
        $dw = $srcBmp.Width * $passScale + $Pad * 2
        $dh = $srcBmp.Height * $passScale + $Pad * 2
        $bmp = New-Object System.Drawing.Bitmap $dw, $dh
        $g2 = [System.Drawing.Graphics]::FromImage($bmp)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        # Fill the margin with the source's own corner color so contrast is preserved.
        $g2.Clear($srcBmp.GetPixel(0, 0))
        $g2.DrawImage($srcBmp, $Pad, $Pad, ($srcBmp.Width * $passScale), ($srcBmp.Height * $passScale))
        $g2.Dispose()

        # --- Bitmap -> PNG bytes -> WinRT stream -> SoftwareBitmap ---
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $bytes = $ms.ToArray()
        $ms.Dispose()

        $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $writer = New-Object Windows.Storage.Streams.DataWriter $ras
        $writer.WriteBytes($bytes)
        (Await ($writer.StoreAsync()) ([uint32])) | Out-Null
        $writer.DetachStream() | Out-Null
        $ras.Seek(0) | Out-Null

        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

        $result = Await ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
        return $result.Text
    }

    $text = Invoke-OcrPass $src $Scale
    # Windows OCR silently reads NOTHING when the glyphs are right at its size
    # threshold (seen live at 1080p: "Upgrade All MAX" is "" at 3x, perfect at
    # 4x; a bare 2-digit coins number needed 5-6x). An empty read is therefore
    # ambiguous, so climb a retry ladder before giving up. The retries MUST run
    # in a fresh process: after the first RecognizeAsync in a PowerShell
    # process, every further recognize returns empty (verified on identical
    # bitmaps) — so re-invoke this script on the captured pixels instead.
    if ($text -eq "" -and -not $NoRetry) {
        $tmpPng = Join-Path $env:TEMP ("towerheroes-ocr-retry-" + $PID + ".png")
        $src.Save($tmpPng, [System.Drawing.Imaging.ImageFormat]::Png)
        foreach ($retryScale in ($Scale + 2), ($Scale + 3)) {
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -File $tmpPng -Scale $retryScale -NoRetry
            $out = ($out -join ' ').Trim()
            if ($out -ne "") { $text = $out; break }
        }
        Remove-Item $tmpPng -ErrorAction SilentlyContinue
    }
    $src.Dispose()

    if ($Digits) {
        $text = ($text -replace '[^0-9]', '')
    }

    if ($OutFile -ne "") {
        [System.IO.File]::WriteAllText($OutFile, $text)
    } else {
        [Console]::Out.Write($text)
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine("OCR_ERROR: " + $_.Exception.Message)
    if ($OutFile -ne "") {
        try { [System.IO.File]::WriteAllText($OutFile, "") } catch {}
    }
    exit 1
}
