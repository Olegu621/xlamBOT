<#
  Сборка xlamBOT: программа, затем установщик.

    powershell -ExecutionPolicy Bypass -File install.ps1

  Что делает:
    1. переносимый Tesseract кладётся в vendor\tesseract, если его там нет
       (в репозитории его нет - это чужая сборка на 163 МБ);
    2. PyInstaller собирает dist\xlamBOT;
    3. Inno Setup собирает dist\xlamBOT-Setup-<версия>.exe.

  Что нужно на машине сборщика: Python с зависимостями проекта и Inno Setup 6.
#>

[CmdletBinding()]
param(
    # Пропустить PyInstaller и собрать установщик из текущего dist\xlamBOT
    [switch]$InstallerOnly
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$ProjectRoot = $PSScriptRoot
$DistDir = Join-Path $ProjectRoot 'dist'
$AppDir = Join-Path $DistDir 'xlamBOT'

function Write-Step($text) {
    Write-Host ''
    Write-Host "== $text" -ForegroundColor Cyan
}

function Get-Version {
    # Версия живёт в spec, чтобы не расходилась между exe и установщиком.
    $spec = Get-Content (Join-Path $ProjectRoot 'xlambot.spec') -Raw
    if ($spec -match 'version\s*=\s*["'']([0-9][^"'']*)["'']') { return $Matches[1] }
    return '1.0.0'
}

# ── 1. переносимый Tesseract ────────────────────────────────────────────────
function Ensure-Tesseract {
    $target = Join-Path $ProjectRoot 'vendor\tesseract'
    if (Test-Path (Join-Path $target 'tesseract.exe')) {
        Write-Step "Tesseract уже на месте: $target"
        return
    }

    $sources = @(
        'C:\Program Files\Tesseract-OCR',
        'C:\Program Files (x86)\Tesseract-OCR',
        (Join-Path $env:LOCALAPPDATA 'Programs\Tesseract-OCR')
    )
    $source = $sources | Where-Object { Test-Path (Join-Path $_ 'tesseract.exe') } | Select-Object -First 1
    if (-not $source) {
        throw 'Tesseract не найден. Установите его (https://github.com/UB-Mannheim/tesseract/wiki) и запустите скрипт снова.'
    }

    Write-Step "Копирую Tesseract из $source"
    New-Item -ItemType Directory -Force -Path $target, (Join-Path $target 'tessdata') | Out-Null

    # Только то, что нужно для распознавания цифр: exe, библиотеки и eng.
    # Инструменты обучения (lstmtraining, mftraining и прочее) весят десятки
    # мегабайт и в рантайме не используются.
    Get-ChildItem $source -File | Where-Object { $_.Extension -in '.dll', '.exe' } |
        Where-Object { $_.Name -eq 'tesseract.exe' } |
        ForEach-Object { Copy-Item $_.FullName $target -Force }
    Get-ChildItem $source -File -Filter '*.dll' | ForEach-Object { Copy-Item $_.FullName $target -Force }
    foreach ($name in @('eng.traineddata', 'eng.user-patterns', 'eng.user-words')) {
        $file = Join-Path $source "tessdata\$name"
        if (Test-Path $file) { Copy-Item $file (Join-Path $target 'tessdata') -Force }
    }

    $size = [math]::Round(((Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
    Write-Host "  готово: $size МБ" -ForegroundColor Green
}

# ── 2. программа ────────────────────────────────────────────────────────────
function Build-App {
    Write-Step 'Собираю очередь бойцов по умолчанию'
    # Файл не в репозитории и без него на старте пусто, а играть нечем.
    & (Join-Path $ProjectRoot '.venv\Scripts\python.exe') `
        (Join-Path $ProjectRoot 'tools_make_default_queue.py')
    if ($LASTEXITCODE -ne 0) { throw "Очередь бойцов не собралась" }

    Write-Step 'Собираю программу (PyInstaller)'
    if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
    & (Join-Path $ProjectRoot '.venv\Scripts\python.exe') -m PyInstaller `
        (Join-Path $ProjectRoot 'xlambot.spec') --noconfirm --clean
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller упал с кодом $LASTEXITCODE" }
    if (-not (Test-Path (Join-Path $AppDir 'xlamBOT.exe'))) { throw 'xlamBOT.exe не появился в dist' }

    $queue = Join-Path $AppDir '_internal\latest_brawler_data.json'
    if (-not (Test-Path $queue)) {
        throw 'В сборке нет очереди бойцов'
    }
    # Считаем через ConvertFrom-Json, а не через @( ... ).Count: обёртка
    #PowerShell вокруг результата конвертации ведёт себя по-разному в 5.1 и 7,
    #и из-за этого проверка молча показывала не то число.
    $parsed = Get-Content $queue -Raw -Encoding UTF8 | ConvertFrom-Json
    $count = @($parsed).Length
    Write-Host "  очередь в сборке: $count бойцов" -ForegroundColor Green
    if ($count -lt 50) {
        throw "В сборке всего $count бойцов - очередь собралась неверно"
    }

    # Таблица бойцов: без неё play.py не находит ни одного бойца. Раньше её
    # теряли вместе с match_history, потому что фильтровали по *.toml.
    $table = Join-Path $AppDir '_internal\cfg\brawlers_info.json'
    if (-not (Test-Path $table)) {
        throw 'В сборке нет cfg/brawlers_info.json - бот не будет знать бойцов'
    }
    # Имена бойцов достаём в список и только потом считаем: @(...).Length даёт
    # число, а не сам список, и -notcontains потом сравнивал число со строкой,
    # объявляя неизвестными все бойцы подряд.
    $known = @((Get-Content $table -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties.Name)
    if ($known.Count -lt 50) {
        throw "Таблица бойцов выглядит пустой: $($known.Count) имён"
    }
    $unknown = @($parsed | Where-Object { $known -notcontains $_.brawler })
    Write-Host "  таблица бойцов: $($known.Count), неизвестных имён в очереди: $($unknown.Count)" -ForegroundColor Green
    if ($unknown.Count -gt 0) {
        $names = ($unknown | Select-Object -First 5 | ForEach-Object { $_.brawler }) -join ', '
        throw "В очереди $($unknown.Count) имён, которых нет в таблице бойцов: $names"
    }

    # Личные файлы в сборку попадать не должны. Кадры для обучения gasDetector
    # из них потом и учат - это чужие игры и чужие трофеи конкретного аккаунта,
    # и в публичный установщик им тоже нельзя.
    $leaks = Get-ChildItem (Join-Path $AppDir '_internal') -Recurse -File -EA SilentlyContinue |
        Where-Object { $_.Name -match 'match_history|cfg\.zip|account_state|session\.json|frame_\d{4}' }
    if ($leaks) {
        throw "В сборку попали личные файлы: $((($leaks | Select-Object -First 5).Name) -join ', ')"
    }
    $leakDir = Join-Path $AppDir '_internal\training'
    if (Test-Path $leakDir) {
        throw "В сборку попала папка training с кадрами для обучения: $leakDir"
    }
    Write-Host "  личных файлов нет, кадров обучения нет" -ForegroundColor Green

    $size = [math]::Round(((Get-ChildItem $AppDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
    Write-Host "  готово: $size МБ" -ForegroundColor Green
}

# ── 3. установщик ───────────────────────────────────────────────────────────
function Find-Iscc {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $found) { return $null }
    return $found
}

function Build-Installer {
    $iscc = Find-Iscc
    if (-not $iscc) {
        throw 'Inno Setup не найден. Установите: winget install JRSoftware.InnoSetup'
    }

    Write-Step 'Собираю установщик (Inno Setup)'
    & $iscc (Join-Path $ProjectRoot 'installer.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup упал с кодом $LASTEXITCODE" }

    $setup = Get-ChildItem $DistDir -Filter 'xlamBOT-Setup-*.exe' |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $setup) { throw 'Установщик не появился в dist' }

    Write-Host ''
    Write-Host "Готово: $($setup.FullName)" -ForegroundColor Green
    Write-Host "Размер: $([math]::Round($setup.Length / 1MB, 1)) МБ" -ForegroundColor Green
}

# ── main ────────────────────────────────────────────────────────────────────
Ensure-Tesseract
if (-not $InstallerOnly) { Build-App }
Build-Installer