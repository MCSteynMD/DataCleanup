# Build a portable Windows package + Setup installer for managers (no Python required).
# Prerequisites: Inno Setup 6 (ISCC.exe) — https://jrsoftware.org/isinfo.php
# Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File .\build_package.ps1
#
# Outputs:
#   dist\SimilarityParser_Setup.exe          ← send this to managers
#   dist\SimilarityParser_for_manager.zip    ← portable fallback
#   dist\SimilarityParser\                   ← assembled folder

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> Installing build dependencies..."
python -m pip install -r requirements.txt pyinstaller | Out-Host

$distRoot = Join-Path $PSScriptRoot "dist"
$pkgRoot = Join-Path $distRoot "SimilarityParser"
$reviewBuild = Join-Path $distRoot "review_build"
$engineBuild = Join-Path $distRoot "engine_build"
$zipPath = Join-Path $distRoot "SimilarityParser_for_manager.zip"
$setupPath = Join-Path $distRoot "SimilarityParser_Setup.exe"
$issPath = Join-Path $PSScriptRoot "installer\SimilarityParser.iss"

$workReview = Join-Path $distRoot "work_review"
$workEngine = Join-Path $distRoot "work_engine"
$specDir = Join-Path $distRoot "spec"

Write-Host "==> Cleaning previous package..."
foreach ($p in @($pkgRoot, $reviewBuild, $engineBuild, $workReview, $workEngine, $specDir, $zipPath, $setupPath)) {
  if (Test-Path $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}

function Find-ISCC {
  $candidates = @(
    (Get-Command ISCC -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  return $null
}

New-Item -ItemType Directory -Path $pkgRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $pkgRoot "input") | Out-Null

# Heavy optional stacks (especially for Review — keep Qt lean).
$commonExclude = @(
  "--exclude-module", "torch",
  "--exclude-module", "torchvision",
  "--exclude-module", "torchaudio",
  "--exclude-module", "tensorflow",
  "--exclude-module", "sklearn",
  "--exclude-module", "scipy",
  "--exclude-module", "matplotlib",
  "--exclude-module", "IPython",
  "--exclude-module", "notebook",
  "--exclude-module", "pytest",
  "--exclude-module", "pandas.tests"
)

# Review GUI no longer imports pandas — strip these so cold start isn't loading 150MB+.
$reviewExclude = $commonExclude + @(
  "--exclude-module", "pandas",
  "--exclude-module", "numpy",
  "--exclude-module", "pyarrow",
  "--exclude-module", "PIL",
  "--exclude-module", "Pillow",
  "--exclude-module", "cryptography",
  "--exclude-module", "lxml",
  "--exclude-module", "sklearn",
  "--exclude-module", "scipy"
)

function Assert-LastExit {
  param([string]$Step)
  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

# Windowed (no attached console). Startup failures are handled by Start Review.bat
# checks + review_crash.log / MessageBox in review_gui.py.
Write-Host "==> Building Similarity Review (onedir)..."
python -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --name "Similarity Review" `
  --distpath $reviewBuild `
  --workpath $workReview `
  --specpath $specDir `
  --hidden-import "PySide6.QtCore" `
  --hidden-import "PySide6.QtGui" `
  --hidden-import "PySide6.QtWidgets" `
  --hidden-import "openpyxl" `
  @reviewExclude `
  "review_gui.py"
Assert-LastExit "Similarity Review build"

Write-Host "==> Building Similarity Engine (onedir)..."
$engineExclude = $commonExclude + @(
  "--exclude-module", "pyarrow",
  "--exclude-module", "PIL",
  "--exclude-module", "Pillow"
)
python -m PyInstaller `
  --noconfirm `
  --clean `
  --console `
  --name "Similarity Engine" `
  --distpath $engineBuild `
  --workpath $workEngine `
  --specpath $specDir `
  @engineExclude `
  "similarity.py"
Assert-LastExit "Similarity Engine build"

Write-Host "==> Assembling package folder..."
Copy-Item -Recurse -Force (Join-Path $reviewBuild "Similarity Review") (Join-Path $pkgRoot "Review")
Copy-Item -Recurse -Force (Join-Path $engineBuild "Similarity Engine") (Join-Path $pkgRoot "Engine")

$bat = @"
@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo  Similarity Review
echo  -----------------
echo  Preparing to launch...
echo.

echo %CD% | find /I "\Downloads\" >nul
if not errorlevel 1 (
  echo WARNING: This folder is inside Downloads.
  echo Windows often blocks the analysis engine there.
  echo Better: move SimilarityParser to Desktop, then run this bat again.
  echo.
)

if not exist "%~dp0Review\Similarity Review.exe" (
  echo ERROR: Review\Similarity Review.exe was not found.
  echo.
  echo Extract the FULL zip to a folder first ^(do not run from inside the zip^).
  echo Expected:
  echo   SimilarityParser\
  echo     Start Review.bat
  echo     Review\Similarity Review.exe
  echo     Engine\Similarity Engine.exe
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0Review\_internal\PySide6\plugins\platforms\qwindows.dll" (
  echo ERROR: Qt platform plugin missing. The zip extract is incomplete.
  echo Re-download, then right-click the zip -^> Properties -^> Unblock -^> Extract again.
  echo.
  pause
  exit /b 1
)

REM Unblock Review + Engine binaries Windows may mark as "downloaded".
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$paths=@('%~dp0Review\Similarity Review.exe','%~dp0Engine\Similarity Engine.exe'); foreach($p in $paths){ if(Test-Path -LiteralPath $p){ Unblock-File -LiteralPath $p -EA SilentlyContinue } }; Get-ChildItem -LiteralPath '%~dp0Engine' -Recurse -Include *.exe,*.dll,*.pyd -EA SilentlyContinue | Unblock-File -EA SilentlyContinue" >nul 2>&1

set "QT_PLUGIN_PATH=%~dp0Review\_internal\PySide6\plugins"
set "QT_OPENGL=software"

echo  Launching Similarity Review.exe ...
echo.

start "" /D "%~dp0Review" "%~dp0Review\Similarity Review.exe"

REM Brief check that the process actually started.
timeout /t 2 /nobreak >nul
tasklist /FI "IMAGENAME eq Similarity Review.exe" | find /I "Similarity Review.exe" >nul
if errorlevel 1 (
  echo.
  echo ERROR: Similarity Review did not stay running.
  echo.
  if exist "%~dp0review_boot.log" (
    echo --- review_boot.log ---
    type "%~dp0review_boot.log"
    echo.
  )
  if exist "%~dp0review_crash.log" (
    echo --- review_crash.log ---
    type "%~dp0review_crash.log"
    echo.
  )
  echo Try: right-click the zip -^> Properties -^> Unblock, extract again,
  echo then run this bat from the extracted folder ^(not from inside the zip^).
  echo.
  pause
  exit /b 1
)

exit /b 0
"@
Set-Content -Path (Join-Path $pkgRoot "Start Review.bat") -Value $bat -Encoding ASCII

$readme = @"
Similarity Parser - Manager Package
===================================

Recommended: use SimilarityParser_Setup.exe
-------------------------------------------
1. Double-click SimilarityParser_Setup.exe.
2. Install to the default folder (Program Files).
3. Open Start Menu -> Similarity Parser.
4. On first launch, choose your product Excel (e.g. FOExport.xlsx).
5. Use the app:
   - Results...  = open an existing similarity_results*.xlsx
   - Input...    = pick a product Excel file, run analysis, then review
   - Reports     = management summary; Export Excel... for superiors
   - Dark        = toggle dark mode

Portable zip (fallback)
-----------------------
1. Right-click the zip -> Properties -> if you see Unblock, tick it -> Apply -> OK.
2. Extract to Desktop (NOT Downloads - Windows often blocks apps there).
3. Open the SimilarityParser folder and double-click Start Review.bat.

If it does not open / Access denied
-----------------------------------
- Prefer the Setup installer, or move the folder out of Downloads to Desktop.
- Confirm Review\Similarity Review.exe exists (email sometimes strips .exe files).
- Confirm Review\_internal\ and Engine\ folders are present (incomplete extract).
- If a message box or review_crash.log appears, send that back.

Workflow
--------
- Review tab: compare each candidate to the reference, mark Duplicate / Unique /
  Discard, or Unreview (U) to clear a decision.
- Reports tab: KPIs, duplicate list, cluster progress, Excel export.

Files
-----
- Start Review.bat          launches the reviewer (portable)
- Review\                   review application
- Engine\                   similarity engine (used by Input...)
- input\                    optional drop folder for product Excels

Notes
-----
- No Python install is required.
- Progress and Input... results are stored under your user AppData folder
  (%LOCALAPPDATA%\SimilarityParser) so a Program Files install stays writable.
"@
Set-Content -Path (Join-Path $pkgRoot "README_for_manager.txt") -Value $readme -Encoding ASCII

Write-Host "==> Creating zip (portable fallback)..."
Compress-Archive -Path $pkgRoot -DestinationPath $zipPath -Force

Write-Host "==> Building Windows installer (Inno Setup)..."
$iscc = Find-ISCC
if (-not $iscc) {
  Write-Host ""
  Write-Host "ERROR: Inno Setup compiler (ISCC.exe) was not found."
  Write-Host "  1. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php"
  Write-Host "  2. Re-run: powershell -ExecutionPolicy Bypass -File .\build_package.ps1"
  Write-Host ""
  Write-Host "Portable zip was still created: $zipPath"
  throw "Inno Setup not installed (ISCC.exe missing)"
}

& $iscc $issPath
Assert-LastExit "Inno Setup compile"
if (-not (Test-Path $setupPath)) {
  throw "Expected installer was not created: $setupPath"
}

Write-Host ""
Write-Host "Done."
Write-Host "  Package folder: $pkgRoot"
Write-Host "  Zip (fallback): $zipPath"
Write-Host "  Installer:      $setupPath"
Write-Host "  Send managers:  $setupPath"
