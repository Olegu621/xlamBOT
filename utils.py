import hashlib
import html
import io
import math
import os
import random
import threading
import time
from contextlib import contextmanager
from io import BytesIO
import ctypes
import json
from pathlib import Path
import requests
import toml
from PIL import Image
import cv2
from packaging import version
import traceback

def get_brawler_stats(_player_info, _brawler_name):
    return None, None


def get_player_info(_tag):
    return None


def _get_project_root():
    import sys
    from pathlib import Path
    if getattr(sys, 'frozen', False):
        # В собранной папке лежат две разные вещи: сам исполняемый файл рядом
        # с пользователем, а ресурсы - в папке _internal рядом с ним. Раньше
        # здесь возвращался каталог уровнем выше exe, и программа искала
        # настройки и модели на уровень выше, то есть не находила их вовсе.
        base = getattr(sys, '_MEIPASS', None)
        if base:
            return Path(base)
        return Path(sys.executable).resolve().parent
    return Path.cwd().resolve()


PROJECT_ROOT = _get_project_root()


def resolve_project_path(*parts) -> Path:
    return PROJECT_ROOT.joinpath(*parts)


def resolve_within(base_path, *parts) -> Path:
    base = resolve_project_path(base_path).resolve()
    candidate = base.joinpath(*parts).resolve()
    if candidate != base and not candidate.is_relative_to(base):
        raise ValueError(f"Path escapes the allowed directory: {candidate}")
    return candidate


def resolve_playstyle_path(filename) -> Path:
    filename = str(filename or "").strip()
    if not filename or Path(filename).name != filename or not filename.lower().endswith(".xlambot"):
        raise ValueError("Invalid playstyle filename.")
    return resolve_within("playstyles", filename)


# Several bots can run at once and each one reads its own device profile, so the
# active config root is per thread rather than a global. Nothing sets it here,
# which keeps a plain single-device run on the repository's cfg/ as before.
_config_scope_state = threading.local()


def get_config_root() -> Path:
    """The directory whose config files take precedence for this thread."""
    root = getattr(_config_scope_state, "root", None)
    return Path(root) if root is not None else resolve_project_path("cfg")


@contextmanager
def config_scope(root):
    """Route config reads to `root` for the duration of the block.

    device_profiles owns where a device's files live; this only switches the
    root, so a scope nested inside another one restores the previous root on
    the way out instead of leaking the device into the rest of the process.
    """
    previous = getattr(_config_scope_state, "root", None)
    _config_scope_state.root = Path(root) if root is not None else None
    try:
        yield get_config_root()
    finally:
        _config_scope_state.root = previous


def _config_file_path(file_path) -> Path:
    """Where a `cfg/...` read or write actually lands.

    Inside a device profile the device's own copy wins, and anything it does not
    carry falls back to the repository — that is what makes a profile a set of
    overrides rather than a copy that has to be kept complete.
    """
    raw = str(file_path).lstrip("/\\")
    # A leading "./" must go before the cfg check below. Path.joinpath happily
    # swallows it when building the fallback path, so "./cfg/x.toml" used to look
    # fine and still resolved to the repository - which silently ignored every
    # device profile for all eleven "./cfg/..." call sites.
    while raw.startswith("./") or raw.startswith(".\\"):
        raw = raw[2:]
    if raw.startswith("cfg/") or raw.startswith("cfg\\"):
        return resolve_config_path(raw[4:])
    return PROJECT_ROOT.joinpath(raw)


def resolve_config_path(*parts) -> Path:
    """Resolve a `cfg/...` path to the copy that currently applies.

    A device profile only has to carry the files it actually overrides, so its
    own copy wins when it exists and the repository's cfg/ answers otherwise.
    The leading `cfg` is optional and the result can never escape the root.
    """
    tail = [part for part in Path(*[str(part) for part in parts]).parts if part not in (".", "")]
    if tail and tail[0].lower() == "cfg":
        tail = tail[1:]
    if tail and ".." not in tail:
        candidate = get_config_root().joinpath(*tail)
        if candidate.is_file():
            return candidate
    return resolve_within("cfg", *tail)


