"""Multi-device supervisor for the xlamBOT web panel.

Holds one runtime (thread + control flags) per ADB device, each running inside its
own device config scope. Also owns ADB device discovery, per-device queues and
per-device logs so the panel can control every phone independently.
"""
from __future__ import annotations

import collections
import re
import threading
import time
import traceback
from typing import Any, Callable

from adbutils import adb

import device_profiles
from bot_instance import run_bot_instance
from utils import clean_queue, config_scope
from window_controller import WindowController, get_device_by_serial, is_brawl_stars_package

ANSI_CLEAN_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
MAX_LOG_LINES = 1500

# Thread-local tag so a bot thread's stdout can be routed to its device's log.
_log_scope = threading.local()


def set_current_log_target(key: str | None):
    previous = getattr(_log_scope, "key", None)
    _log_scope.key = key
    return previous


def current_log_target() -> str | None:
    return getattr(_log_scope, "key", None)


class DeviceLogHub:
    """Per-device ring buffers, filled by the stdout capture installed in runtime.py."""

    def __init__(self, max_lines: int = MAX_LOG_LINES):
        self._buffers: dict[str, collections.deque] = {}
        self._lock = threading.Lock()
        self._max_lines = max_lines

    def append(self, key: str, line: str):
        with self._lock:
            buffer = self._buffers.get(key)
            if buffer is None:
                buffer = collections.deque(maxlen=self._max_lines)
                self._buffers[key] = buffer
            buffer.append(line)

    def append_bulk(self, key: str, lines: list[str]):
        with self._lock:
            buffer = self._buffers.get(key)
            if buffer is None:
                buffer = collections.deque(maxlen=self._max_lines)
                self._buffers[key] = buffer
            buffer.extend(lines)

    def get(self, key: str, limit: int = 400) -> list[str]:
        with self._lock:
            buffer = self._buffers.get(key)
            if not buffer:
                return []
            lines = list(buffer)
        return lines[-limit:]

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._buffers.keys())

    def clear(self, key: str):
        with self._lock:
            self._buffers.pop(key, None)


LOG_HUB = DeviceLogHub()


class DeviceRuntime:
    """Runtime state of a single device bot."""

    def __init__(self, key: str, serial: str):
        self.key = key
        self.serial = serial
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._control = None
        self._state = "idle"
        self._last_error = ""
        self._started_at: float | None = None
        self._result: dict[str, Any] | None = None

    @property
    def is_running(self) -> bool:
        with self._lock:
            return bool(self._thread and self._thread.is_alive())

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            thread_alive = bool(self._thread and self._thread.is_alive())
            if not thread_alive and self._state not in ("starting",):
                self._state = "idle" if self._state != "error" else "error"
                self._thread = None
                self._control = None
                self._started_at = None
            return {
                "key": self.key,
                "serial": self.serial,
                "state": self._state,
                "is_running": thread_alive,
                "last_error": self._last_error,
                "started_at": self._started_at if thread_alive else None,
                "uptime_seconds": (time.time() - self._started_at) if (thread_alive and self._started_at) else None,
            }

    def _set_state(self, state: str):
        with self._lock:
            self._state = state


