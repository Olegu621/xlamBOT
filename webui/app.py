from __future__ import annotations
import os

from datetime import date
import hmac
import logging
import secrets
import threading
from urllib.parse import urlsplit

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException

from discord_bot import DiscordBot
from utils import clean_queue, game_mode_warning, gas_mode_warning, get_brawler_icon_path, \
    resolve_project_path, resolve_within, save_dict_as_toml, resolve_config_path, \
    load_toml_as_dict
import device_profiles
from .device_manager import DeviceRuntimeManager
from .runtime import RuntimeManager
from .services import WebDataService


class _SuppressRuntimeStatusPolling(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            '"GET /api/queue ' in message
            and ' 200 -' in message
        )

class _SuppressQueuePolling(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            '"GET /api/runtime/status ' in message
            and ' 200 -' in message
        )

class _SuppressAssetsGetting(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            'GET /api/assets' in message
        )

class _SupressHistoryPolling(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            'GET /api/history' in message
            and ' 200 -' in message
        )

class _SuppressWebhookPutting(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            'PUT /api/webhook ' in message
        )

class _SuppressDevicePolling(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            ('GET /api/devices ' in message
             or 'GET /api/devices/status ' in message
             or 'GET /api/devices/' in message)
            and ' 200 -' in message
        )

def _configure_request_logging():
    werkzeug_logger = logging.getLogger("werkzeug")
    if not any(isinstance(log_filter, _SuppressRuntimeStatusPolling) for log_filter in werkzeug_logger.filters):
        werkzeug_logger.addFilter(_SuppressRuntimeStatusPolling())
    if not any(isinstance(log_filter, _SuppressQueuePolling) for log_filter in werkzeug_logger.filters):
        werkzeug_logger.addFilter(_SuppressQueuePolling())
    if not any(isinstance(log_filter, _SuppressAssetsGetting) for log_filter in werkzeug_logger.filters):
        werkzeug_logger.addFilter(_SuppressAssetsGetting())
    if not any(isinstance(log_filter, _SupressHistoryPolling) for log_filter in werkzeug_logger.filters):
        werkzeug_logger.addFilter(_SupressHistoryPolling())
    if not any(isinstance(log_filter, _SuppressWebhookPutting) for log_filter in werkzeug_logger.filters):
        werkzeug_logger.addFilter(_SuppressWebhookPutting())
    if not any(isinstance(log_filter, _SuppressDevicePolling) for log_filter in werkzeug_logger.filters):
        werkzeug_logger.addFilter(_SuppressDevicePolling())



def _start_discord_bot_thread(app: Flask):
    discord_bot = app.config["discord_bot"]
    with app.config["discord_bot_lock"]:
        discord_thread = app.config.get("discord_bot_thread")
        if discord_thread and discord_thread.is_alive():
            return

        discord_thread = threading.Thread(
            target=discord_bot.run_bot,
            daemon=True,
            name="xlambot-discord-bot",
        )
        app.config["discord_bot_thread"] = discord_thread
        discord_thread.start()


