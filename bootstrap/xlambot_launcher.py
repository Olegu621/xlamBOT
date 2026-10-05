"""Точка входа собранной программы xlamBOT.

Задача этого файла - сделать так, чтобы в готовом .exe всё работало без
Python, терминала и настроек. Отсюда три вещи:

1. Каталог ресурсов. В собранной программе файлы лежат во временной папке
   PyInstaller, поэтому пути к моделям, картинкам и настройкам надо уметь
   находить и там. utils.PROJECT_ROOT настроен на это же, но проверяем ещё раз
   и предупреждаем, если что-то не так.

2. Мастер настройки при первом запуске. Если ADB не найден или устройство не
   видно, пользователь должен получить понятный список шагов, а не
   traceback. Запускаем мастер и ждём его завершения.

3. Панель. Поднимаем её на свободном порту, печатаем адрес и открываем браузер.
   На macOS и Linux окно открывает pywebview, на Windows - системный браузер.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser

APP_NAME = "xlamBOT"
VERSION = "0.8.16"
DEFAULT_PORT = 5195
WIZARD_MARKER = "setup_done.json"


def bundled_root() -> str:
    """Каталог ресурсов: временная папка PyInstaller или папка рядом."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return meipass
    return os.path.dirname(os.path.abspath(__file__))


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def free_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 25)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


def data_dir() -> str:
    """Куда складывать настройки пользователя, логи и состояние."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, APP_NAME)


def check_assets(root: str) -> list[str]:
    """Что из необходимого лежит рядом с программой."""
    problems = []
    required = [
        ("cfg", "папка настроек"),
        ("images", "шаблоны экрана"),
        ("models", "файлы моделей"),
        ("playstyles", "плейстайлы"),
        ("scrcpy", "связь с устройством"),
        ("static", "панель"),
        ("templates", "панель"),
    ]
    for name, what in required:
        if not os.path.isdir(os.path.join(root, name)):
            problems.append(f"нет папки {name} - {what}")
    for model in ("mainInGameModel.onnx", "tileDetector.onnx"):
        if not os.path.isfile(os.path.join(root, "models", model)):
            problems.append(f"нет модели {model}")
    return problems


def run_wizard() -> int:
    print("\nЗапускаю мастер настройки.\n")
    try:
        import setup_wizard

        return setup_wizard.main()
    except Exception as error:  # noqa: BLE001
        print(f"Мастер настройки не отработал: {error}")
        print("Разбираться можно в панели: статус устройства и логи.")
        return 1


def open_ui(url: str) -> None:
    time.sleep(1.5)
    try:
        webbrowser.open(url)
    except Exception:
        pass


# Имя мьютекса одинаковое для всех сборок, без версии: обновление должно
# узнавать запущенный экземпляр, иначе установщик не сможет его закрыть.
SINGLE_INSTANCE_MUTEX = "xlamBOT_single_instance"

_mutex_handle = None


def claim_single_instance() -> bool:
    """Занять мьютекс единственного запуска. False - программа уже открыта.

    Нужен по двум причинам. Установщик по этому мьютексу находит запущенный
    xlamBOT.exe и закрывает его сам вместо ошибки. И, что важнее, два
    экземпляра нельзя оставлять: они берут один и тот же порт и device
    профиль, из-за чего получается два бота на одном устройстве.
    """
    global _mutex_handle
    if os.name != "nt":
        return True
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        handle = kernel32.CreateMutexW(None, True, SINGLE_INSTANCE_MUTEX)
        if not handle:
            # Не смогли создать - не блокируем запуск: отсутствие защиты
            # лучше, чем отказ работать.
            return True
        if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            kernel32.CloseHandle(handle)
            return False
        _mutex_handle = handle  # держим открытым до конца процесса
        return True
    except Exception:  # noqa: BLE001
        return True


def main() -> int:
    if not claim_single_instance():
        print("xlamBOT уже запущен. Закройте окно программы и попробуйте снова.")
        print("Если окна нет, возможно программа запущена свёрнутым значком в трее.")
        return 3

    root = bundled_root()
    os.chdir(root)
    import update_client
    update_client.activate()

    print("=" * 64)
    print(f"  {APP_NAME} {VERSION}")
    print("=" * 64)

    problems = check_assets(root)
    if problems:
        print("\nПрограмма собрана неполно, часть файлов на месте:")
        for line in problems:
            print(f"  - {line}")
        print("\nЗапустите setup.py из исходников либо обратитесь в канал.")
        return 2

    # Мастер настройки: один раз, и только если есть повод
    marker = os.path.join(data_dir(), WIZARD_MARKER)
    needs_wizard = True
    if os.path.isfile(marker):
        try:
            import json

            with open(marker, encoding="utf-8") as handle:
                state = json.load(handle)
            needs_wizard = state.get("wizard_exit_code") != 0
        except Exception:
            needs_wizard = True

    if needs_wizard and os.environ.get("XLAMBOT_SKIP_WIZARD") != "1":
        code = run_wizard()
        try:
            import json

            os.makedirs(data_dir(), exist_ok=True)
            with open(marker, "w", encoding="utf-8") as handle:
                json.dump({"wizard_exit_code": code}, handle)
        except Exception:
            pass
        # Мастер не обязан пройти полностью: дальше панель покажет, что не так
        if code not in (0, 1):
            return code

    port = free_port(int(os.environ.get("XLAMBOT_PORT", DEFAULT_PORT)))
    url = f"http://127.0.0.1:{port}"

    print(f"\nПанель управления: {url}")
    print("Закрыть программу - нажмите Стоп или закройте это окно.\n")

    threading.Thread(target=open_ui, args=(url,), daemon=True).start()

    try:
        from webui.app import create_app

        # None вместо main: панель сама поднимает ботов на найденных
        # устройствах и следит за их состоянием.
        app = create_app(None, start_discord_bot=False)
        update_client.mark_healthy()
        if is_frozen():
            threading.Thread(target=app.config['update_manager'].loop, daemon=True).start()
        # threaded=True иначе панель подвисает на долгих опросах устройства
        app.run(host="127.0.0.1", port=port, threaded=True, debug=False,
                use_reloader=False)
    except KeyboardInterrupt:
        print("\nОстановлено.")
    except Exception as error:  # noqa: BLE001
        print(f"Панель не запустилась: {error}")
        return 3
    return 0


if __name__ == "__main__":
    if '--update-self-test' in sys.argv:
        import json
        import update_client
        os.chdir(bundled_root())
        overlay = update_client.activate()
        from webui.app import create_app
        import utils
        import webui.app
        app = create_app(None, start_discord_bot=False)
        client = app.test_client()
        headers = {'X-Xlam-UI-Token': app.config['UI_API_TOKEN']}
        response = client.get('/api/updates/status', headers=headers)
        update_client.mark_healthy()
        print(json.dumps({'overlay': str(overlay), 'utils': utils.__file__, 'app': webui.app.__file__,
                          'api_status': response.status_code, 'revision': update_client.read_state().get('revision'),
                          'panel_status': client.get('/panel').status_code}, ensure_ascii=True))
        sys.exit(0 if response.status_code == 200 else 1)
    sys.exit(main())