class DeviceRuntimeManager:
    """Discovers ADB devices and supervises one bot thread per device."""

    def __init__(self, xlambot_main=None, discord_bot=None):
        self.xlambot_main = xlambot_main
        self.discord_bot = discord_bot
        self._lock = threading.RLock()
        self._start_lock = threading.RLock()
        self._runtimes: dict[str, DeviceRuntime] = {}
        self._controls: dict[str, Any] = {}
        self._instances: dict[str, Any] = {}
        # key -> (jpeg bytes, frame timestamp they came from, when encoded)
        self._snapshots: dict[str, tuple[bytes, float, float]] = {}
        self._queue_provider: Callable[[str], list[dict[str, Any]]] | None = None

    def set_discord_bot(self, discord_bot):
        self.discord_bot = discord_bot

    def configure_queue_provider(self, provider: Callable[[str], list[dict[str, Any]]]):
        self._queue_provider = provider

    # -- device discovery ------------------------------------------------------
    @staticmethod
    def list_adb_devices() -> list[dict[str, Any]]:
        devices = []
        try:
            raw_devices = adb.device_list()
        except Exception as error:
            return [{"ok": False, "message": f"ADB unavailable: {error}"}]

        for device in raw_devices:
            serial = device.serial
            entry: dict[str, Any] = {
                "serial": serial,
                "key": device_profiles.sanitize_key(serial),
                "state": "unknown",
                "model": "",
                "android_version": "",
                "resolution": "",
                "brawl_stars_running": False,
            }
            try:
                entry["state"] = device.get_state()
            except Exception:
                entry["state"] = "unknown"

            if entry["state"] == "device":
                def _shell(*args, default=""):
                    try:
                        return device.shell(list(args), timeout=3.0).strip()
                    except Exception:
                        return default

                props = device.prop
                entry["model"] = _shell("getprop", "ro.product.model") or (props.model or "")
                entry["android_version"] = _shell("getprop", "ro.build.version.release")
                size = _shell("wm", "size")
                entry["resolution"] = size.replace("Override size:", "").replace("Physical size:", "").strip()
                try:
                    current = device.app_current()
                    entry["brawl_stars_package"] = (current.package or "").strip()
                    entry["brawl_stars_running"] = is_brawl_stars_package(entry["brawl_stars_package"])
                except Exception:
                    entry["brawl_stars_running"] = False
            devices.append(entry)
        return devices

    @staticmethod
    def connect_network_device(address: str) -> dict[str, Any]:
        address = str(address or "").strip()
        if not address:
            return {"ok": False, "message": "An address like 127.0.0.1:5555 is required."}
        try:
            device = adb.connect(address)
        except Exception as error:
            return {"ok": False, "message": f"Could not connect to {address}: {error}"}
        if device is None:
            return {"ok": False, "message": f"Could not connect to {address}."}
        return {"ok": True, "message": f"Connected to {device.serial}.", "serial": device.serial}

    @staticmethod
    def disconnect_network_device(address: str) -> dict[str, Any]:
        address = str(address or "").strip()
        try:
            adb.disconnect(address)
        except Exception as error:
            return {"ok": False, "message": f"Could not disconnect {address}: {error}"}
        return {"ok": True, "message": f"Disconnected {address}."}

    # -- device preparation ----------------------------------------------------
    @staticmethod
    def prepare_device(serial: str, width: int = 1920, height: int = 1080) -> dict[str, Any]:
        """Give a device a 16:9 landscape display, which the bot's coordinates assume.

        The bot's button/region tables are calibrated for 1920x1080. Any 16:9
        display works because coordinates are scaled uniformly, but a native
        phone resolution is often not 16:9, which would skew every tap.
        """
        try:
            device = get_device_by_serial(serial)
        except Exception as error:
            return {"ok": False, "message": str(error)}

        steps = []
        try:
            device.shell(["wm", "size", f"{int(width)}x{int(height)}"], timeout=10)
            steps.append(f"wm size -> {width}x{height}")
            time.sleep(2)
            applied = device.shell(["wm", "size"], timeout=10).strip()
            steps.append(f"confirmed: {applied}")
        except Exception as error:
            return {"ok": False, "message": f"Could not set display size: {error}"}

        try:
            if device.app_current().package.strip() not in ("com.supercell.brawlstars", "bsd.suitcase.release"):
                device.app_start("com.supercell.brawlstars")
                steps.append("started Brawl Stars")
        except Exception:
            pass

        return {"ok": True, "message": "Display prepared.", "steps": steps}

    @staticmethod
    def reset_device_display(serial: str) -> dict[str, Any]:
        try:
            device = get_device_by_serial(serial)
            device.shell(["wm", "size", "reset"], timeout=10)
            time.sleep(2)
            applied = device.shell(["wm", "size"], timeout=10).strip()
            return {"ok": True, "message": f"Display reset: {applied}"}
        except Exception as error:
            return {"ok": False, "message": f"Could not reset display: {error}"}

    @staticmethod
    def selftest_device(serial: str, seconds: float = 8.0) -> dict[str, Any]:
        """Try to open a scrcpy stream and report whether real frames arrive.

        This surfaces device/driver problems (for example a broken hardware video
        encoder) before a bot is started, instead of failing mid-run.
        """
        import scrcpy

        result: dict[str, Any] = {"ok": False, "serial": serial}
        try:
            device = get_device_by_serial(serial)
        except Exception as error:
            result["message"] = str(error)
            return result

        client = None
        try:
            client = scrcpy.Client(device=device, max_width=0, bitrate=4000000)
            client.start(threaded=True)
            deadline = time.time() + seconds
            frames = 0

            def _on_frame(frame):
                nonlocal frames
                if frame is not None:
                    frames += 1

            client.add_listener(scrcpy.EVENT_FRAME, _on_frame)
            while time.time() < deadline and frames < 3:
                time.sleep(0.2)

            result["resolution"] = client.resolution
            result["frames"] = frames
            if frames > 0:
                result["ok"] = True
                result["message"] = f"Video feed OK ({frames} frames, {client.resolution[0]}x{client.resolution[1]})."
            else:
                result["message"] = (
                    "No video frames. The device's hardware video encoder is not "
                    "producing a stream for scrcpy. Brawl Stars bots need a device or "
                    "emulator whose AVC encoder works with scrcpy."
                )
        except Exception as error:
            result["message"] = f"{type(error).__name__}: {error}"
        finally:
            if client is not None:
                try:
                    client.stop()
                except Exception:
                    pass
        return result

    # -- runtime control -------------------------------------------------------
    def _runtime_for(self, key: str, serial: str | None = None) -> DeviceRuntime:
        key = device_profiles.sanitize_key(key)
        with self._lock:
            runtime = self._runtimes.get(key)
            if runtime is None:
                runtime = DeviceRuntime(key, serial or key)
                self._runtimes[key] = runtime
            elif serial and runtime.serial == key:
                # The profile key is a filesystem-safe form of the serial, so it can
                # differ from the real one (e.g. "127.0.0.1-5555"). Learn it once.
                runtime.serial = serial
            return runtime

    def get_status(self, key: str) -> dict[str, Any]:
        return self._runtime_for(key).get_status()

    def all_statuses(self) -> list[dict[str, Any]]:
        with self._lock:
            runtimes = list(self._runtimes.values())
        return [runtime.get_status() for runtime in runtimes]

    def resolve_serial(self, key: str, serial: str | None = None) -> str:
        """Map a profile key back to a real ADB serial.

        Profile keys are filesystem-safe, so a TCP device appears as
        "127.0.0.1-5555" while ADB needs "127.0.0.1:5555". Handing the key to
        scrcpy would fail to connect, so the live device list is consulted.
        """
        if serial:
            return serial
        key = device_profiles.sanitize_key(key)
        try:
            for device in self.list_adb_devices():
                if device.get("key") == key and device.get("serial"):
                    return device["serial"]
        except Exception:
            pass
        return key

    def start(self, key: str, serial: str | None = None) -> dict[str, Any]:
        with self._start_lock:
            return self._start(key, serial)

    def _start(self, key: str, serial: str | None = None) -> dict[str, Any]:
        from webui.runtime import RuntimeControl

        key = device_profiles.sanitize_key(key)
        serial = self.resolve_serial(key, serial)
        runtime = self._runtime_for(key, serial)
        if runtime.is_running and runtime.get_status()["state"] == "stopping":
            return {"ok": False, "message": f"{key}: waiting for the previous worker to exit."}
        if runtime.is_running:
            if runtime.get_status()["state"] == "paused":
                self._controls.get(key) and self._controls[key].resume()
                runtime._set_state("running")
                return {"ok": True, "message": f"Resumed {key}."}
            return {"ok": False, "message": f"{key} is already running ({runtime.get_status()['state']})."}

        queue_data = self._queue_provider(key) if self._queue_provider else device_profiles.load_queue(key)
        queue_data = clean_queue(queue_data or [])
        if not queue_data:
            return {"ok": False, "message": f"Queue for {key} is empty.", "code": "EMPTY_QUEUE"}

        device_profiles.ensure_profile(key)
        config_root = device_profiles.config_root_for(key)
        control = RuntimeControl(runtime._set_state)

        def _on_instance(instance):
            with self._lock:
                self._instances[key] = instance

        def _worker():
            previous = set_current_log_target(key)
            try:
                with config_scope(config_root):
                    result = run_bot_instance(
                        self.discord_bot, queue_data,
                        runtime_control=control,
                        serial=serial,
                        device_key=key,
                        device_label=key,
                        instance_callback=_on_instance,
                    )
            except Exception as error:
                traceback.print_exc()
                result = {"ok": False, "message": str(error)}
            finally:
                set_current_log_target(previous)
                with self._lock:
                    self._instances.pop(key, None)
            with runtime._lock:
                runtime._result = result
                if result.get("ok"):
                    runtime._state = "idle"
                elif control.should_stop():
                    # A user-requested stop is a normal end of run, not a failure.
                    runtime._state = "idle"
                    runtime._last_error = ""
                else:
                    runtime._state = "error"
                    runtime._last_error = result.get("message", "Unknown error")

        with self._lock:
            self._controls[key] = control
            runtime._state = "starting"
            runtime._last_error = ""
            runtime._result = None
            runtime._started_at = time.time()
            runtime._thread = threading.Thread(
                target=_worker, daemon=True, name=f"xlambot-device-{key}"
            )
            runtime._thread.start()
        return {"ok": True, "message": f"Starting bot on {serial}."}

    def pause(self, key: str) -> dict[str, Any]:
        key = device_profiles.sanitize_key(key)
        runtime = self._runtime_for(key)
        control = self._controls.get(key)
        if not runtime.is_running or control is None:
            return {"ok": False, "message": f"{key} is not running."}
        status = runtime.get_status()
        if status["state"] == "running":
            control.request_pause()
            runtime._set_state("pausing")
            return {"ok": True, "message": "Pause requested; the bot pauses in the lobby."}
        if status["state"] in ("pausing", "paused"):
            return {"ok": True, "message": "Pause already requested."}
        return {"ok": False, "message": f"Cannot pause while state is {status['state']}."}

    def resume(self, key: str) -> dict[str, Any]:
        key = device_profiles.sanitize_key(key)
        control = self._controls.get(key)
        runtime = self._runtime_for(key)
        if not runtime.is_running or control is None:
            return {"ok": False, "message": f"{key} is not running."}
        control.resume()
        runtime._set_state("running")
        return {"ok": True, "message": "Resumed."}

    def stop(self, key: str) -> dict[str, Any]:
        key = device_profiles.sanitize_key(key)
        runtime = self._runtime_for(key)
        control = self._controls.get(key)
        with runtime._lock:
            thread = runtime._thread
            thread_alive = bool(thread and thread.is_alive())
            if not thread_alive:
                runtime._state = "idle"
                runtime._started_at = None
                return {"ok": True, "message": f"{key} is already stopped."}
            if control is not None:
                control.request_stop()
            runtime._state = "stopping"
        if thread:
            thread.join(timeout=20)
            if not thread.is_alive():
                with runtime._lock:
                    runtime._thread = None
                    runtime._control = None
                    runtime._started_at = None
                    if runtime._state != "error":
                        runtime._state = "idle"
                return {"ok": True, "message": f"Stopped {key}."}
        return {"ok": True, "message": f"Stop requested for {key}."}

    def stop_all(self) -> dict[str, Any]:
        stopped = []
        for device in self.list_adb_devices():
            key = device.get("key")
            if not key:
                continue
            if self.get_status(key)["is_running"]:
                self.stop(key)
                stopped.append(key)
        return {"ok": True, "message": f"Stopped {len(stopped)} device(s).", "stopped": stopped}

    def get_logs(self, key: str, limit: int = 400) -> list[str]:
        return LOG_HUB.get(device_profiles.sanitize_key(key), limit=limit)

    def clear_logs(self, key: str) -> None:
        LOG_HUB.clear(device_profiles.sanitize_key(key))

    # -- live telemetry --------------------------------------------------------
    def preview_interval(self, key: str) -> float:
        """Seconds between refreshed previews for one device.

        0 means every request is encoded fresh. Read from the device's own
        profile so one machine's choice does not decide for the others.
        """
        try:
            from utils import load_toml_as_dict

            with device_profiles.use_profile(key):
                raw = load_toml_as_dict(
                    "cfg/bot_config.toml").get("preview_interval_ms", 800)
            return max(0.0, float(raw) / 1000.0)
        except Exception:  # noqa: BLE001
            return 0.8

    def snapshot_jpeg(self, key: str, quality: int = 65, max_width: int = 480) -> bytes:
        """The device's newest scrcpy frame as JPEG (empty when unavailable).

        The frame is already in memory, so this costs a resize and an encode and
        nothing on the device side. Encoding the full 1280x720 every time was
        the reason the preview crawled, and the card shows it at about a fifth
        of that width, so it is scaled down first.

        Within the configured interval the previous picture is handed back
        unchanged. That is what makes the setting honest: the panel can ask as
        often as it likes and the refresh rate is still the one that was asked
        for, on any client.
        """
        key = device_profiles.sanitize_key(key)
        with self._lock:
            instance = self._instances.get(key)
        if instance is None:
            return b""
        try:
            frame, frame_time = instance.window_controller.latest_frame_copy()
        except Exception:
            return b""
        if frame is None:
            return b""

        interval = self.preview_interval(key)
        now = time.monotonic()
        cached = self._snapshots.get(key)
        if cached is not None:
            data, seen_frame, at = cached
            if now - at < interval:
                return data
            if seen_frame == frame_time:
                # Nothing new on screen. Re-encoding the same picture would only
                # burn CPU to produce the same bytes.
                return data

        data = instance.window_controller.frame_to_jpeg(
            frame, quality=quality, max_width=max_width)
        if data:
            self._snapshots[key] = (data, frame_time, now)
        return data

    def instance_for(self, key: str):
        """The running bot's own instance, or None when the bot is stopped.

        Used by the training recorder: the frames it saves come from the same
        scrcpy stream the bot is already receiving, so recording costs the game
        nothing and no second connection is opened to the device.
        """
        with self._lock:
            return self._instances.get(device_profiles.sanitize_key(key))

    def save_frame_jpeg(self, key: str, frame, path) -> bool:
        """Write one frame to disk as JPEG. Returns whether it got there."""
        if frame is None:
            return False
        try:
            encoded = WindowController.frame_to_jpeg(frame, quality=88)
            if not encoded:
                return False
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(encoded)
            return True
        except Exception:  # noqa: BLE001
            return False

    def telemetry(self, key: str) -> dict[str, Any]:
        """Live progress of one device: state, brawler, trophies, fps counters."""
        key = device_profiles.sanitize_key(key)
        with self._lock:
            instance = self._instances.get(key)
        status = self.get_status(key)
        if instance is None:
            return {**status, "has_instance": False}

        data: dict[str, Any] = {**status, "has_instance": True}
        try:
            data["detected_state"] = instance.get_latest_state()
        except Exception:
            data["detected_state"] = None
        try:
            # Gas has no visible UI, so expose what the model sees. Without this
            # there is no way to tell "no gas" apart from "detector broken".
            play = instance.Play
            data["gas"] = {
                "available": getattr(play, "Detect_gas", None) is not None,
                "boxes": len(getattr(play, "gas_boxes", []) or []),
                "escapes": getattr(play, "gas_escapes", 0),
                "danger_escapes": getattr(play, "gas_danger_escapes", 0),
                "danger": round(float(getattr(play, "gas_danger", 0.0)), 4),
                "coverage": round(float(getattr(play, "gas_coverage", 0.0)), 4),
            }
        except Exception:
            data["gas"] = None
        try:
            queue = instance.Stage_manager.brawlers_pick_data
            if queue:
                observer = instance.Stage_manager.Trophy_observer
                # Report the brawler the game actually put us on. queue[0] is only
                # a guess: the game sorts the whole roster, so it regularly
                # differs from our queue and used to make the panel name a brawler
                # that was not being played.
                try:
                    current_name = instance.Stage_manager.current_brawler()
                except Exception:
                    current_name = None
                data["brawler"] = current_name
                data["brawler_confirmed"] = bool(current_name)
                data["brawler_expected"] = queue[0].get("brawler")
                current = next((e for e in queue
                                if str(e.get("brawler", "")).lower() == str(data["brawler"]).lower()),
                               queue[0])
                data["push_type"] = current.get("type")
                data["push_until"] = current.get("push_until")
                data["trophies"] = getattr(observer, "current_trophies", None) if current_name else None
                data["wins"] = getattr(observer, "current_wins", None) if current_name else None
                data["win_streak"] = getattr(observer, "win_streak", None) if current_name else None
                try:
                    # Rate is built on the account total, not the per-brawler
                    # number: the brawler count restarts on every switch and
                    # disagrees with the brawler screen, so it cannot carry a rate.
                    data["trophy_rate"] = observer.account_rate_detail()
                    data["account_total"] = getattr(observer, "account_total", None)
                except Exception:
                    data["trophy_rate"] = None
                    data["account_total"] = getattr(observer, "account_total", None)
                data["queue_length"] = len(queue)
                data["next_brawler"] = queue[1].get("brawler") if len(queue) > 1 else None
                manager = instance.Stage_manager
                try:
                    data["games_on_brawler"] = getattr(manager, "games_on_current_brawler", None)
                except Exception:
                    data["games_on_brawler"] = None
                try:
                    # Under this device's profile, or the panel shows a number the
                    # bot is not actually using: the bot runs inside
                    # config_scope(profile), while an HTTP handler runs in its own
                    # thread where the profile is not open, so the same call
                    # returned the repository's value.
                    with device_profiles.use_profile(key):
                        data["switch_after_games"] = manager._switch_after_games()
                        data["brawler_sort_mode"] = manager.brawler_sort_mode()
                except Exception:
                    data["switch_after_games"] = None
                try:
                    # Proof of the last rotation. Without it the panel can only
                    # name the current brawler, which looks unchanged when a
                    # switch happened but its card name could not be read.
                    data["last_switch"] = manager.last_switch()
                except Exception:
                    data["last_switch"] = None
                data["auto_pick"] = all(item.get("automatically_pick") for item in queue)
        except Exception:
            pass
        try:
            controller = instance.window_controller
            _, frame_time = controller.get_latest_frame()
            data["frame_age"] = (time.time() - frame_time) if frame_time else None
            data["resolution"] = f"{controller.width}x{controller.height}" if controller.width else None
        except Exception:
            pass
        try:
            with device_profiles.use_profile(key):
                from utils import load_toml_as_dict

                data["playstyle"] = load_toml_as_dict("cfg/bot_config.toml").get("current_playstyle")
        except Exception:
            pass
        data["recent_matches"] = self._recent_match_stats(key)
        return data

    @staticmethod
    def _recent_match_stats(key: str, limit: int = 12) -> dict[str, Any] | None:
        """Trophies per match over the last few games.

        Read from the match history rather than kept in memory, so the number is
        still there after a restart and it is the same source the audit reports.
        Median is carried alongside the mean because a single reset of the
        per-brawler counter once turned +4.5/match into -0.9/match, and a mean
        alone cannot show when one bad record is doing that.
        """
        try:
            import csv
            import statistics
            from utils import resolve_project_path

            # Exactly where TrophyObserver writes. Resolving this through the
            # device profile picked up a leftover copy from a previous day and
            # reported a week-old average as if it were live.
            path = resolve_project_path("cfg", "match_history.csv")
            if not path.is_file():
                return None
            deltas = []
            with path.open("r", encoding="utf-8", newline="") as handle:
                for record in csv.DictReader(handle):
                    try:
                        deltas.append(int(record.get("trophy_delta") or ""))
                    except (TypeError, ValueError):
                        continue
            if not deltas:
                return None
            recent = deltas[-limit:]
            return {
                "mean": round(statistics.mean(recent), 1),
                "median": statistics.median(recent),
                "count": len(recent),
                "positive": sum(1 for value in recent if value > 0),
            }
        except Exception:  # noqa: BLE001
            return None
