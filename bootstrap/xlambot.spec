# -*- mode: python ; coding: utf-8 -*-
"""Сборка xlamBOT в один .exe.

Собирается папкой, а не одним файлом: PyInstaller не умеет складывать в
одну папку то, что внутри лежит как данные - scrcpy-сервер на Java и
несколько моделей по 10 МБ. Поэтому dist/xlamBOT.exe запускает рядом
папку _internal, где эти файлы и лежат. Для пользователя это всё равно один
значок и один двойной клик.

Что важно не потерять при сборке:
* models - четыре .onnx, без них бот играет заметно хуже;
* scrcpy/scrcpy-server.jar - без него не будет связи с устройством;
* images, cfg, playstyles, static, templates, api/assets - панель и поиск
  бойцов;
* easyocr не нужен, OCR идёт через tesseract.
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH)

# Из cfg берём только настройки и таблицу бойцов. Копировать папку целиком
# нельзя: рядом с ними лежит match_history.csv с историей матчей того, кто
# собирал, и cfg.zip с её резервной копией. Всё это уезжало бы к пользователю
# установки вместе с программой. Список строится здесь, на лету, чтобы новый
# файл настроек не забыли.
#
# brawlers_info.json обязателен и не является .toml: без него play.py не
# находит ни одного бойца и сыплет KeyError на каждом шаге.
CFG_FILES = [(str(path), "cfg") for path in sorted(ROOT.glob("cfg/*.toml"))]
BRAWLERS_TABLE = ROOT / "cfg" / "brawlers_info.json"
if not BRAWLERS_TABLE.is_file():
    raise SystemExit("cfg/brawlers_info.json не найден - без него бот не узнает бойцов")
CFG_FILES.append((str(BRAWLERS_TABLE), "cfg"))

# ── данные, которые копируются рядом с программой ─────────────────────────
DATA = [
    *CFG_FILES,
    ("images", "images"),
    ("models", "models"),
    ("playstyles", "playstyles"),
    ("scrcpy", "scrcpy"),
    ("static", "static"),
    ("templates", "templates"),
    ("api/assets", "api/assets"),
    ("vendor/tesseract", "vendor/tesseract"),
    ("LICENSE", "."),
    # Очередь бойцов по умолчанию: без неё собранная программа
    # стартует с пустым списком и отказывается запускать игру.
    ("latest_brawler_data.json", "."),
]

# Файлы, которые PyInstaller не находит сам: их читают по строковому пути.
# Список собран проверкой импорта в конце сборки.
HIDDEN = [
    "onnxruntime",
    "onnxruntime.capi._pybind_state",
    "onnxruntime.capi.onnxruntime_inference_collection",
    "cv2",
    "av",
    "av.video.reformatter",
    "av.audio.resampler",
    "webview",
    "discord",
    "discord.ext.commands",
    "discord.ui.view",
    "discord.ui.select",
    "pytesseract",
    "adbutils",
    "toml",
    "flask",
    "werkzeug",
    "jinja2",
    "pytz",
    "packaging",
    "cryptography",
    "PIL.Image",
    "PIL.ImageDraw",
    "PIL.ImageFont",
    "requests.packages.urllib3",
    "google.protobuf",
    "charset_normalizer",
    "idna",
]

EXCLUDES = [
    # Тяжёлое и неиспользуемое: заметно уменьшает итоговый размер
    "tkinter", "unittest", "pydoc_data", "test",
    "matplotlib", "pandas", "scipy", "IPython", "notebook",
    "easyocr", "torch", "torchvision", "transformers",
    "setuptools", "pip", "wheel", "numpy.f2py",
    "PIL.ImageQt", "PyQt5", "PySide2",
]

a = Analysis(
    ["xlambot_launcher.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=DATA,
    hiddenimports=HIDDEN,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="xlamBOT",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "build_assets" / "xlambot.ico"),
    version=str(ROOT / "build_assets" / "version_info.txt")
    if (ROOT / "build_assets" / "version_info.txt").is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="xlamBOT",
)