def create_app(xlambot_main, start_discord_bot=False):
    app = Flask(
        __name__,
        template_folder=str(resolve_project_path("templates")),
        static_folder=str(resolve_project_path("static")),
    )
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
    app.config["UI_API_TOKEN"] = secrets.token_urlsafe(32)

    runtime_manager = RuntimeManager(xlambot_main)
    data_service = WebDataService(runtime_manager)
    discord_bot = DiscordBot(runtime_manager, data_service)
    runtime_manager.configure_start_gate(data_service.get_queue_data, data_service.get_auth_state)
    device_manager = DeviceRuntimeManager(xlambot_main, discord_bot)
    device_manager.configure_queue_provider(device_profiles.load_queue)
    app.config["runtime_manager"] = runtime_manager
    app.config["data_service"] = data_service
    app.config["discord_bot"] = discord_bot
    app.config["device_manager"] = device_manager
    app.config["discord_bot_thread"] = None
    app.config["discord_bot_lock"] = threading.Lock()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    _configure_request_logging()

    def _parsed_request_host():
        try:
            return urlsplit(f"//{request.host}")
        except ValueError:
            return None

    def _is_allowed_origin(origin: str) -> bool:
        try:
            parsed_origin = urlsplit(origin)
            parsed_host = _parsed_request_host()
            if parsed_host is None:
                return False
            return (
                parsed_origin.scheme in {"http", "https"}
                and parsed_origin.hostname in {"127.0.0.1", "localhost", "::1"}
                and parsed_origin.hostname == parsed_host.hostname
                and parsed_origin.port == parsed_host.port
            )
        except ValueError:
            return False

    @app.before_request
    def protect_local_control_api():
        parsed_host = _parsed_request_host()
        if parsed_host is None or parsed_host.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return jsonify({
                "ok": False,
                "message": "Invalid local UI host.",
                "code": "INVALID_LOCAL_HOST",
            }), 403

        if not request.path.startswith("/api/") or request.path.startswith("/api/assets/"):
            return None

        supplied_token = str(request.headers.get("X-Xlam-UI-Token", ""))
        if not hmac.compare_digest(supplied_token, app.config["UI_API_TOKEN"]):
            return jsonify({
                "ok": False,
                "message": "Invalid local UI session.",
                "code": "INVALID_UI_SESSION",
            }), 403

        origin = str(request.headers.get("Origin", "")).strip()
        if origin and not _is_allowed_origin(origin):
            return jsonify({
                "ok": False,
                "message": "Cross-origin local API request rejected.",
                "code": "INVALID_UI_ORIGIN",
            }), 403

        return None

    @app.after_request
    def add_local_security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            ui_api_token=app.config["UI_API_TOKEN"],
        )

    @app.get("/panel")
    def panel():
        # Cache-bust the panel assets. Without it the browser keeps serving the
        # old css/js after an edit, which looks like the change did not apply.
        assets = [
            resolve_project_path("static", "css", "panel.css"),
            resolve_project_path("static", "js", "panel.js"),
        ]
        newest = 0.0
        for asset in assets:
            try:
                newest = max(newest, os.path.getmtime(asset))
            except OSError:
                continue
        return render_template(
            "panel.html",
            ui_api_token=app.config["UI_API_TOKEN"],
            asset_version=int(newest) if newest else 0,
        )

    # --- Multi-device panel API ----------------------------------------------
    def _device_key_arg():
        key = str(request.args.get("key") or (request.get_json(silent=True) or {}).get("key") or "").strip()
        if not key:
            raise KeyError("A device key is required.")
        return device_profiles.sanitize_key(key)

    @app.get("/api/devices/brawlers")
    def device_brawlers():
        return jsonify({"ok": True, "brawlers": data_service.get_brawler_catalog()})

    @app.get("/api/devices/modes")
    def device_modes():
        from lobby_automation import LobbyAutomation

        config = load_toml_as_dict("cfg/modes_config.toml")
        modes = []
        for key, name in (config.get("mode") or {}).items():
            modes.append({
                "key": str(key),
                "name": str(name),
                "calibrated": bool((config.get(key) or {}).get("calibrated")),
            })
        return jsonify({
            "ok": True,
            "modes": modes,
            "mode_button": config.get("mode_button"),
        })

    @app.post("/api/devices/<path:key>/mode")
    def device_set_mode(key: str):
        key = device_profiles.sanitize_key(key)
        body = request.get_json(silent=True) or {}
        mode = str(body.get("mode", "") or "").strip()
        config = load_toml_as_dict("cfg/modes_config.toml")
        if mode and mode not in (config.get("mode") or {}):
            return jsonify({"ok": False, "message": f"Unknown game mode '{mode}'."}), 400
        with device_profiles.use_profile(key):
            lobby = load_toml_as_dict("cfg/lobby_config.toml")
            lobby["game_mode"] = mode
            save_dict_as_toml(lobby, "cfg/lobby_config.toml")
        return jsonify({"ok": True, "mode": mode,
                        "calibrated": not mode or bool((config.get(mode) or {}).get("calibrated"))})

    @app.post("/api/devices/<path:key>/mode/calibrate")
    def device_calibrate_mode(key: str):
        """Store the coordinates of the mode button and one mode tile.

        The user clicks them on a live screenshot, which is the only reliable
        source: the lobby layout differs between emulators and phones.
        """
        key = device_profiles.sanitize_key(key)
        body = request.get_json(silent=True) or {}
        mode = str(body.get("mode", "") or "").strip()
        tile = body.get("tile")
        config = load_toml_as_dict("cfg/modes_config.toml")
        if not mode or mode not in (config.get("mode") or {}):
            return jsonify({"ok": False, "message": "Unknown game mode."}), 400
        with device_profiles.use_profile(key):
            path = resolve_config_path("cfg/modes_config.toml")
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
            if body.get("mode_button"):
                button = [int(body["mode_button"][0]), int(body["mode_button"][1])]
                config["mode_button"] = button
            entry = dict(config.get(mode) or {})
            if tile:
                entry["tile"] = [int(tile[0]), int(tile[1])]
                entry["calibrated"] = True
            config[mode] = entry
            save_dict_as_toml(config, "cfg/modes_config.toml")
        return jsonify({"ok": True, "mode": mode, "entry": config.get(mode),
                        "mode_button": config.get("mode_button")})

    @app.get("/api/devices")
    def list_devices():
        devices = DeviceRuntimeManager.list_adb_devices()
        if devices and "ok" in devices[0]:
            return jsonify({"ok": False, "message": devices[0].get("message", "ADB unavailable"), "devices": []}), 200
        statuses = {status["key"]: status for status in device_manager.all_statuses()}
        for device in devices:
            device["runtime"] = statuses.get(device["key"], {
                "state": "idle", "is_running": False, "last_error": "",
                "started_at": None, "uptime_seconds": None,
            })
            try:
                device["meta"] = device_profiles.read_profile_meta(device["key"])
            except Exception:
                device["meta"] = {}
            # Mismatches we can prove: a playstyle written for another mode, and
            # gas avoidance switched on where the game has no gas. Both are read
            # in the device's own profile, or one device's mode would speak for
            # all.
            try:
                with device_profiles.use_profile(device["key"]):
                    device["mode_warning"] = game_mode_warning()
                    device["gas_warning"] = gas_mode_warning()
            except Exception:
                device["mode_warning"] = None
                device["gas_warning"] = None
        return jsonify({"ok": True, "devices": devices, "profiles": device_profiles.list_profiles()})

    @app.get("/api/devices/status")
    def devices_status():
        return jsonify({"ok": True, "runtimes": device_manager.all_statuses()})

    @app.post("/api/devices/connect")
    def device_connect():
        payload = request.get_json(silent=True) or {}
        return jsonify(DeviceRuntimeManager.connect_network_device(payload.get("address", "")))

    @app.post("/api/devices/disconnect")
    def device_disconnect():
        payload = request.get_json(silent=True) or {}
        return jsonify(DeviceRuntimeManager.disconnect_network_device(payload.get("address", "")))

    @app.post("/api/devices/prepare")
    def device_prepare():
        payload = request.get_json(silent=True) or {}
        serial = str(payload.get("serial") or "").strip()
        if not serial:
            raise KeyError("A device serial is required.")
        width = int(payload.get("width") or 1920)
        height = int(payload.get("height") or 1080)
        return jsonify(DeviceRuntimeManager.prepare_device(serial, width, height))

    @app.post("/api/devices/reset-display")
    def device_reset_display():
        payload = request.get_json(silent=True) or {}
        serial = str(payload.get("serial") or "").strip()
        if not serial:
            raise KeyError("A device serial is required.")
        return jsonify(DeviceRuntimeManager.reset_device_display(serial))

    @app.post("/api/devices/selftest")
    def device_selftest():
        payload = request.get_json(silent=True) or {}
        serial = str(payload.get("serial") or "").strip()
        if not serial:
            raise KeyError("A device serial is required.")
        return jsonify(DeviceRuntimeManager.selftest_device(serial))

    @app.get("/api/devices/<path:key>/queue")
    def device_queue(key: str):
        return jsonify({"ok": True, "items": device_profiles.load_queue(key)})

    @app.post("/api/devices/<path:key>/queue")
    def device_queue_save(key: str):
        payload = request.get_json(silent=True) or {}
        items = payload.get("items")
        if not isinstance(items, list):
            raise KeyError("A list of queue items is required.")
        device_profiles.save_queue(key, items)
        return jsonify({"ok": True, "items": device_profiles.load_queue(key)})

    @app.get("/api/devices/<path:key>/brawler")
    def device_brawler(key: str):
        """The one brawler this device plays, or "" when it rotates."""
        key = device_profiles.sanitize_key(key)
        with device_profiles.use_profile(key):
            locked = str(load_toml_as_dict("cfg/bot_config.toml").get("locked_brawler") or "").strip()
        return jsonify({"ok": True, "locked_brawler": locked})

    @app.post("/api/devices/<path:key>/brawler")
    def device_set_brawler(key: str):
        """Play exactly one brawler, or go back to rotating.

        The name is checked against the same table play.py reads, because a
        spelling the game does not know would leave the bot stuck on whichever
        card it happened to be on - which is the failure this whole mode exists
        to remove.
        """
        key = device_profiles.sanitize_key(key)
        body = request.get_json(silent=True) or {}
        name = str(body.get("brawler") or "").strip().lower()

        catalog = {str(entry.get("name") or "").strip().lower()
                   for entry in (data_service.get_brawler_catalog() or [])}
        if name and name not in catalog:
            raise KeyError(f"'{name}' is not a known brawler.")

        trophies = 0
        for entry in device_profiles.load_queue(key):
            if str(entry.get("brawler", "")).strip().lower() == name:
                trophies = entry.get("trophies") or 0
                break

        with device_profiles.use_profile(key):
            device_profiles.update_settings(
                key, "cfg/bot_config.toml", {"locked_brawler": name})
        if name:            device_profiles.save_queue(key, [{
                "brawler": name,
                "type": "trophies",
                # No goal: in this mode there is nothing to finish and move on
                # from, so a target the bot could reach would only stop it.
                "push_until": 100000,
                "trophies": trophies,
                "wins": 0,
                "win_streak": 0,
                "automatically_pick": True,
            }])
        return jsonify({"ok": True, "locked_brawler": name,
                        "items": device_profiles.load_queue(key)})

    @app.get("/api/devices/<path:key>/settings")
    def device_settings(key: str):
        return jsonify({"ok": True, "settings": device_profiles.read_settings(key)})

    @app.post("/api/devices/<path:key>/settings")
    def device_settings_update(key: str):
        payload = request.get_json(silent=True) or {}
        section = str(payload.get("section") or "").strip()
        updates = payload.get("values")
        if not section or not isinstance(updates, dict):
            raise KeyError("Both 'section' and 'values' are required.")
        return jsonify({"ok": True, "settings": device_profiles.update_settings(key, section, updates)})

    @app.post("/api/devices/<path:key>/start")
    def device_start(key: str):
        payload = request.get_json(silent=True) or {}
        result = device_manager.start(key, payload.get("serial"))
        status_code = 200 if result.get("ok") else (400 if result.get("code") else 409)
        return jsonify({**result, "runtime": device_manager.get_status(key)}), status_code

    @app.post("/api/devices/<path:key>/pause")
    def device_pause(key: str):
        result = device_manager.pause(key)
        return jsonify({**result, "runtime": device_manager.get_status(key)}), 200 if result.get("ok") else 409

    @app.post("/api/devices/<path:key>/resume")
    def device_resume(key: str):
        result = device_manager.resume(key)
        return jsonify({**result, "runtime": device_manager.get_status(key)}), 200 if result.get("ok") else 409

    @app.post("/api/devices/<path:key>/stop")
    def device_stop(key: str):
        result = device_manager.stop(key)
        return jsonify({**result, "runtime": device_manager.get_status(key)}), 200 if result.get("ok") else 409

    @app.post("/api/devices/stop-all")
    def devices_stop_all():
        result = device_manager.stop_all()
        return jsonify({**result, "runtimes": device_manager.all_statuses()})

    @app.get("/api/devices/<path:key>/logs")
    def device_logs(key: str):
        limit = int(request.args.get("limit", 400))
        return jsonify({"ok": True, "logs": device_manager.get_logs(key, limit=limit)})

    @app.delete("/api/devices/<path:key>/logs")
    def device_logs_clear(key: str):
        device_manager.clear_logs(key)
        return jsonify({"ok": True, "logs": []})

    @app.get("/api/devices/<path:key>/telemetry")
    def device_telemetry(key: str):
        return jsonify({"ok": True, "telemetry": device_manager.telemetry(key)})

    @app.get("/api/devices/<path:key>/snapshot")
    def device_snapshot(key: str):
        image = device_manager.snapshot_jpeg(key)
        if not image:
            return ("", 404)
        response = app.response_class(image, mimetype="image/jpeg")
        response.headers["Cache-Control"] = "no-store"
        # Tell the panel how often this picture is really being refreshed, so the
        # setting in the settings page is what governs it and not a number
        # hardcoded in the browser.
        response.headers["X-Preview-Interval-Ms"] = str(
            int(device_manager.preview_interval(key) * 1000))
        return response

    @app.get("/api/bootstrap")
    def bootstrap():
        return jsonify(data_service.get_bootstrap_payload())

    @app.errorhandler(KeyError)
    @app.errorhandler(FileNotFoundError)
    @app.errorhandler(ValueError)
    def handle_known_errors(error):
        app.logger.warning("Handled request error at %s: %s", request.path, error)
        return jsonify({"ok": False, "message": str(error)}), 400

    @app.errorhandler(Exception)
    def handle_unexpected_error(error):
        if isinstance(error, HTTPException):
            return error
        app.logger.exception("Unhandled request error at %s", request.path)
        return jsonify({"ok": False, "message": str(error)}), 500

    @app.get("/api/queue")
    def get_queue():
        return jsonify({"items": data_service.get_queue_data()})

    @app.post("/api/queue")
    def add_queue():
        payload = request.get_json(silent=True) or {}
        items = data_service.add_or_update_queue_item(payload)
        return jsonify({"ok": True, "items": items})

    @app.post("/api/queue/import")
    def import_queue():
        uploaded_file = request.files.get("file")
        items = data_service.import_queue_file(uploaded_file)
        return jsonify({"ok": True, "items": items})

    @app.put("/api/queue/<path:brawler_name>")
    def update_queue_item(brawler_name: str):
        payload = request.get_json(silent=True) or {}
        payload["brawler"] = brawler_name
        items = data_service.add_or_update_queue_item(payload)
        return jsonify({"ok": True, "items": items})

    @app.post("/api/queue/reorder")
    def reorder_queue():
        payload = request.get_json(silent=True) or {}
        items = data_service.reorder_queue(payload.get("order", []))
        return jsonify({"ok": True, "items": items})

    @app.delete("/api/queue")
    def clear_queue():
        items = data_service.clear_queue()
        return jsonify({"ok": True, "items": items})

    @app.delete("/api/queue/<path:brawler_name>")
    def delete_queue_item(brawler_name: str):
        items = data_service.delete_queue_item(brawler_name)
        return jsonify({"ok": True, "items": items})

    @app.get("/api/playstyles")
    def get_playstyles():
        return jsonify(data_service.get_playstyles_payload())

    @app.post("/api/playstyles/import")
    def import_playstyle():
        uploaded_file = request.files.get("file")
        result = data_service.import_playstyle(uploaded_file)
        return jsonify(result)
    @app.delete("/api/playstyles/<path:filename>")
    def delete_playstyle(filename: str):
        result = data_service.delete_playstyle(filename)
        return jsonify(result)

    @app.put("/api/playstyles/active")
    def activate_playstyle():
        payload = request.get_json(silent=True) or {}
        result = data_service.activate_playstyle(payload.get("filename", ""))
        return jsonify(result)

    @app.get("/api/settings/<section>")
    def get_settings(section: str):
        return jsonify(data_service.get_settings_payload(section))

    @app.put("/api/settings/<section>")
    def update_settings(section: str):
        payload = request.get_json(silent=True) or {}
        return jsonify(data_service.update_settings(section, payload))

    @app.post("/api/settings/<section>/reset")
    def reset_settings(section: str):
        return jsonify(data_service.reset_settings(section))

    @app.post("/api/runtime/start")
    def runtime_start():
        result = runtime_manager.start_current_queue(discord_bot)
        if result.get("ok"):
            status_code = 200
        elif result.get("code") == "EMPTY_QUEUE":
            status_code = 400
        elif "auth" in result:
            status_code = 403
        else:
            status_code = 409
        return jsonify({**result, "runtime": runtime_manager.get_status()}), status_code

    @app.get("/api/runtime/status")
    def runtime_status():
        return jsonify({"ok": True, "runtime": runtime_manager.get_status()})

    @app.post("/api/runtime/pause")
    def runtime_pause():
        result = runtime_manager.pause()
        status_code = 200 if result.get("ok") else 409
        return jsonify({**result, "runtime": runtime_manager.get_status()}), status_code

    @app.post("/api/runtime/stop")
    def runtime_stop():
        result = runtime_manager.stop()
        status_code = 200 if result.get("ok") else 409
        return jsonify({**result, "runtime": runtime_manager.get_status()}), status_code

    @app.get("/api/runtime/logs")
    def runtime_logs():
        return jsonify({"ok": True, "logs": runtime_manager.get_logs()})

    @app.delete("/api/runtime/logs")
    def clear_runtime_logs():
        runtime_manager.clear_logs()
        return jsonify({"ok": True, "items": []})

    @app.get("/api/history")
    def history():
        start_date_raw = str(request.args.get("start_date", "")).strip()
        end_date_raw = str(request.args.get("end_date", "")).strip()
        try:
            start_date = date.fromisoformat(start_date_raw) if start_date_raw else None
            end_date = date.fromisoformat(end_date_raw) if end_date_raw else None
        except ValueError:
            return jsonify({
                "ok": False,
                "message": "History dates must use the YYYY-MM-DD format.",
            }), 400

        if start_date and end_date and start_date > end_date:
            return jsonify({
                "ok": False,
                "message": "The history start date must be on or before the end date.",
            }), 400

        return jsonify(data_service.get_match_history_payload(
            start_date=start_date,
            end_date=end_date,
        ))

    @app.get("/api/assets/brawlers/<path:brawler_name>")
    def brawler_icon(brawler_name: str):
        icon_path = get_brawler_icon_path(brawler_name)
        if icon_path is None:
            return ("", 404)
        return send_file(icon_path)

    @app.get("/api/assets/support/<path:filename>")
    def support_asset(filename: str):
        try:
            target = resolve_within("images", filename)
        except ValueError:
            return ("", 404)
        if not target.is_file():
            return ("", 404)
        return send_file(target)

    if start_discord_bot:
        _start_discord_bot_thread(app)

    return app