cached_toml = {}
def _merge_over(base, override):
    """Overlay `override` on `base`, recursing into nested tables."""
    merged = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_over(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_toml_as_dict(file_path, cache=True):
    full_path = _config_file_path(file_path)
    if str(full_path) in cached_toml and cache:
        return cached_toml[str(full_path)]
    try:
        data = toml.loads(read_text_auto(full_path))
    except Exception as e:
        print(f"Error loading {full_path}: {e}")
        return {}
    # A device profile overrides the repository rather than replacing it. Without
    # this a profile file holding three keys would hide every other key in the
    # repository's copy — which is how the brawler-sort coordinates went missing.
    repo_path = PROJECT_ROOT.joinpath(str(file_path).lstrip('/\\'))
    if str(repo_path) != str(full_path) and repo_path.exists():
        try:
            data = _merge_over(toml.loads(read_text_auto(repo_path)), data)
        except Exception as e:  # noqa: BLE001
            print(f"Error merging {repo_path} under {full_path}: {e}")
    cached_toml[str(full_path)] = data
    return data

def invalidate_toml_cache(file_path):
    full_path = _config_file_path(file_path)
    cached_toml.pop(str(full_path), None)


def save_dict_as_toml(data, file_path):
    full_path = _config_file_path(file_path)
    with open(full_path, 'w', encoding='utf-8') as f:
        toml.dump(data, f)
    cached_toml[str(full_path)] = data



try:
    from early_access.early_access import OFFICIAL_API
    default_api = OFFICIAL_API
except (ImportError, ModuleNotFoundError):
    default_api = "localhost"
# xlamBOT работает полностью локально: список бойцов, шаблоны экрана и
# модели лежат рядом с программой. Обращений к серверам нет.
api_base_url = "localhost"
brawlers_info_file_path = PROJECT_ROOT / "cfg" / "brawlers_info.json"


def count_hsv_pixels(cv_image, low_hsv, high_hsv, window_controller=None):
    try:
        hsv_image = cv2.cvtColor(cv_image, cv2.COLOR_RGB2HSV)
        mask = cv2.inRange(hsv_image, low_hsv, high_hsv)
        return cv2.countNonZero(mask)
    except cv2.error as e:
        print(f"[ERROR CATCHING] OpenCV error occurred in count_hsv_pixels: {e}")
        if cv_image is not None:
            print(f"Crop image dimensions (width x height): {cv_image.shape[1]}x{cv_image.shape[0]}")
        else:
            print("Crop image is None")
        if window_controller is not None:
            print(f"WindowController state: width={window_controller.width}, height={window_controller.height}, width_ratio={window_controller.width_ratio}, height_ratio={window_controller.height_ratio}")
            window_controller.reset_to_default_resolution()
        return 0



def count_mask_pixels(mask, x1, y1, x2, y2):
    height, width = mask.shape[:2]
    x1 = max(0, min(width, int(x1)))
    x2 = max(0, min(width, int(x2)))
    y1 = max(0, min(height, int(y1)))
    y2 = max(0, min(height, int(y2)))
    if x1 >= x2 or y1 >= y2:
        return 0
    return cv2.countNonZero(mask[y1:y2, x1:x2])

def brawler_queue_path() -> Path:
    """Where the brawler queue lives.

    With one device that is the project root. Inside a device profile the queue
    belongs to that device, and sits beside its cfg directory — otherwise every
    bot would read and overwrite the same list, and the panel would show one
    device's roster for all of them.

    A profile that has no queue of its own falls back to the shared one, the
    same way the settings do. That is what lets the built program work with a
    device it has never seen before: there are no profiles on disk yet, and
    without the fallback it started with an empty list and refused to play.
    """
    root = get_config_root()
    if root != resolve_project_path("cfg"):
        own = root.parent / "latest_brawler_data.json"
        if own.is_file():
            return own
    return resolve_project_path("latest_brawler_data.json")


def account_state_path() -> Path:
    """Where the account-wide counters live between restarts.

    The account total is the only figure that can carry an hourly rate, and a
    rate needs history. Keeping the last value next to the device's own queue
    means a restart resumes the measurement instead of starting over and waiting
    for two more lobby reads.
    """
    root = get_config_root()
    if root != resolve_project_path("cfg"):
        return root.parent / "account_state.json"
    return resolve_project_path("account_state.json")


def read_text_auto(path, errors="replace"):
    """Прочитать текст, не падая на чужой кодировке.

    Панель и бот читают конфиги, плейстайлы и очередь как utf-8. Файл, сохранённый
    в блокноте на русской Windows, приходит в cp1251, и чтение падало с
    'utf-8' codec can't decode byte ... - панель при этом показывала одни
    прочерки, а бот падал в last_error. Пробуем utf-8, затем cp1251, и если не
    подошёл ни один - читаем с заменой символов, потому что частично верный
    текст полезнее пустоты.
    """
    raw = Path(path).read_bytes()
    for encoding in ("utf-8", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors=errors)


def save_brawler_data(data):
    """
    Save the given data to a json file. As a list of dictionaries.
    """
    queue_path = brawler_queue_path()
    with open(queue_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)


def load_brawler_data():
    queue_path = brawler_queue_path()
    if not queue_path.exists():
        return []
    try:
        data = json.loads(read_text_auto(queue_path))
        return clean_queue(data) if isinstance(data, list) else []
    except Exception as e:
        traceback.print_exc()
        print(f"Error loading queue data from {queue_path}: {e}")
        return []

def api_update_brawler_data(brawler_data):
    # The public edition has no authenticated player-profile lookup.
    return


def clear_brawler_data():
    queue_path = resolve_project_path("latest_brawler_data.json")
    if queue_path.exists():
        queue_path.unlink()


def clean_queue(data):
    cleaned_data = []
    for brawler_data in data:
        if brawler_data['type'] not in ["trophies", "wins"]:
            brawler_data['type'] = "trophies"
        type_of_push = brawler_data['type']
        if brawler_data[type_of_push] == "":
            brawler_data[type_of_push] = 0

        if brawler_data['push_until'] == "":
            if type_of_push == "wins":
                brawler_data['push_until'] = 300
            elif type_of_push == "trophies":
                brawler_data['push_until'] = 1000
        value = brawler_data[type_of_push]
        if isinstance(value, str):
            try:
                value = int(value)
            except ValueError:
                value = 0
        current_win_streak = brawler_data["win_streak"] if "win_streak" in brawler_data else 0
        if not isinstance(current_win_streak, int):
            try:
                current_win_streak = int(current_win_streak)
            except ValueError:
                current_win_streak = 0
        automatically_pick = brawler_data["automatically_pick"]
        if not isinstance(automatically_pick, bool):
            automatically_pick = str(automatically_pick).strip().lower() in {"1", "true", "yes", "on"}
        current_wins = brawler_data["wins"]
        if not isinstance(current_wins, int):
            try:
                current_wins = int(current_wins)
            except ValueError:
                current_wins = 0
        current_trophies = brawler_data["trophies"]
        if not isinstance(current_trophies, int):
            try:
                current_trophies = int(current_trophies)
            except ValueError:
                current_trophies = 0
        push_until = brawler_data['push_until']
        if not isinstance(push_until, int):
            try:
                push_until = int(push_until)
            except ValueError:
                push_until = 0

        # The brawler is kept whatever the trophy count says. This used to drop
        # anyone at or above the target, and since the count comes from OCR a
        # single bad read deleted the brawler from the queue for good — and when
        # it was the only one, the bot refused to start at all. Trophies are not
        # a reason to drop anyone: the game decides who plays, not this list.
        if True:
            final_brawler_data = {"brawler": brawler_data['brawler'], "type": type_of_push, "trophies": current_trophies, "wins": current_wins, "push_until": push_until, "automatically_pick": automatically_pick, "win_streak": current_win_streak}
            cleaned_data.append(final_brawler_data)
    return cleaned_data


def find_template_center(main_img, template, threshold=0.8):

    main_image_cv = cv2.cvtColor(main_img, cv2.COLOR_RGB2GRAY)
    if len(template.shape) == 3 and template.shape[2] == 3:
        template_cv = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    else:
        template_cv = template
    w, h = template_cv.shape[::-1]

    # Perform template matching
    result = cv2.matchTemplate(main_image_cv, template_cv, cv2.TM_CCOEFF_NORMED)
    min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(result)

    # Check if the match is found based on a threshold value
    if max_val >= threshold:
        center_x = max_loc[0] + w // 2
        center_y = max_loc[1] + h // 2

        return center_x, center_y
    else:
        return False


BRAWLER_ALIASES = {
    "jess": "jessie",
}


def _with_brawler_aliases(info):
    """The brawler table with the keys it can also be reached under.

    A queue can name a brawler differently from the table (Jess is stored as
    "jessie"), and play.py as well as the playstyles look the entry up with a
    plain dict access, so an unrecognised spelling was a hard failure rather
    than a miss. The original keys are kept as they are and every alias points
    at the very same entry, so a profile that overrides one brawler still sees
    all of them.
    """
    if not info:
        return {}
    aliased = dict(info)
    for key in list(aliased):
        normalized = normalize_brawler_filename(key)
        if normalized and normalized != key:
            aliased.setdefault(normalized, aliased[key])
    for alias, key in BRAWLER_ALIASES.items():
        if key in aliased:
            aliased.setdefault(alias, aliased[key])
    return aliased


def load_brawlers_info():
    if os.path.exists(brawlers_info_file_path):
        with open(brawlers_info_file_path, 'r') as f:
            return _with_brawler_aliases(json.load(f))
    else:
        return {}


def update_brawlers_info(brawlers_info):
    with open(brawlers_info_file_path, 'w') as f:
        json.dump(brawlers_info, f, indent=4)


def get_brawler_list():
    if api_base_url == "localhost":
        brawler_list = list(load_brawlers_info().keys())
        return brawler_list
    url = f'https://{api_base_url}/get_brawler_list'
    try:
        response = requests.post(url, timeout=3.0)
        if response.status_code == 201:
            data = response.json()
            return list(set(data.get('brawlers', []) + list(load_brawlers_info().keys())))
    except Exception:
        pass
    return list(load_brawlers_info().keys())



def update_missing_brawlers_info(brawlers):
    brawlers_info = load_brawlers_info()
    for brawler in brawlers:
        if brawler not in brawlers_info:
            brawler_info = get_brawler_info(brawler)
            if brawler_info:
                brawlers_info[brawler] = brawler_info
                update_brawlers_info(brawlers_info)
                print(f"Added info for brawler '{brawler}': {brawler_info}")
                # Download the brawler icon
                save_brawler_icon(brawler)
            else:
                print(f"Could not find info for brawler '{brawler}'")
        if not os.path.exists(PROJECT_ROOT / "api" / "assets" / "brawler_icons" / f"{brawler}.png"):
            save_brawler_icon(brawler)


def get_brawler_info(brawler_name):
    url = f'https://{api_base_url}/get_brawler_info'  # Adjust the URL if necessary
    response = requests.post(url, json={'brawler_name': brawler_name})
    if response.status_code == 200:
        data = response.json()
        return data.get('info', [])
    else:
        print(f"Error fetching info for '{brawler_name}': {response.status_code} - {response.text}")
        return None


def save_brawler_icon(brawler_name):
    # Clean the brawler name for filename
    brawler_name_clean = brawler_name.lower().replace(' ', '').replace('-', '').replace('.', '').replace('&',
                                                                                                         '')
    brawlers_url = "https://api.brawlapi.com/v1/brawlers"
    response = requests.get(brawlers_url)
    if response.status_code != 200:
        print(f"Failed to fetch brawlers from API: {response.status_code}")
        return
    brawlers_data = response.json()['list']

    # Find the brawler in the API data
    for brawler_obj in brawlers_data:
        api_brawler_name = brawler_obj['name'].lower().replace(' ', '').replace('-', '').replace('.', '').replace('&', '')
        if api_brawler_name == brawler_name_clean:
            icon_url = brawler_obj['imageUrl2']
            img_response = requests.get(icon_url)
            if img_response.status_code == 200:
                image = Image.open(BytesIO(img_response.content))
                safe_name = os.path.basename(brawler_name_clean).replace('/', '').replace('\\', '')
                icon_path = PROJECT_ROOT / "api" / "assets" / "brawler_icons" / f"{safe_name}.png"
                icon_path.parent.mkdir(parents=True, exist_ok=True)
                image.save(str(icon_path))
                print(f"Saved icon for brawler '{brawler_name}'")
            else:
                print(f"Failed to download icon for '{brawler_name}'")
            return
    print(f"Icon not found for brawler '{brawler_name}'")


XLAMBOT_VERSION = "0.8.15"
# Скачивать нечего: программа полностью локальная.
DOWNLOAD_URL = ""


def get_latest_version():
    url = f'https://{api_base_url}/check_version'
    response = requests.get(url)
    if response.status_code == 200:
        data = response.json()
        return data.get('version', '')
    else:
        return None


def get_announcements():
    """Fetch active announcements without making startup depend on the API."""
    url = f'https://{api_base_url}/announcements'
    try:
        response = requests.get(url, timeout=3.0)
        if response.status_code == 200:
            data = response.json()
            announcements = data.get('announcements', [])
            return announcements if isinstance(announcements, list) else []
    except Exception:
        pass
    return []


def check_version():
    if api_base_url != "localhost":
        latest_version = get_latest_version()
        if latest_version:
            if version.parse(XLAMBOT_VERSION) < version.parse(latest_version):
                print(
                    "Warning: You are not using the latest public version of xlamBOT. "
                    f"Download it here: {DOWNLOAD_URL}"
                )
        else:
            print("Error, couldn't get the version, please check your internet connection or go ask for help in the discord.")


def format_notification_status(stage_manager) -> str:
    current_brawler_data = stage_manager.brawlers_pick_data[0]
    push_type = current_brawler_data["type"]
    target = current_brawler_data["push_until"]
    trophy_observer = stage_manager.Trophy_observer

    if push_type == "wins":
        current_amount = trophy_observer.current_wins
    else:
        current_amount = trophy_observer.current_trophies

    win_streak = trophy_observer.win_streak
    next_brawler = stage_manager.brawlers_pick_data[1]["brawler"] if len(stage_manager.brawlers_pick_data) > 1 else "None"
    brawlers_left = max(len(stage_manager.brawlers_pick_data) - 1, 0)

    return (
        f"Current brawler: {current_brawler_data['brawler']} \n"
        f"{push_type.capitalize()}: {current_amount}/{target} | "
        f"Win streak: {win_streak} \n"
        f"Next brawler: {next_brawler} | "
        f"Brawlers left: {brawlers_left}"
    )


def notify_user(message_type, screenshot, stage_manager) -> None:
    user_id = load_toml_as_dict("cfg/webhook_config.toml")["discord_id"].strip()
    webhook_url = load_toml_as_dict("cfg/webhook_config.toml")["webhook_url"].strip()
    telegram_token = load_toml_as_dict("cfg/webhook_config.toml")["telegram_token"].strip()
    telegram_chat_id = load_toml_as_dict("cfg/webhook_config.toml")["telegram_chat_id"].strip()
    has_discord = webhook_url
    has_telegram = telegram_token and telegram_chat_id

    if not has_discord and not has_telegram:
        print("Couldn't notify: no Discord webhook or Telegram bot configured.")
        return

    if message_type == "completed":
        status_line = f"xlamBOT has completed all its targets!"
    elif message_type == "bot_is_stuck":
        status_line = f"Your bot is currently stuck, attempted to restart brawl stars !"
    elif message_type == "brawler_goal":
        current_brawler = stage_manager.brawlers_pick_data[0]["brawler"]
        status_line = f"xlamBOT completed brawler goal for {current_brawler}!"
    elif message_type in ["regular_minutes_ping", "regular_matches_ping"]:
        status_line = "xlamBOT is still running."
    elif message_type == "bot_failed_brawler_selection":
        current_brawler = stage_manager.brawlers_pick_data[0]["brawler"]
        status_line = f"xlamBOT failed to select the brawler {current_brawler} after multiple attempts, try changing the OCR Scale Down setting or select it manually and restart. Putting it at the end of the queue and skipping it..."
    else:
        status_line = "Notification"

    stage_status = format_notification_status(stage_manager)
    if stage_status:
        status_line = f"{status_line}\n{stage_status}"

    image_buffer = None
    if screenshot is not None:
        try:
            screenshot_pil = Image.fromarray(screenshot)
            image_buffer = io.BytesIO()
            screenshot_pil.save(image_buffer, format="PNG")
            image_buffer.seek(0)
        except Exception as e:
            print(f"Failed to prepare screenshot: {e}")
            image_buffer = None

    if has_discord:
        ping = f"<@{user_id}>" if user_id else ""
        files = {}
        if image_buffer is not None:
            image_buffer.seek(0)
            files["file"] = ("screenshot.png", image_buffer, "image/png")

        embed = {
            "description": status_line
        }

        if files:
            embed["image"] = {"url": "attachment://screenshot.png"}

        payload = {
            "content": ping,
            "username": "xlamBOT notifier",
            "embeds": [embed],
        }

        print("Sending Discord webhook...")
        try:
            if files:
                response = requests.post(webhook_url, data={"payload_json": json.dumps(payload)}, files=files, timeout=15)
            else:
                response = requests.post(webhook_url, json=payload, timeout=15)

            if response.status_code not in (200, 204):
                print(f"Failed to send Discord webhook: {response.status_code} {response.text}")

        except Exception as e:
            print(f"Error sending Discord webhook: {e}")

    if has_telegram:
        print("Sending Telegram notification...")
        try:
            safe_text = html.escape(status_line)

            if image_buffer is not None:
                image_buffer.seek(0)
                url = f"https://api.telegram.org/bot{telegram_token}/sendPhoto"
                response = requests.post(url,
                    data={
                        "chat_id": telegram_chat_id,
                        "caption": safe_text,
                        "parse_mode": "HTML",
                    },
                    files={
                        "photo": ("screenshot.png", image_buffer, "image/png")
                    }, timeout=15)

            else:
                url = f"https://api.telegram.org/bot{telegram_token}/sendMessage"
                response = requests.post(url,
                    data={
                        "chat_id": telegram_chat_id,
                        "text": safe_text,
                        "parse_mode": "HTML",
                    }, timeout=15)

            if response.status_code != 200:
                print(f"Failed to send Telegram notification: {response.status_code} {response.text}")

        except Exception as e:
            print(f"Error sending Telegram notification: {e}")


def get_discord_link():
    if api_base_url == "localhost":
        return "https://discord.gg/xUusk3fw4A"
    url = f'https://{api_base_url}/get_discord_link'
    response = requests.get(url)
    if response.status_code == 200:
        data = response.json()
        return data.get('link', '')
    else:
        return None


def get_online_wall_model_hash():
    url = f'https://{api_base_url}/get_wall_model_hash'
    response = requests.get(url)
    if response.status_code == 200:
        data = response.json()
        return data.get('hash', '')
    else:
        return None


def calculate_sha256(file_path):
    """
    Calculate the SHA-256 hash of a file.
    """
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as file:
        # Read the file in chunks to handle large files
        for chunk in iter(lambda: file.read(4096), b""):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


def current_wall_model_is_latest() -> bool:
    """
    Check if the current wall model is the latest version.
    """
    if not os.path.exists("models/tileDetector.onnx"):
        return False
    local_hash = calculate_sha256("models/tileDetector.onnx")
    online_hash = get_online_wall_model_hash()
    return local_hash == online_hash


def get_latest_wall_model_file():
    #download the new model to replace the current file and also updates the tile list
    url = f'https://{api_base_url}/get_wall_model_file'
    response = requests.get(url)
    if response.status_code == 200:
        with open("./models/tileDetector.onnx", "wb") as file:
            file.write(response.content)
        print("Downloaded the latest wall model.")
    else:
        print(f"Failed to download the latest wall model. Status code: {response.status_code}")


def get_latest_wall_model_classes():
    url = f'https://{api_base_url}/get_wall_model_classes'
    response = requests.get(url)
    if response.status_code == 200:
        data = response.json()
        return data.get('classes', [])
    else:
        return None


def update_wall_model_classes():
    classes = get_latest_wall_model_classes()
    current_classes = load_toml_as_dict("cfg/bot_config.toml")["wall_model_classes"]
    if classes:
        if classes != current_classes:
            print("New wall model classes found. Updating...")
            full_config = load_toml_as_dict("cfg/bot_config.toml")
            full_config["wall_model_classes"] = classes
            save_dict_as_toml(full_config, "cfg/bot_config.toml")
            print("Updated the wall model classes.")
    else:
        print("Failed to update the wall model classes, please report this error.")


def cprint(text: str, hex_color: str):
    try:
        hex_color = hex_color.lstrip("#")
        r, g, b = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
        print(f"\033[38;2;{r};{g};{b}m{text}\033[0m")
    except Exception:
        print(text)


def normalize_brawler_filename(brawler_name: str) -> str:
    return str(brawler_name).lower().replace(' ', '').replace('-', '').replace('.', '').replace('&', '')


def get_brawler_icon_path(brawler_name: str) -> Path | None:
    if not brawler_name:
        return None

    raw_name = str(brawler_name).lower().strip()
    if "/" in raw_name or "\\" in raw_name or raw_name in {".", ".."}:
        return None
    normalized = normalize_brawler_filename(brawler_name)
    candidates = [
        resolve_within(resolve_project_path("api", "assets", "brawler_icons"), f"{normalized}.png"),
        resolve_within(resolve_project_path("api", "assets", "brawler_icons2"), f"{raw_name}.png"),
    ]

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def get_dpi_scale():
    user32 = ctypes.windll.user32
    user32.SetProcessDPIAware()
    return int(user32.GetDpiForSystem())


SAFE_GLOBALS = {
    'math': math,
    'PI': math.pi,
    'random': random,
    'abs': abs,
    'min': min,
    'max': max,
    'sum': sum,
    'round': round,
    'len': len,
    'range': range,
    'zip': zip,
    'map': map,
    'int': int,
    'float': float,
    'str': str,
    'print': print,
    'time_now': lambda: time.time(),
    'random_int': random.randint,
    'normalize_move': lambda x, y, radius=100: (
        (x * (radius / math.hypot(x, y)), y * (radius / math.hypot(x, y)))
        if math.hypot(x, y) > 0 else (0.0, 0.0)
    ),
}



import ast

def is_safe_ast(code_str):
    try:
        tree = ast.parse(code_str)
    except SyntaxError as e:
        return False, f"Syntax Error: {e}"

    for node in ast.walk(tree):
        # 1. Block access to any attributes starting with underscore (e.g. __class__)
        if isinstance(node, ast.Attribute):
            if node.attr.startswith('_'):
                return False, f"Access to private/dunder attribute '{node.attr}' is forbidden."
        
        # 2. Block imports of any kind inside the script
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return False, "Imports are not allowed in playstyle scripts."
            
        # 3. Block calling of eval, exec, compile, etc.
        if isinstance(node, ast.Name):
            if node.id in {'exec', 'eval', 'compile', 'getattr', 'setattr', 'delattr', '__import__', 'open', 'globals', 'locals', 'vars', 'breakpoint'}:
                return False, f"Call to '{node.id}' is forbidden."


    return True, None


def interpret_playstyle_code(playstyle_code, context):
    safe_globals = SAFE_GLOBALS.copy()
    safe_globals.update(context)
    safe_globals['__builtins__'] = {}

    try:
        if isinstance(playstyle_code, str):
            is_safe, error_msg = is_safe_ast(playstyle_code)
            if not is_safe:
                print(f"Security/Syntax Validation Failed for playstyle: {error_msg}")
                return None, safe_globals
            compiled_code = compile(playstyle_code, '<string>', 'exec')
        else:
            compiled_code = playstyle_code

        if compiled_code is not None:
            exec(compiled_code, safe_globals)
    except Exception as e:
        print(f"Error executing .xlambot code")
        traceback.print_exc()
        return None, safe_globals

    return safe_globals.get('movement', None), safe_globals


def load_playstyle_script(filename):
    try:
        script_path = resolve_playstyle_path(filename)
        text = read_text_auto(script_path)
        lines = text.splitlines(True)
        metadata_header = lines[0].strip() if lines else ""
        metadata = json.loads(metadata_header) if metadata_header else {}
        playstyle_source = text
        return metadata, playstyle_source
    except FileNotFoundError:
        print(f"Error: The playstyle file '{filename}' was not found.")
        return {}, ""
    except Exception as e:
        print(f"An error occurred while loading the .xlambot script: {e}")
        traceback.print_exc()
        return {}, ""


def get_playstyles_list():
    playstyles_dir = resolve_project_path("playstyles")
    playstyles = []
    if playstyles_dir.exists():
        for filename in os.listdir(playstyles_dir):
            if filename.endswith(".xlambot"):
                metadata, _ = load_playstyle_script(filename)
                playstyles.append({
                    "filename": filename,
                    "metadata": metadata
                })
    return playstyles


def load_default_playstyle():
    config = load_toml_as_dict("cfg/bot_config.toml")
    current_playstyle = config.get("current_playstyle", "default_up.xlambot")
    return load_playstyle_script(current_playstyle)


def _mode_key(name):
    """Fold a mode name to one comparable form.

    Playstyles write "trio showdown", the config writes trio_showdown, and
    comparing them as written flagged every correct pairing as a mismatch.
    """
    return "".join(ch if ch.isalnum() else "_" for ch in str(name).lower()).strip("_")


def game_mode_warning(playstyle_info=None, config=None):
    """Say when the playstyle was not written for the mode being played.

    A playstyle carries the modes it fits in its first line, and nothing used to
    read that field. So a Showdown survival script could drive a Heist match
    with no complaint: the bot hides from fights the way you hide in Showdown,
    which on a Heist map just looks like it is standing in the bushes. Silent
    and plausible is exactly how this survived so long.

    Returns the warning, or None when the playstyle fits, which is also the
    answer when either side is unknown - an unlabelled playstyle or an unset
    mode is not something to nag about.

    A playstyle may also name something that is not a mode at all: the stock
    scripts say "3v3, 5v5", which means any team game rather than one mode.
    Those are treated as "no opinion", because warning that a generic script is
    not written for Heist is noise, and it would fire on every default install.
    """
    if config is None:
        config = load_toml_as_dict("cfg/bot_config.toml")
    mode = str(config.get("game_mode") or "").strip()
    if not mode:
        return None
    if playstyle_info is None:
        playstyle_info, _ = load_default_playstyle()
    declared = [_mode_key(name) for name in (playstyle_info or {}).get("gamemodes") or []]
    declared = [name for name in declared if name]
    if not declared or any(name in ("*", "all", "any", "any_mode") for name in declared):
        return None
    names = load_toml_as_dict("cfg/modes_config.toml").get("mode") or {}
    known = {_mode_key(name) for name in names}
    named = [name for name in declared if name in known]
    if not named:
        return None
    if _mode_key(mode) in named:
        return None
    label = names.get(mode, mode)
    wanted = ", ".join(
        names.get(next((key for key in names if _mode_key(key) == name), name), name)
        for name in named)
    return (f'Плейстайл «{(playstyle_info or {}).get("name") or current_playstyle_name()}» '
            f'написан для «{wanted}», а игра идёт в режиме «{label}». '
            f'Бот будет вести себя не так, как задумано в плейстайле.')


def current_playstyle_name():
    return load_toml_as_dict("cfg/bot_config.toml").get("current_playstyle", "")


def hash_playstyle(playstyle_info):
    return hashlib.sha256(str(playstyle_info).encode('utf-8')).hexdigest()


def config_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)



def clamp(x: int, low: int, high: int) -> int:
    if x < low:
        return low
    if x > high:
        return high
    return x

JOYSTICK_RADIUS = 100


def normalize_move(x, y, radius=JOYSTICK_RADIUS):
    length = math.hypot(x, y)
    if length <= 0:
        return (0.0, 0.0)
    scale = radius / length
    return (x * scale, y * scale)


def mask_secret(value: str | None) -> dict:
    value = (value or "").strip()
    if not value:
        return {"configured": False, "length": 0, "masked": ""}
    return {
        "configured": True,
        "length": len(value),
        "masked": "*" * len(value),
    }

