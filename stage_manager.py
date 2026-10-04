import sys
import time
import cv2

from state_finder import get_state, is_underdog
from trophy_observer import TrophyObserver, MatchResult
from utils import find_template_center, load_toml_as_dict, notify_user, save_brawler_data

def load_image(image_path, scale_factor):
    image = cv2.imread(image_path)
    if image is None:
        return None
    orig_height, orig_width = image.shape[:2]

    new_width = int(orig_width * scale_factor)
    new_height = int(orig_height * scale_factor)

    resized_image = cv2.resize(image, (new_width, new_height))
    return resized_image


# Whether a trophy goal should steer the bot. Off on purpose: the number behind
# it is an OCR guess that contradicts the brawler screen often enough that
# acting on it switched brawlers at random, and an empty queue made the bot stop.
# The game sorts by "Least Trophies" and picks the real minimum on its own.
USE_TROPHY_TARGETS = False


class StageManager:
    def __init__(self, brawlers_data, lobby_automator, window_controller, playstyle_info, state_getting, runtime_control=None):
        self.games_on_current_brawler = 0
        # Guards the per-game counter against the lobby being reported on every
        # tick. Reset once a game actually starts.
        self._game_counted = False
        self._confirmed_brawler = None
        # Which card of the sorted grid to take this time. The first card
        # stays the same brawler for dozens of matches on this account, so
        # the position has to move for the switch to mean anything.
        self._rotation_card = 0
        # What the last rotation actually did, so the panel can show proof
        # of the switch instead of only the current brawler.
        self._last_switch = None
        # Which brawler the one-brawler mode has already put us on, and whether
        # that pick was confirmed. start_game is called on every lobby tick, so
        # without this the menu would be reopened constantly.
        self._lock_name = None
        self._lock_ok = False
        # The lobby counters are read once per visit, not on every tick: the
        # read is OCR and the lobby is reported several times a second.
        self._lobby_synced = False
        self.Lobby_automation = lobby_automator
        self.lobby_config = load_toml_as_dict("./cfg/lobby_config.toml")
        self.close_popup_icon = None
        self.brawlers_pick_data = brawlers_data
        self.Trophy_observer = TrophyObserver()
        # A restart should resume the trophy measurement, not restart it: the
        # last account total is both the drift baseline and the reader's anchor.
        self.Trophy_observer.load_account_state()
        self.time_since_last_stat_change = time.time()
        self.play_again_on_win = load_toml_as_dict("./cfg/bot_config.toml")["play_again_on_win"] == "yes"
        self.window_controller = window_controller
        self.states = {
            'shop': self.quit_shop,
            'brawler_selection': self.quit_shop,
            'popup': self.close_pop_up,
            'match': lambda: 0,
            'match_making': lambda: 0,
            'lobby': self.start_game,
            'star_drop_regular': lambda: self.click_star_drop("regular"),
            'star_drop_angelic': lambda: self.click_star_drop("angelic"),
            'star_drop_demonic': lambda: self.click_star_drop("demonic"),
            'star_drop_starr_nova': lambda: self.click_star_drop("starr_nova"),
            'trophy_reward': lambda: self.window_controller.press("proceed"),
            'prestige_milestone': lambda: self.window_controller.press("continue_or_equip"),
            'end_draw': self.end_game,
            'end_victory': self.end_game,
            'end_defeat': self.end_game,
            'end_trio_showdown_0': self.end_game,
            'end_trio_showdown_1': self.end_game,
            'end_trio_showdown_2': self.end_game,
            'end_trio_showdown_3': self.end_game,
        }
        self.matches_since_last_webhook_ping = 0
        self.ping_every_x_match = load_toml_as_dict("cfg/webhook_config.toml")['ping_every_x_match']
        self.runtime_control = runtime_control
        self.ping_when_stuck = load_toml_as_dict("cfg/webhook_config.toml")["ping_when_stuck"]
        self.playstyle_info = playstyle_info
        self.get_latest_state = state_getting

    def _should_stop(self):
        return bool(self.runtime_control and self.runtime_control.should_stop())

    def _should_pause(self):
        return bool(self.runtime_control and self.runtime_control.should_pause())

    def _sleep_interruptible(self, duration, allow_pause=True, poll_interval=0.1):
        end_time = time.time() + duration
        while time.time() < end_time:
            if self._should_stop():
                return True
            if allow_pause and self._should_pause():
                return True
            time.sleep(min(poll_interval, max(end_time - time.time(), 0)))
        return False

    @staticmethod
    def validate_trophies(trophies_string):
        trophies_string = trophies_string.lower()
        while "s" in trophies_string:
            trophies_string = trophies_string.replace("s", "5")
        numbers = ''.join(filter(str.isdigit, trophies_string))

        if not numbers:
            return False

        trophy_value = int(numbers)
        return trophy_value

    def _entry_trophies(self, entry):
        """Trophies of a queue entry, tolerating blanks from the panel."""
        try:
            return int(str(entry.get("trophies")).strip())
        except (TypeError, ValueError, AttributeError):
            return 0

    def _switch_after_games(self):
        """How many games to spend on one brawler; 0 disables the rotation."""
        if self.locked_brawler():
            # A locked brawler has no quota: it is the whole plan. Leaving the
            # counter live would rotate away from it on the next match, which is
            # the exact opposite of what was asked for.
            return 0
        raw = load_toml_as_dict("./cfg/bot_config.toml").get("brawler_switch_after_games", 7)
        try:
            return max(0, int(raw))
        except (TypeError, ValueError):
            return 7

    def locked_brawler(self):
        """The one brawler to play, or "" when the normal rotation is wanted."""
        raw = load_toml_as_dict("./cfg/bot_config.toml").get("locked_brawler", "") or ""
        return str(raw).strip().lower()

    def _lock_queue_to(self, name):
        """Keep exactly one brawler in the queue: the chosen one.

        The queue is still what the rest of the code reads - the trophy observer,
        the push target, the panel - so locking means shrinking it to one entry
        rather than teaching everything a second shape of input. The trophies we
        already knew are carried over, so the per-hour rate keeps its history
        instead of restarting at zero.
        """
        current = self.brawlers_pick_data[0] if self.brawlers_pick_data else None
        if current and str(current.get("brawler", "")).strip().lower() == name:
            return False
        trophies = 0
        wins = 0
        for entry in self.brawlers_pick_data:
            if str(entry.get("brawler", "")).strip().lower() == name:
                trophies = entry.get("trophies") or 0
                wins = entry.get("wins") or 0
                break
        self.brawlers_pick_data = [{
            "brawler": name,
            "type": "trophies",
            # Far above anything a push can reach: the target branch must not
            # fire, and the bot must not stop itself for finishing a goal that
            # was never set.
            "push_until": 100000,
            "trophies": trophies,
            "wins": wins,
            "win_streak": 0,
            "automatically_pick": True,
        }]
        print(f"Playing one brawler only: {name}.")
        return True

    def _select_locked_brawler(self, name):
        """Pick the locked brawler in the menu, a bounded number of times.

        start_game runs on every lobby tick, so an unguarded call here would
        reopen the brawler menu every couple of seconds forever. The choice is
        remembered instead: made once, and only redone if the game is later seen
        on somebody else.
        """
        if self._lock_name != name:
            self._lock_name = name
            self._lock_ok = False
        if self._lock_ok:
            return
        current = self.current_brawler()
        if current and str(current).strip().lower() == name:
            self._lock_ok = True
            return

        previous = current
        result = self.Lobby_automation.select_brawler(
            name, self.get_latest_state, runtime_control=self.runtime_control)
        for _try in range(self.BRAWLER_PICK_ATTEMPTS):
            if result not in ("failed", "error", "aborted", "stuck"):
                break
            if self._should_stop() or self._should_pause():
                return
            print(f"Selecting {name} returned {result!r}, attempt {_try + 1} "
                  f"of {self.BRAWLER_PICK_ATTEMPTS}")
            if self._sleep_interruptible(2):
                return
            result = self.Lobby_automation.select_brawler(
                name, self.get_latest_state, runtime_control=self.runtime_control)

        if result == "success":
            self._lock_ok = True
            self._adopt_picked_brawler(previous, 0)
            print(f"On {name}, and staying on it.")
        elif result in ("aborted", "stuck"):
            self._lock_ok = True
        else:
            print(f"Could not pick {name} ({result!r}). The next lobby tick "
                  "will try again.")

    def _rotation_list(self):
        """Optional explicit rotation; empty means the game's own sort decides."""
        raw = load_toml_as_dict("./cfg/bot_config.toml").get("brawler_rotation", "") or ""
        return [part.strip().lower() for part in str(raw).split(",") if part.strip()]

    # How the roster is ordered. Each of these is a sort the game performs
    # itself, so none of them needs forty card reads to find the minimum.
    # Three columns by three rows, measured on a screenshot of the brawler menu.
    # The fourth column is cut off by the screen edge, so it is not usable.
    CARD_GRID_SIZE = 9

    # Сколько раз подряд можно повторять выбор бойца, прежде чем сдаться.
    # Раньше повторов не было вовсе, и на несовместимой сортировке бот висел
    # в меню выбора бесконечно.
    BRAWLER_PICK_ATTEMPTS = 3

    BRAWLER_SORT_MODES = {
        "lowest_trophies": "brawlers_sort_least_trophies",
        "closest_to_rank": "brawlers_sort_closest_to_next_tier",
        "lowest_level": "brawlers_sort_power_level_low_to_high",
        "most_trophies": "brawlers_sort_most_trophies",
        "by_name": "brawlers_sort_name",
    }

    def brawler_sort_mode(self):
        """Which sort to ask the game for, always a known one.

        An unrecognised value falls back to fewest trophies: the default this ran
        on until now, rather than passing a bad name through to the menu.
        """
        raw = load_toml_as_dict("./cfg/bot_config.toml").get("brawler_pick_mode",
                                                            "lowest_trophies")
        mode = str(raw or "").strip().lower()
        return mode if mode in self.BRAWLER_SORT_MODES else "lowest_trophies"

    def brawler_sort_point(self):
        """The menu entry to tap for the current mode."""
        try:
            buttons = load_toml_as_dict("./cfg/buttons_config.toml")
        except Exception:  # noqa: BLE001
            return None
        return buttons.get(self.BRAWLER_SORT_MODES[self.brawler_sort_mode()])

    def _pick_lowest_trophies(self):
        """Whether the game should pick the brawler by one of its own sorts."""
        return self.brawler_sort_mode() in self.BRAWLER_SORT_MODES

    def current_brawler(self):
        """The brawler the bot is really on, as far as the game has told us.

        The queue's first entry used to answer this, but the game picks from the
        whole roster while the queue is a hand-made subset, so the two disagree
        and the queue was reporting a brawler nobody was playing.
        """
        picked = getattr(self.Lobby_automation, "last_picked", None)
        if picked and picked.get("brawler"):
            return picked["brawler"]
        return getattr(self, "_confirmed_brawler", None)

    def _next_brawler_after(self, previous):
        """The brawler that follows `previous` in ascending trophy order.

        This is the game's own rule continued one step. The game's sort names
        the single lowest brawler, and on an account where one brawler sits far
        below the rest that is the same name every time; taking the one after it
        keeps the rule and makes the quota actually move.
        """
        previous = str(previous or "").strip().lower()
        candidates = []
        for entry in self.brawlers_pick_data or []:
            name = str(entry.get("brawler") or "").strip().lower()
            if not name or name == previous:
                continue
            try:
                trophies = int(entry.get("trophies") or 0)
            except (TypeError, ValueError):
                trophies = 0
            candidates.append((trophies, name))
        if not candidates:
            return None
        candidates.sort()
        return candidates[0][1]

    def last_switch(self):
        """What the most recent rotation did, or None if there has not been one.

        Read by the panel so the switch can be shown as fact rather than
        inferred from a brawler name that may simply be stale.
        """
        return dict(getattr(self, "_last_switch", None) or {}) or None

    def _adopt_picked_brawler(self, previous, switch_after):
        """Record what the game actually put us on, and its real trophy count.

        Without this the trophy number the lobby shows is written to whichever
        brawler the queue expected, which quietly moves one brawler's trophies to
        another and makes the rotation pick the same brawler forever.
        """
        picked = getattr(self.Lobby_automation, "last_picked", None) or {}
        name = picked.get("brawler")
        trophies = picked.get("trophies")
        sort_mode = self.brawler_sort_mode()
        if not name:
            # The switch did happen on screen, we just could not read which
            # brawler it was. Saying so beats pretending nothing changed.
            self._last_switch = {
                "from": previous, "to": None, "confirmed": False,
                "games": switch_after, "sort_mode": sort_mode,
            }
            print("Rotation done, but the brawler name could not be read from "
                  "the card; the switch cannot be confirmed.")
            return
        self._confirmed_brawler = name
        changed = bool(previous) and previous != name
        self._last_switch = {
            "from": previous, "to": name, "confirmed": True,
            "changed": changed, "games": switch_after, "sort_mode": sort_mode,
        }
        if changed:
            print(f"Played {switch_after} games on {previous}, the game moved us "
                  f"to {name} (sorted by {sort_mode}).")
        elif switch_after:
            print(f"Played {switch_after} games, still on {name} - the "
                  f"{sort_mode} sort put the same brawler first again.")
        entry = next((e for e in self.brawlers_pick_data
                      if str(e.get("brawler", "")).lower() == name), None)
        if entry is None:
            # The game's lowest brawler is not in our queue at all. Add it, or the
            # panel would keep showing a roster the bot is not playing from.
            entry = {"brawler": name, "type": "trophies", "push_until": 1000,
                     "trophies": trophies or 0, "wins": 0, "win_streak": 0,
                     "automatically_pick": True}
            self.brawlers_pick_data.append(entry)
            print(f"{name} was not in the queue, added it so the panel shows the truth.")
        # The trophy number on the card is read by OCR and sometimes arrives with
        # its leading digits gone: 72 for 720, 12 for 727. Writing that into the
        # queue would make the brawler look like the lowest one on the roster and
        # the game would keep handing us the same pick. A single match moves a
        # brawler by tens, so a read this far from what we last believed is a
        # misread, and the previous value stands.
        trusted = trophies
        if trophies and entry.get("trophies"):
            previous_trophies = int(entry["trophies"] or 0)
            drift = abs(trophies - previous_trophies)
            if drift > max(200, previous_trophies // 3):
                trusted = None
                print(f"Card trophy read {trophies} for {name} is too far from the "
                      f"{previous_trophies} we had; keeping the old value rather "
                      f"than writing a truncated number into the queue.")
        if trusted:
            entry["trophies"] = trusted
            self.Trophy_observer.change_trophies(trusted)
        self.brawlers_pick_data.remove(entry)
        self.brawlers_pick_data.insert(0, entry)
        self.Trophy_observer.current_wins = entry["wins"] if entry["wins"] != "" else 0
        self.Trophy_observer.win_streak = entry.get("win_streak", 0)

    def sync_trophies_from_screen(self):
        """Read the two lobby counters and feed the per-hour rate.

        The account total is the one that can carry a rate: the per-brawler
        number restarts on every switch and contradicts the brawler screen. The
        lobby counter also belongs to the brawler the game has selected, which is
        not necessarily the first entry of our queue.
        """
        try:
            import trophy_reader
        except Exception:  # noqa: BLE001
            return None
        if not trophy_reader.available():
            return None
        frame = self.window_controller.screenshot()
        try:
            # The last known total disambiguates which number in the top strip
            # is ours; without it the reader can settle on a neighbour.
            total = trophy_reader.read_account_total(
                frame, expected=self.Trophy_observer.account_total)
            if total is not None:
                self.Trophy_observer.record_account_total(total)
        except Exception:  # noqa: BLE001
            pass
        real = trophy_reader.read(frame)
        if real is None:
            return real
        name = self.current_brawler()
        if not name:
            return real
        stored = None
        for entry in self.brawlers_pick_data:
            if str(entry.get("brawler", "")).lower() == str(name).lower():
                stored = self._entry_trophies(entry)
                break
        if stored is None:
            entry = {"brawler": name, "type": "trophies", "push_until": 1000,
                     "trophies": real, "wins": 0, "win_streak": 0,
                     "automatically_pick": True}
            self.brawlers_pick_data.insert(0, entry)
            print(f"Playing {name}, which was not in the queue; added it at {real} trophies.")
            return real
        if abs(real - stored) > 5:
            print(f"Trophies read from the lobby: {real} (last known {stored}) "
                  f"for {name}. Display only; nothing decides on it.")
            entry["trophies"] = real
        return real

    def rotate_to_lowest_trophies(self):
        """Move the brawler with the fewest trophies to the front of the queue."""
        queue = self.brawlers_pick_data
        if len(queue) <= 1:
            return None
        order = self._rotation_list()
        if order:
            candidates = [i for i, entry in enumerate(queue)
                          if str(entry.get("brawler", "")).lower() in order]
            if not candidates:
                candidates = list(range(len(queue)))
        else:
            candidates = list(range(len(queue)))
        best = min(candidates, key=lambda i: (self._entry_trophies(queue[i]),
                                               i))
        if best == 0:
            return None
        entry = queue.pop(best)
        queue.insert(0, entry)
        return entry.get("brawler")

    def start_game(self):
        if self._should_stop() or self._should_pause():
            return

        print("state is lobby, starting game")
        locked = self.locked_brawler()
        if locked:
            # One brawler, chosen by the operator. The queue shrinks to it and
            # the menu is used to actually get on it, because the game's own
            # sort would otherwise hand back somebody else.
            self._lock_queue_to(locked)
            self._select_locked_brawler(locked)
        values = {
            "trophies": self.Trophy_observer.current_trophies,
            "wins": self.Trophy_observer.current_wins
        }

        type_of_push = self.brawlers_pick_data[0]['type']
        value = values[type_of_push]
        push_current_brawler_till = self.brawlers_pick_data[0]['push_until']

        # Trophy goals are display-only on purpose. The lobby count is read by
        # OCR and contradicts the brawler screen often enough that letting it
        # steer the bot caused real damage: one misread switched the brawler to
        # whatever our queue guessed, and a single-entry queue made the bot call
        # sys.exit() and stop. The game already sorts by "Least Trophies" and
        # picks the real minimum, so the only fact the bot needs is the name of
        # the brawler that got selected.
        if USE_TROPHY_TARGETS and value >= push_current_brawler_till and not locked:
            # and not locked: with one brawler chosen there is no next one to move
            # on to, and this branch's single-entry case calls sys.exit(), which
            # would stop a bot that is doing exactly what it was asked to do.
            if len(self.brawlers_pick_data) <= 1:
                print("Brawler reached required trophies/wins. No more brawlers selected for pushing in the menu. "
                      "Bot will now pause itself until closed.", value, push_current_brawler_till)
                screenshot = self.window_controller.screenshot()
                notify_user("completed", screenshot, self)
                print("Bot stopping: all targets completed with no more brawlers.")
                self.window_controller.release_movement()
                self.window_controller.close()
                sys.exit(0)
            ping_when_target_is_reached = load_toml_as_dict("cfg/webhook_config.toml")["ping_when_target_is_reached"]
            if ping_when_target_is_reached:
                screenshot = self.window_controller.screenshot()
                notify_user("brawler_goal", screenshot, self)
            print(f'Bot has reached the target trophies/wins for {self.brawlers_pick_data[0]["brawler"]}, moving on to the next one in the list.', value, push_current_brawler_till)
            self.brawlers_pick_data.pop(0)
            next_brawler_name = self.brawlers_pick_data[0]['brawler']
            if self.brawlers_pick_data[0]["automatically_pick"]:
                select_brawler = self.Lobby_automation.select_brawler(next_brawler_name, self.get_latest_state, runtime_control=self.runtime_control)
                # Повторов было безгранично много, а боец ниже кладётся обратно
                # в очередь, поэтому повторялся ровно тот же выбор: на
                # сортировке, не совпадающей с порядком очереди, бот так и висел
                # в меню выбора бойца. Считаем попытки и уходим.
                for _try in range(self.BRAWLER_PICK_ATTEMPTS):
                    if select_brawler not in ("failed", "error", "aborted", "stuck"):
                        break
                    if self.ping_when_stuck:
                        screenshot = self.window_controller.screenshot()
                        notify_user("bot_failed_brawler_selection", screenshot, self)
                    if self._should_stop() or self._should_pause():
                        return
                    print(f"Skipping {select_brawler}, attempt {_try + 1} "
                          f"of {self.BRAWLER_PICK_ATTEMPTS}")
                    if self._sleep_interruptible(2):
                        return
                    # Уводим непокорного бойца в конец очереди, иначе повтор
                    # был бы тем же самым выбором.
                    self.quit_shop()
                    stuck = self.brawlers_pick_data.pop(0)
                    self.brawlers_pick_data.append(stuck)
                    if len(self.brawlers_pick_data) > 1:
                        self.brawlers_pick_data.insert(
                            0, self.brawlers_pick_data.pop(1))
                    next_brawler_name = self.brawlers_pick_data[0]['brawler']
                    select_brawler = self.Lobby_automation.select_brawler(
                        next_brawler_name, self.get_latest_state,
                        runtime_control=self.runtime_control)
                else:
                    print(f"Brawler selection failed after {self.BRAWLER_PICK_ATTEMPTS} "
                          "attempts; continuing without a switch instead of "
                          "retrying forever.")
                if select_brawler == "aborted" or select_brawler == "stuck":
                    return
                if select_brawler == "success":
                    self.Trophy_observer.change_trophies(self.brawlers_pick_data[0]['trophies'])
                    self.Trophy_observer.current_wins = self.brawlers_pick_data[0]['wins'] if self.brawlers_pick_data[0]['wins'] != "" else 0
                    self.Trophy_observer.win_streak = self.brawlers_pick_data[0]['win_streak']
            else:
                self.Trophy_observer.change_trophies(self.brawlers_pick_data[0]['trophies'])
                self.Trophy_observer.current_wins = self.brawlers_pick_data[0]['wins'] if self.brawlers_pick_data[0]['wins'] != "" else 0
                self.Trophy_observer.win_streak = self.brawlers_pick_data[0]['win_streak']
                print("Next brawler is in manual mode, waiting 10 seconds to let user switch.")
                if self._sleep_interruptible(10):
                    return
        else:
            if not self._lobby_synced:
                # The account total can only be read here, on the lobby screen.
                self._lobby_synced = True
                try:
                    self.sync_trophies_from_screen()
                except Exception as error:  # noqa: BLE001
                    print(f"Reading the lobby counters failed: {error}")
            # A normal game: count it towards the rotation and let the game move
            # us on to whoever is lowest once the quota is up.
            switch_after = self._switch_after_games()
            if switch_after and not self._game_counted:
                # start_game is called on every lobby tick, not once per game.
                # Counting ticks turned "7 games" into about twenty seconds and
                # made the rotation fire constantly.
                self._game_counted = True
                self.games_on_current_brawler += 1
                if self.games_on_current_brawler >= switch_after:
                    # The counter is zeroed only once the switch really happened.
                    # Zeroing it here meant a single failed attempt silently cost
                    # another seven games on the same brawler, which is exactly how
                    # "the brawler never changes" looked from the panel.
                    previous = self.current_brawler()
                    # The game sorts over every unlocked brawler, not over our
                    # queue, so it is the only thing that knows who is really
                    # lowest right now. Skipping the visit when our own numbers
                    # said nothing changed is what froze the rotation: the
                    # counter reset, the brawler menu never opened, and the bot
                    # played the same brawler forever while reporting another one.
                    self.rotate_to_lowest_trophies()
                    auto = bool(self.brawlers_pick_data
                                and self.brawlers_pick_data[0].get("automatically_pick"))
                    if auto:
                        select_brawler = self.Lobby_automation.select_brawler_by_sort(
                            self.get_latest_state, runtime_control=self.runtime_control,
                            sort_point=self.brawler_sort_point(),
                            card_index=self._rotation_card)
                        for _attempt in range(3):
                            # None used to slip through this test and end the
                            # retries at once, so a menu that failed to open was
                            # treated as a completed pick.
                            if select_brawler == "success":
                                break
                            if select_brawler in ("aborted", "stuck"):
                                break
                            print(f"Automatic pick returned {select_brawler!r}, retrying.")
                            if self._should_stop() or self._should_pause():
                                return
                            # The pause is not optional: this loop used to spin at
                            # full speed and reshuffle the queue indefinitely.
                            if self._sleep_interruptible(2):
                                return
                            select_brawler = self.Lobby_automation.select_brawler_by_sort(
                                        self.get_latest_state, runtime_control=self.runtime_control,
                                        sort_point=self.brawler_sort_point(),
                                        card_index=self._rotation_card)
                        if select_brawler in ("aborted", "stuck"):
                            return
                        if select_brawler == "success":
                            # Walk the grid until the card names somebody other
                            # than the brawler we are already on. The game's own
                            # sort cannot do this on its own: one brawler sits far
                            # below the rest of the roster, so it stays first for
                            # dozens of matches and the quota never moves anybody.
                            for _step in range(self.CARD_GRID_SIZE):
                                if select_brawler == "success":
                                    name = (
                                        getattr(self.Lobby_automation,
                                                "last_picked", None) or {}
                                    ).get("brawler")
                                    if (not name
                                            or not previous
                                            or str(name).strip().lower()
                                            != str(previous).strip().lower()):
                                        break
                                    self._rotation_card = (
                                        (self._rotation_card + 1) % self.CARD_GRID_SIZE)
                                    print(f"Card at this position is {name}, the "
                                          f"brawler already played; taking the next "
                                          f"one, position {self._rotation_card}.")
                                    if self._should_stop() or self._should_pause():
                                        return
                                    if self._sleep_interruptible(1.2):
                                        return
                                    select_brawler = \
                                        self.Lobby_automation.select_brawler_by_sort(
                                            self.get_latest_state,
                                            runtime_control=self.runtime_control,
                                            sort_point=self.brawler_sort_point(),
                                            card_index=self._rotation_card)
                                else:
                                    break
                            self._rotation_card = (
                                (self._rotation_card + 1) % self.CARD_GRID_SIZE)
                            self._adopt_picked_brawler(previous, switch_after)
                            # Only now is the quota really spent.
                            self.games_on_current_brawler = 0
                        else:
                            # Keep the count at the quota so the next lobby tick
                            # tries again immediately.
                            self.games_on_current_brawler = switch_after
                            print(f"Switch not confirmed ({select_brawler!r}); keeping the "
                                  f"quota spent so it is retried on the next lobby tick.")
                    else:
                        print("Next brawler is in manual mode, waiting 10 seconds to let user switch.")
                        if self._sleep_interruptible(10):
                            return
        save_brawler_data(self.brawlers_pick_data)
        self.matches_since_last_webhook_ping += 1
        if self.ping_every_x_match and self.matches_since_last_webhook_ping >= self.ping_every_x_match:
            screenshot = self.window_controller.screenshot()
            notify_user("regular_matches_ping", screenshot, self)
            self.matches_since_last_webhook_ping = 0

        if self._should_stop() or self._should_pause():
            return
        self.window_controller.release_movement()
        self.window_controller.press("proceed")
        print("Pressed to start a match")
        time.sleep(2)

    def click_star_drop(self, drop_type="regular"):
        if hasattr(self, '_star_drop_thread') and self._star_drop_thread.is_alive():
            return

        def _handle_drop():
            if drop_type in ["angelic", "demonic", "starr_nova"]:
                self.window_controller.press("proceed", 8)
            else:
                for _ in range(8):
                    self.window_controller.press("proceed", 0.05)
                    time.sleep(0.1)

        import threading
        self._star_drop_thread = threading.Thread(target=_handle_drop, daemon=True)
        self._star_drop_thread.start()

    def end_game(self):
        screenshot = self.window_controller.screenshot()

        current_state = get_state(screenshot)
        button_pressed = False
        end_screen_time = time.time()
        parsed_result = None
        while current_state.startswith("end") and time.time() - end_screen_time < 35:

            if time.time() - self.time_since_last_stat_change > 25 and parsed_result is None :
                raw_found_result = '_'.join(current_state.split("_")[1:])
                parsed_result = self.Trophy_observer.parse_game_result(raw_found_result)

                current_brawler = self.brawlers_pick_data[0]['brawler']
                power_level = None
                underdog = is_underdog(screenshot)
                if underdog:
                    print("Underdog detected for this match.")
                self.Trophy_observer.add_trophies(parsed_result, current_brawler, self.playstyle_info, underdog, power_level)
                self.Trophy_observer.add_win(parsed_result)
                self.time_since_last_stat_change = time.time()
                values = {
                    "trophies": self.Trophy_observer.current_trophies,
                    "wins": self.Trophy_observer.current_wins
                }
                type_to_push = self.brawlers_pick_data[0]['type']
                value = values[type_to_push]
                self.brawlers_pick_data[0][type_to_push] = value
                self.brawlers_pick_data[0]['win_streak'] = self.Trophy_observer.win_streak
                save_brawler_data(self.brawlers_pick_data)

            if not button_pressed and self.play_again_on_win and parsed_result and parsed_result.result == MatchResult.VICTORY and not self._should_pause() and not self._should_stop():
                self.window_controller.press("play_again")
                button_pressed = True
            elif not button_pressed:
                print("Game has ended, proceeding")
                self.window_controller.press("proceed")

            time.sleep(3)
            screenshot = self.window_controller.screenshot()
            current_state = get_state(screenshot)

        if self.play_again_on_win and parsed_result and parsed_result.result == MatchResult.VICTORY and not self._should_pause():
            print("Waiting for match to start...")
            start_wait_time = time.time()
            interrupted = False
            while time.time() - start_wait_time < 25:
                if self._should_stop() or self._should_pause():
                    interrupted = True
                    break
                screenshot = self.window_controller.screenshot()
                current_state = get_state(screenshot)
                if current_state == "match":
                    print("Match started successfully!")
                    return
                if self._sleep_interruptible(0.5):
                    interrupted = True
                    break

            if interrupted:
                print("Play-again wait interrupted by stop or pause; skipping game restart.")
                return
            print("Match did not start within 25s, restarting the game.")
            self.window_controller.restart_brawl_stars()
            time.sleep(2)
        elif time.time() - end_screen_time > 35:
            print("End screen timeout reached, restarting the game.")
            self.window_controller.restart_brawl_stars()
        print("Game has ended", current_state)

    def quit_shop(self):
        self.window_controller.click(100 * self.window_controller.width_ratio, 60 * self.window_controller.height_ratio)
        time.sleep(1)

    def close_pop_up(self):
        screenshot = self.window_controller.screenshot()
        if self.close_popup_icon is None:
            self.close_popup_icon = load_image("images/states/close_popup.png", self.window_controller.scale_factor)
        if self.close_popup_icon is None:
            return
        popup_location = find_template_center(screenshot, self.close_popup_icon)
        if popup_location:
            self.window_controller.click(*popup_location)

    def do_state(self, state, data=None):
        action = self.states.get(state)
        if action is None:
            return
        if state != "lobby":
            # Leaving the lobby means a game actually started, so the next lobby
            # visit is allowed to count one more game towards the rotation and to
            # read the lobby counters again.
            self._game_counted = False
            self._lobby_synced = False
        if data is not None:
            action(data)
            return
        action()
