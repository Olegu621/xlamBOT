"""Мастер первой настройки xlamBOT.

Запускается один раз, при первом старте собранной программы, и проверяет по
порядку то, без чего бот не заработает:

1. Наличие ADB. Без него нельзя увидеть ни эмулятор, ни телефон.
2. Видимое устройство. Пустой список - самая частая причина, по которой
   новичок думает, что программа сломана.
3. Разрешение экрана. Модели обучены на 1920x1080; на другом размере
   координаты игровых кнопок не совпадут и бот будет промахиваться.
4. Установленная игра и её пакет.
5. Нужны ли файлы модели - если их нет, предупреждаем, потому что без
   детектора газа бот играет заметно хуже.

Мастер ничего не меняет сам, кроме сохранения найденного пакета игры: все
остальные подсказки он показывает и предлагает применить из панели.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import utils

EXPECTED_WIDTH = 1920
EXPECTED_HEIGHT = 1080

# Игра: официальная и приватные сборки. Пользователь выбирает из найденных.
KNOWN_PACKAGES = ("com.supercell.brawlstars", "bsd.suitcase.release")
PRIVATE_PREFIX = "bsd.suitcase."


def title(text: str) -> None:
    print(f"\n{text}\n" + "-" * len(text))


def adb_path() -> str | None:
    """Путь к adb: сначала из окружения, потом из пакета adbutils."""
    from shutil import which

    found = which("adb")
    if found:
        return found
    try:
        import adbutils

        return str(adbutils.adb_path())
    except Exception:
        pass
    root = Path(utils.PROJECT_ROOT) / ".venv"
    for candidate in root.glob("**/adb.exe"):
        return str(candidate)
    return None


def run_adb(adb: str, *args: str, timeout: int = 20) -> str:
    try:
        proc = subprocess.run(
            [adb, *args],
            capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return proc.stdout.strip()
    except Exception:
        return ""


def check_adb() -> str | None:
    title("1. ADB")
    adb = adb_path()
    if not adb:
        print("  Не найден. Установите Android SDK Platform Tools и перезапустите.")
        print("  Скачать: https://developer.android.com/tools/releases/platform-tools")
        return None
    print(f"  Найден: {adb}")
    if "daemon" not in run_adb(adb, "start-server"):
        # start-server печатает либо список устройств, либо ошибку; не считаем это
        # поломкой, продолжаем: следующая проверка всё покажет честнее.
        pass
    return adb


def list_devices(adb: str) -> list[tuple[str, str]]:
    title("2. Устройства")
    out = run_adb(adb, "devices", "-l")
    devices: list[tuple[str, str]] = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            model = ""
            for token in parts:
                if token.startswith("model:"):
                    model = token.split(":", 1)[1]
            devices.append((parts[0], model))
    if not devices:
        print("  Устройств нет. Что делать:")
        print("   - эмулятор: запустите его и дождитесь загрузки;")
        print("   - телефон: включите отладку по USB и подтвердите её на экране;")
        print("   - по сети: выполните «adb pair» и «adb connect», как в подсказке панели.")
        return []
    print(f"  Найдено {len(devices)}:")
    for serial, model in devices:
        print(f"    {serial}  {model}")
    return devices


def check_resolution(adb: str, serial: str) -> tuple[int, int] | None:
    title(f"3. Разрешение экрана ({serial})")
    out = run_adb(adb, "-s", serial, "shell", "wm", "size")
    size = None
    for token in out.replace(":", " ").split():
        if "x" in token and token.replace("x", "").isdigit():
            parts = token.split("x")
            if len(parts) == 2:
                size = (int(parts[0]), int(parts[1]))
                break
    if not size:
        print("  Не удалось определить. Проверьте вручную: Настройки → О телефоне.")
        return None
    print(f"  Сейчас: {size[0]}x{size[1]}")
    if size == (EXPECTED_WIDTH, EXPECTED_HEIGHT):
        print("  Верно, бот будет работать точно по координатам.")
    else:
        print(f"  Нужно {EXPECTED_WIDTH}x{EXPECTED_HEIGHT}, иначе бот промахивается.")
        print("  Либо вручную: adb -s %s shell wm size %sx%s"
              % (serial, EXPECTED_WIDTH, EXPECTED_HEIGHT))
    return size


def check_game(adb: str, serial: str) -> str | None:
    title(f"4. Игра ({serial})")
    out = run_adb(adb, "-s", serial, "shell", "pm", "list", "packages")
    packages = [line.strip() for line in out.splitlines() if line.strip()]
    games = [p for p in packages if p.startswith("package:")]
    games = [p[len("package:"):] for p in games]
    found = [p for p in games
             if p in KNOWN_PACKAGES or p.startswith(PRIVATE_PREFIX)]

    if found:
        print("  Установлена:")
        for p in found:
            print(f"    {p}")
        package = found[0]
        print(f"  Бот будет использовать пакет {package}")
        return package

    print("  Brawl Stars не найдена.")
    print("  Установите игру и вернитесь к мастеру.")
    return None


def check_models() -> bool:
    title("5. Файлы модели")
    needed = {
        "gasDetector.onnx": "детектор газа",
        "mainInGameModel.onnx": "поиск игроков и объектов",
        "tileDetector.onnx": "чтение поля",
        "closeTileDetector.onnx": "ближние клетки",
    }
    models = Path(utils.PROJECT_ROOT) / "models"
    missing = []
    for name, purpose in needed.items():
        path = models / name
        if path.is_file():
            print(f"  есть  {name:26} {purpose}")
        else:
            print(f"  НЕТ   {name:26} {purpose}")
            missing.append(name)
    if missing:
        print("\n  Бот запустится, но без этих моделей играет заметно хуже.")
        print("  Файлы лежат в папке models рядом с программой.")
        return False
    return True


def save_package(package: str) -> bool:
    """Записывает найденный пакет в general_config.toml."""
    path = Path(utils.resolve_project_path("cfg", "general_config.toml"))
    try:
        import toml

        data = toml.loads(path.read_text(encoding="utf-8"))
        if data.get("brawl_stars_package") == package:
            return True
        data["brawl_stars_package"] = package
        path.write_text(
            toml.dumps(data), encoding="utf-8")
        print(f"  Записал пакет игры в {path.name}: {package}")
        return True
    except Exception as error:
        print(f"  Не смог сохранить пакет: {error}")
        print("  Укажите его вручную в панели: Настройки → Бот.")
        return False


def main() -> int:
    print("=" * 64)
    print("  xlamBOT - мастер настройки")
    print("=" * 64)

    adb = check_adb()
    if not adb:
        print("\nБез ADB дальше идти некуда.")
        return 1

    devices = list_devices(adb)
    if not devices:
        print("\nУстройство не найдено - разберитесь с ним и запустите ещё раз.")
        return 1

    serial = devices[0][0]
    if len(devices) > 1:
        print(f"\n  Устройств несколько. Для проверки берём первое: {serial}")
        print("  В панели можно выбрать другое.")

    check_resolution(adb, serial)
    package = check_game(adb, serial)
    models_ok = check_models()

    title("Итог")
    print(f"  ADB:              {'найден' if adb else 'нет'}")
    print(f"  Устройство:        {serial}")
    print(f"  Игра:              {package or 'не найдена'}")
    print(f"  Модели:            {'все на месте' if models_ok else 'не хватает части'}")

    if package:
        save_package(package)

    print()
    print("  Дальше:")
    print("   - откройте панель, в ней виден статус и кнопка «Старт»;")
    print("   - если что-то не так, откройте логи в карточке устройства;")
    print("   - вопросы и обновления: https://t.me/xlamModz")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())