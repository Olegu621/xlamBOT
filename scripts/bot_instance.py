"""A single bot instance bound to one ADB device.

``BotInstance`` is the per-device version of the loop that used to live inside
``main.xlambot_main``. Every instance owns its own ``WindowController`` (and therefore
its own scrcpy stream), its own play/queue state, and runs in its own thread inside
the device's config scope so several devices can be automated simultaneously.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from contextlib import nullcontext as _nullcontext

from adbutils import AdbError

from lobby_automation import LobbyAutomation
from play import Play
from stage_manager import StageManager
from state_finder import get_state
from time_management import TimeManagement
from utils import (
    cprint, clean_queue, game_mode_warning, gas_mode_warning, load_playstyle_script,
    load_toml_as_dict, notify_user, save_brawler_data,
)

# Imported as plain modules, not as device-scoped helpers: every instance already
# runs inside its own config_scope, so the state this file touches belongs to the
# thread's device rather than to whichever device loaded the module first.
from window_controller import StaleFrameError, WindowController


class BotHalt(RuntimeError):
    """Raised to unwind a bot instance that must stop (e.g. repeated crashes)."""


def apply_play_order(queue_data):
    """Order the queue as configured, unless that order is trophy-based.

    Ordering by trophies used the OCR count, and the front of the queue decides
    whose AI plays the match. A misread therefore handed the controls to the
    wrong brawler's playstyle. The game already sorts by "Least Trophies" and
    picks the real minimum, so trophy-based ordering is refused here rather than
    left as a trap behind a config flag.
    """
    play_order = str(load_toml_as_dict("cfg/general_config.toml").get("play_order", "in_order")).strip().lower()
    if play_order in ("lowest_to_highest", "highest_to_lowest"):
        print(f"Play order '{play_order}' would order the queue by OCR trophy counts, "
              "so it is ignored. The brawler is chosen by the game's own sort.")
        return queue_data
    return queue_data


class BotInstance:
    """Runs the xlamBOT bot loop against one ADB device."""

    def __init__(self, discord_bot, queue_data, stop_event=None, runtime_control=None,
                 serial=None, device_key=None, device_label=None):
        self.discord_bot = discord_bot
        self.serial = serial
        self.device_key = device_key
        self.device_label = device_label or serial or "device"
        self.started_at = time.time()
        self.latest_state = None
        self.latest_state_frame_time = 0.0
        self._error = ""

        current_playstyle = load_toml_as_dict("cfg/bot_config.toml").get("current_playstyle", "default_up.xlambot")
        raw_max_fps = load_toml_as_dict("cfg/general_config.toml").get("max_fps")
        try:
            self.max_fps = int(raw_max_fps)
        except (TypeError, ValueError):
            self.max_fps = None

        if self.max_fps:
            self.window_controller = WindowController(self.max_fps, serial=self.serial)
        else:
            self.window_controller = WindowController(serial=self.serial)
        if not self.serial:
            self.serial = self.window_controller.serial
            self.device_key = self.device_key or self.serial

        data = clean_queue(queue_data)
        data = apply_play_order(data)
        if not data:
            self.close()
            raise ValueError(
                "No valid brawler data found. Please add a brawler configuration for this device before starting the bot."
            )
        save_brawler_data(data)
        print(f"[{self.device_label}] Starting with queue data: {data}")

        self.playstyle_info, playstyle_code = load_playstyle_script(current_playstyle)
        self.mode_warning = game_mode_warning(self.playstyle_info)
        if self.mode_warning:
            print(f"[{self.device_label}] {self.mode_warning}")
        gas_warning = gas_mode_warning()
        if gas_warning:
            print(f"[{self.device_label}] {gas_warning}")
        self.Play = Play(*self.load_models(), self.window_controller, playstyle_code)
        self.Time_management = TimeManagement()
        self.lobby_automator = LobbyAutomation(self.window_controller)
        self.runtime_control = runtime_control
        self.Stage_manager = StageManager(
            data, self.lobby_automator, self.window_controller, self.playstyle_info,
            self.get_latest_state, runtime_control=runtime_control)

        self.states_requiring_data = ["lobby"]
        self.no_detections_action_threshold = 60 * 8
        self.state = None
        self.stop_event = stop_event
        self.state_lock = threading.Lock()
        self.latest_state_frame_time = 0.0
        self.max_cached_state_age = 1.0
        self.state_checker_stop_event = threading.Event()
        self.state_checker_thread = None
        self.update_trophy_observer()

        self.run_for_minutes = int(load_toml_as_dict("cfg/general_config.toml")['run_for_minutes'])
        self.webhook_ping_every_minutes = load_toml_as_dict("cfg/webhook_config.toml")['ping_every_x_minutes']
        self.time_since_last_webhook_ping = time.time()
        self.start_time = time.time()
        self.time_to_stop = False
        self.in_cooldown = False
        self.cooldown_start_time = 0
        self.cooldown_duration = 3 * 60
        self.window_controller.screenshot()
        self.register_window_controller()
        self.start_state_checker()
        print(f"[{self.device_label}] Initialization complete, starting main loop.")
        self.picked_first_brawler = False
        self._connection_lost_handled = 0.0
        self.time_since_checked_if_brawl_stars_crashed = time.time()
        self.check_if_brawl_stars_crashed_timer = load_toml_as_dict("cfg/time_tresholds.toml")["check_if_brawl_stars_crashed"]
        self.ping_when_stuck = load_toml_as_dict("cfg/webhook_config.toml")["ping_when_stuck"]

    def register_window_controller(self):
        if self.discord_bot is not None:
            try:
                self.discord_bot.set_window_controller(self.window_controller, device_key=self.device_key)
            except TypeError:
                self.discord_bot.set_window_controller(self.window_controller)

    def close(self):
        try:
            self.stop_state_checker()
            self.window_controller.release_movement()
            self.window_controller.close()
        except Exception as error:
            print(f"[{self.device_label}] Cleanup error: {error}")
        if self.discord_bot is not None:
            try:
                self.discord_bot.set_window_controller(None, device_key=self.device_key)
            except TypeError:
                self.discord_bot.set_window_controller(None)

    def update_trophy_observer(self):
        current_brawler_data = self.Stage_manager.brawlers_pick_data[0]
        self.Stage_manager.Trophy_observer.win_streak = current_brawler_data['win_streak']
        self.Stage_manager.Trophy_observer.current_trophies = current_brawler_data['trophies']
        self.Stage_manager.Trophy_observer.current_wins = current_brawler_data['wins'] if current_brawler_data['wins'] != "" else 0

    @staticmethod
    def load_models():
        folder_path = "./models/"
        return [
            folder_path + 'mainInGameModel.onnx',
            folder_path + 'tileDetector.onnx',
            folder_path + 'closeTileDetector.onnx',
        ]

    def restart_brawl_stars(self):
        self.window_controller.restart_brawl_stars()
        self.time_since_checked_if_brawl_stars_crashed = time.time()
        self.Play.time_since_detections["player"] = time.time()
        self.Play.time_since_detections["enemy"] = time.time()
        if not self.window_controller.is_brawl_stars_running():
            ping_when_stuck = load_toml_as_dict("cfg/webhook_config.toml")["ping_when_stuck"]
            if ping_when_stuck:
                screenshot = self.window_controller.screenshot()
                notify_user("bot_is_stuck", screenshot, self.Stage_manager)
                print(f"[{self.device_label}] Bot got stuck. User notified.")
            print(f"[{self.device_label}] Shutting down.")
            self.window_controller.release_movement()
            raise BotHalt("Brawl Stars could not be restarted.")

    def should_stop(self):
        return bool(self.stop_event and self.stop_event.is_set()) or \
            bool(self.runtime_control and self.runtime_control.should_stop())

    # A pause is only ever acted on between matches, so a pause request never
    # freezes the bot halfway through a game.
    def should_pause(self):
        return bool(self.runtime_control and self.runtime_control.should_pause())

    def sleep_interruptible(self, duration, allow_pause=True, poll_interval=0.1):
        end_time = time.time() + duration
        while time.time() < end_time:
            if self.should_stop():
                return "stop"
            if allow_pause and self.should_pause():
                return "pause"
            time.sleep(min(poll_interval, max(end_time - time.time(), 0)))
        return None

    def stop_gracefully(self):
        cprint(f"[{self.device_label}] Stop requested from UI - shutting down gracefully", "#AAE5A4")
        self.close()

    def start_state_checker(self):
        if self.state_checker_thread and self.state_checker_thread.is_alive():
            return
        self.state_checker_stop_event.clear()
        # The thread reads cfg/ and the models, so it needs the same config scope
        # as this one. Handing it the root explicitly is what keeps two devices
        # from sharing each other's lobby configuration.
        config_root = _current_config_root()
        self.state_checker_thread = threading.Thread(
            target=self.state_checker_loop,
            args=(config_root,),
            daemon=True,
            name=f"xlambot-state-checker-{self.device_key or 'default'}")
        # A dead checker would freeze the state on whatever it last saw, so a
        # fresh one is started whenever the previous run is gone.
        self.state_checker_thread.start()

    def stop_state_checker(self):
        self.state_checker_stop_event.set()
        if self.state_checker_thread and self.state_checker_thread.is_alive():
            self.state_checker_thread.join(timeout=1.0)

    def set_latest_state(self, state):
        with self.state_lock:
            self.state = state
            self.latest_state_frame_time = time.time()

    def get_latest_state(self):
        with self.state_lock:
            return self.state

    def handle_detected_state(self, state):
        if state != "match":
            self.window_controller.gameplay_frame_time = None
        if state is None:
            return
        if state == "connection_lost":
            # The connection-lost dialog is not a game state, so it must not be
            # stored as one: the bot would then believe it is somewhere it is
            # not. Tapping RETRY LOGIN is the whole handling.
            self.window_controller.screenshot()
            retry = load_toml_as_dict("cfg/lobby_config.toml").get(
                "template_matching", {}).get("connection_lost_retry", [618, 655])
            if not self._connection_lost_handled or time.time() - self._connection_lost_handled > 5:
                print(f"[{self.device_label}] Connection lost dialog, tapping RETRY LOGIN")
                self._connection_lost_handled = time.time()
            self.window_controller.click(retry[0], retry[1], already_include_ratio=False)
            return
        self.set_latest_state(state)
        print(f"[{self.device_label}] State: {state}")
        self.Stage_manager.do_state(state, None)
        if state != "match":
            self.Play.time_since_last_proceeding = time.time()

    def state_checker_loop(self, config_root=None):
        from utils import config_scope

        last_checked_frame_time = 0.0
        # Only frames newer than the last one are classified, so a frozen feed
        # costs nothing instead of re-running template matching on the same
        # picture. The scope is opened for the whole loop because every
        # get_state() lookup reads this device's templates.
        with config_scope(config_root) if config_root is not None else _nullcontext():
            while not self.state_checker_stop_event.is_set():
                frame, frame_time = self.window_controller.get_latest_frame()
                if frame is None or frame_time <= last_checked_frame_time:
                    self.state_checker_stop_event.wait(0.01)
                    continue

                last_checked_frame_time = frame_time
                try:
                    self.set_latest_state(get_state(frame))
                except Exception as error:
                    print(f"[{self.device_label}] State checker failed: {error}")
                self.state_checker_stop_event.wait(0.1)

    def wait_while_paused(self):
        if not self.runtime_control:
            return

        self.window_controller.release_movement()
        self.runtime_control.mark_paused()
        cprint(f"xlamBOT is paused in the lobby. Waiting for Start to resume. ({self.device_label})", "#AAE5A4")

        while self.should_pause() and not self.should_stop():
            state = self.get_latest_state()
            if state is None:
                if self.sleep_interruptible(0.25, allow_pause=False) == "stop":
                    return
                continue
            if self.sleep_interruptible(1, allow_pause=False) == "stop":
                return

        if not self.should_stop():
            self.runtime_control.mark_running()
            self.time_since_last_webhook_ping = time.time()
            print(f"[{self.device_label}] Pause released, resuming run.")

    def handle_pause_request(self):
        if self.should_pause() and not self.should_stop():
            cprint(f"Pause requested from UI - waiting ({self.device_label})", "#AAE5A4")
            self.wait_while_paused()

    def manage_time_tasks(self, frame):
        if self.Time_management.state_check():
            state = self.get_latest_state()
            if state is not None:
                self.handle_detected_state(state)
        if self.Time_management.no_detections_check():
            frame_data = self.Play.time_since_detections
            t_now = time.time()
            for key, value in frame_data.items():
                if t_now - value > self.no_detections_action_threshold:
                    self.restart_brawl_stars()
        if self.Time_management.idle_check():
            self.lobby_automator.check_for_idle(frame)

        current_time = time.time()
        if self.webhook_ping_every_minutes and current_time - self.time_since_last_webhook_ping >= self.webhook_ping_every_minutes * 60:
            screenshot = self.window_controller.screenshot()
            notify_user("regular_minutes_ping", screenshot, self.Stage_manager)
            self.time_since_last_webhook_ping = current_time
            print(f"[{self.device_label}] Sent regular webhook ping after {self.webhook_ping_every_minutes} minutes.")

    def check_and_handle_brawl_stars_crash(self):
        c_time = time.time()
        if c_time - self.time_since_checked_if_brawl_stars_crashed > self.check_if_brawl_stars_crashed_timer:
            try:
                process_alive = self.window_controller.brawl_stars_process_alive()

                # The process check is the cheap one and needs no ADB round trip,
                # so a dead game is caught even when the app_current() query
                # below would be answering about a screen saver.
                if not process_alive:
                    print(f"[{self.device_label}] Brawl Stars is not running - starting it...")
                    self.window_controller.launch_brawl_stars()
                    self.time_since_checked_if_brawl_stars_crashed = time.time()
                    return

                # A match can hand the foreground to a system dialog, so the
                # foreground is only trusted outside of one.
                if self.get_latest_state() in ("match", "match_making"):
                    self.time_since_checked_if_brawl_stars_crashed = c_time
                    return

                if not self.window_controller.is_brawl_stars_running():
                    print(f"[{self.device_label}] Brawl Stars lost the foreground - bringing it back...")
                    self.window_controller.launch_brawl_stars()
                    self.time_since_checked_if_brawl_stars_crashed = time.time()
                else:
                    self.time_since_checked_if_brawl_stars_crashed = c_time
            except AdbError:
                print(f"[{self.device_label}] ADB error while checking Brawl Stars - attempting to reconnect scrcpy...")
                if not self.window_controller.reconnect_scrcpy():
                    print(f"[{self.device_label}] Reconnect failed -- restarting Brawl Stars")
                    self.restart_brawl_stars()

    def main(self):
        s_time = time.time()
        c = 0
        self.time_since_last_webhook_ping = time.time()
        if self.runtime_control:
            self.runtime_control.mark_running()

        while True:
            # The stop check comes first, before any waiting, so a press of Stop
            # is honoured within one frame instead of after the current sleep.
            if self.should_stop():
                self.stop_gracefully()
                return

            if self.get_latest_state() == "lobby":
                if self.should_pause():
                    self.handle_pause_request()
                    if self.should_stop():
                        self.stop_gracefully()
                        return
                    if self.should_pause():
                        continue

            if not self.picked_first_brawler and self.get_latest_state() == "lobby":
                if self.Stage_manager.brawlers_pick_data[0]['automatically_pick']:
                    next_brawler_name = self.Stage_manager.brawlers_pick_data[0]['brawler']
                    print(f"[{self.device_label}] Picking brawler automatically")
                    if self.runtime_control:
                        self.runtime_control.mark_running()
                    if self.Stage_manager._pick_lowest_trophies():
                        select_brawler = self.lobby_automator.select_brawler_by_sort(
                            self.get_latest_state, runtime_control=self.runtime_control,
                            sort_point=self.Stage_manager.brawler_sort_point())
                        # Only the game's own sort knows the real minimum, so the
                        # name read from the card is what gets used from here on.
                        print(f"[{self.device_label}] Lowest-trophy pick returned: {select_brawler}")
                    else:
                        select_brawler = self.lobby_automator.select_brawler(
                            next_brawler_name, self.get_latest_state, runtime_control=self.runtime_control)

                    # A failed or errored selection leaves the bot in the lobby
                    # with no brawler chosen, so it is retried a few times and
                    # then given up on: an endless retry here is what used to
                    # keep the Stop button from doing anything.
                    for _attempt in range(3):
                        # None used to pass this test, which ended the retries and
                        # then recorded a pick that never happened.
                        if select_brawler == "success":
                            break
                        if select_brawler in ("aborted", "stuck"):
                            break
                        print(f"[{self.device_label}] Automatic brawler selection returned "
                              f"{select_brawler}, retrying.")
                        if self.ping_when_stuck:
                            screenshot = self.window_controller.screenshot()
                            notify_user("bot_failed_brawler_selection", screenshot, self.Stage_manager)
                        if self.sleep_interruptible(2) == "stop":
                            self.stop_gracefully()
                            break
                        select_brawler = self.lobby_automator.select_brawler_by_sort(
                            self.get_latest_state, runtime_control=self.runtime_control,
                            sort_point=self.Stage_manager.brawler_sort_point())

                    # "aborted" means a stop, "stuck" means the screen is no
                    # longer the brawler menu. Neither is a reason to press on.
                    if select_brawler in ("aborted", "stuck"):
                        continue
                    if select_brawler != "success":
                        # Nothing was chosen. Leave picked_first_brawler alone so
                        # the next lobby tick tries again rather than starting a
                        # match on whoever the game had selected before.
                        print(f"[{self.device_label}] First pick was not confirmed "
                              f"({select_brawler!r}); will retry on the next lobby tick.")
                        time.sleep(2)
                        continue

                    self.picked_first_brawler = True

                    # The pick is only real once it is written down, otherwise
                    # the trophy observer still points at the guessed brawler.
                    self.Stage_manager._adopt_picked_brawler(
                        self.Stage_manager.current_brawler(), 0)
                    self.update_trophy_observer()
                else:
                    self.picked_first_brawler = True

            t_now = time.time()
            frame_start = time.perf_counter() if self.max_fps else None

            if self.run_for_minutes > 0 and not self.in_cooldown:
                elapsed_time = (t_now - self.start_time) / 60
                if elapsed_time >= self.run_for_minutes:
                    cprint(f"[{self.device_label}] Timer done ({self.run_for_minutes} min). Continuing for 3 minutes if in game.", "#AAE5A4")
                    self.in_cooldown = True
                    self.cooldown_start_time = t_now
                    self.Stage_manager.states['lobby'] = lambda: 0

            if self.in_cooldown and t_now - self.cooldown_start_time >= self.cooldown_duration:
                cprint(f"[{self.device_label}] Stopping bot fully", "#AAE5A4")
                self.stop_gracefully()
                return

            if abs(s_time - t_now) > 1:
                elapsed = t_now - s_time
                if elapsed > 0:
                    print(f"[{self.device_label}] {c / elapsed:.2f} FPS")
                s_time = t_now
                c = 0

            self.check_and_handle_brawl_stars_crash()
            frame = self.window_controller.screenshot()

            _, last_ft = self.window_controller.get_latest_frame()
            if last_ft > 0 and (t_now - last_ft) > self.window_controller.FRAME_STALE_TIMEOUT:
                stale_age = t_now - last_ft
                self.Play.window_controller.release_movement()
                # A live stream with a still screen is a real pause (a match
                # loading, the emulator backgrounded), not a broken feed, so
                # reconnecting would only throw away a working connection.
                if self.window_controller.is_stream_alive() and stale_age <= 90:
                    if int(stale_age) % 30 < 1:
                        print(f"[{self.device_label}] Screen looks static for {stale_age:.0f}s (feed alive, continuing).")
                    continue
                if stale_age > 30:
                    print(f"[{self.device_label}] Scrcpy feed stale for {stale_age:.0f}s -- attempting reconnect")
                    if not self.window_controller.reconnect_scrcpy():
                        print(f"[{self.device_label}] Reconnect failed -- restarting Brawl Stars")
                        self.restart_brawl_stars()
                else:
                    print(f"[{self.device_label}] Stale frame detected -- pausing actions until feed resumes")
                    if self.sleep_interruptible(1) == "stop":
                        self.stop_gracefully()
                        return
                continue

            self.manage_time_tasks(frame)

            # queue[0] is our own guess about who plays; the game picks the
            # brawler itself. Feeding the guess into Play gave the match the
            # wrong attack range and wall rules.
            brawler = self.Stage_manager.current_brawler()
            if brawler is None:
                brawler = self.Stage_manager.brawlers_pick_data[0]['brawler']
            self.Play.current_brawler = brawler
            try:
                self.Play.main(frame, brawler, self)
            except StaleFrameError:
                self.window_controller.release_all_inputs()
                time.sleep(0.05)
                continue
            c += 1

            if self.max_fps:
                target_period = 1 / self.max_fps
                work_time = time.perf_counter() - frame_start
                if work_time < target_period:
                    time.sleep(target_period - work_time)


def _current_config_root():
    from utils import get_config_root

    return get_config_root()


def run_bot_instance(discord_bot, queue_data, stop_event=None, runtime_control=None,
                     serial=None, device_key=None, device_label=None, instance_callback=None):
    """Create and run one bot instance, converting crashes into a clean halt."""
    try:
        os.makedirs("debug_frames", exist_ok=True)
        instance = BotInstance(
            discord_bot, queue_data,
            stop_event=stop_event,
            runtime_control=runtime_control,
            serial=serial,
            device_key=device_key,
            device_label=device_label,
        )
    except Exception as error:
        print(f"[{device_label or serial or 'device'}] Failed to start: {error}")
        return {"ok": False, "message": str(error)}

    if instance_callback is not None:
        try:
            instance_callback(instance)
        except Exception as error:
            print(f"[{device_label or serial or 'device'}] Could not register instance: {error}")

    try:
        instance.main()
    except BotHalt as halt:
        instance.close()
        return {"ok": False, "message": str(halt)}
    except SystemExit as exit_error:
        instance.close()
        code = exit_error.code if isinstance(exit_error.code, int) else 0
        return {"ok": code in (0, None), "message": f"xlamBOT exited with code {code}."}
    except Exception as error:
        instance.close()
        return {"ok": False, "message": str(error)}
    finally:
        try:
            instance.close()
        except Exception:
            pass
    return {"ok": True, "message": "xlamBOT finished."}
