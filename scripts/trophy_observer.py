import csv
import os
import secrets
import time
import requests
from utils import load_toml_as_dict, save_dict_as_toml, api_base_url, hash_playstyle, XLAMBOT_VERSION, resolve_project_path
from enum import Enum
from dataclasses import dataclass
from typing import Optional
from datetime import datetime

# Window used for the "trophies per hour" readout, and the shortest span we are
# willing to divide by.
#
# The floor is deliberately long. A burst of +84 trophies in 8 minutes extrapolates
# to "647/hour", which is arithmetically fine and completely meaningless as an
# average pace — short windows turn every hot streak into a fake record. Under
# 20 minutes of observation there is no rate to report, only elapsed time.
TROPHY_RATE_WINDOW_S = 3600
TROPHY_RATE_MIN_SPAN_S = 20 * 60
TROPHY_RATE_MAX_WINDOW_S = 6 * 3600
# How far the account total may plausibly move between two lobby visits.
# Kept in step with trophy_reader's band on purpose. When the two disagreed the
# reader could reject a number the observer would have accepted, so the looser
# guard silently decided. 10% of 31k is 3187, which is wide enough to swallow a
# misread digit and report it as a 1000-trophy swing.
ACCOUNT_TOTAL_MAX_DRIFT = 400
ACCOUNT_TOTAL_MAX_RELATIVE = 0.02
# Absolute band for a plausible trophy total. Two matching reads are not enough on
# their own: a systematic misread (a stray digit from the neighbouring counter)
# repeats, and it then becomes the baseline that rejects the real number. This
# ceiling is several times larger than the account has ever been, and exists only
# to reject decimal-place errors.
ACCOUNT_TOTAL_MIN = 1000
ACCOUNT_TOTAL_MAX = 200000


class GameMode(Enum):
    CLASSIC = "classic"
    TRIO_SHOWDOWN = "trio_showdown"


class MatchResult(Enum):
    VICTORY = "victory"
    DRAW = "draw"
    DEFEAT = "defeat"


@dataclass
class ParsedGameResult:
    gamemode: GameMode
    result: MatchResult
    place: Optional[int] = None
    raw_string: str = ""


class TrophyObserver:

    HISTORY_COLUMNS = [
        "date_time", "brawler_name", "result", "current_trophies", "trophy_delta",
        "new_winstreak", "playstyle_hash", "playstyle_name", "playstyle_gamemodes",
        "playstyle_brawlers", "xlambot_version", "power_level",
    ]
    INTEGER_HISTORY_COLUMNS = {
        "current_trophies", "trophy_delta", "new_winstreak", "power_level",
    }

    @staticmethod
    def _replace_when_available(source, destination):
        """Replace destination once Windows releases any external file lock."""
        retry_delay = 0.1
        waiting = False

        while True:
            try:
                os.replace(source, destination)
                if waiting:
                    print(f"File lock released; saved {destination.name}.")
                return
            except PermissionError as error:
                if not waiting:
                    print(
                        f"Waiting for {destination.name} to become writable "
                        f"({error})..."
                    )
                    waiting = True
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 2.0)

    def __init__(self):
        self.history_file = resolve_project_path("cfg", "match_history.csv")
        
        self.current_trophies = None
        self.current_wins = None
        self.match_history = self.load_history()
        self.last_sent_index = len(self.match_history)
        self.win_streak = 0
        self.match_counter = 0
        # Rolling trophy timeline, used for the "trophies per hour" readout. Kept
        # in memory only: it is a live gauge, and a restart should not make the
        # panel claim a rate measured over hours that are no longer in view.
        self.trophy_samples = []
        # The account total, read from the lobby. The per-brawler number gets
        # reset by every switch and contradicts the brawler screen, so it cannot
        # carry a rate; this one can.
        self.account_total = None
        self.account_samples = []
        # A total seen exactly once is not trusted yet; see record_account_total.
        self._pending_account = None
        self.trophy_lose_ranges = [(49, 0), (299, 1), (599, 2), (799, 3), (999, 4), (1099, 5), (1199, 6), (1299, 7),
                                   (1499, 8), (1799, 9), (3999, 10), (float("inf"), 15)]
        self.trophy_win_ranges = [(1999, 10), (2499, 8), (2799, 6), (2999, 4), (3099, 2), (float("inf"), 1)]
        self.showdown_trio_ranges = [
            (49, (11, 5, 5, 5)),
            (99, (11, 5, 4, -1)),
            (199, (11, 5, 3, -1)),
            (299, (11, 5, 2, -1)),
            (499, (11, 5, 2, -2)),
            (599, (11, 5, 1, -2)),
            (799, (11, 5, 1, -3)),
            (999, (11, 5, 1, -4)),
            (1099, (11, 5, 0, -6)),
            (1199, (11, 5, 0, -7)),
            (1299, (11, 5, 0, -8)),
            (1499, (11, 5, 0, -9)),
            (1799, (11, 5, -5, -10)),
            (1999, (11, 5, -5, -11)),
            (2199, (9, 4, -5, -11)),
            (float("inf"), (9, 4, -5, -11)),
        ]
        self.trophies_multiplier = int(load_toml_as_dict("./cfg/general_config.toml")["trophies_multiplier"])

    def win_streak_gain(self):
        return min(self.win_streak - 1, 10) if self.current_trophies < 2000 else 0

    def record_trophy_sample(self):
        """Append the current trophy count to the rolling timeline."""
        if self.current_trophies is None:
            return
        now = time.time()
        # Ignore repeats of the same value: the lobby OCR re-reads the number
        # every visit, and a flat stretch must not drag the measured window.
        if self.trophy_samples and self.trophy_samples[-1][1] == self.current_trophies:
            return
        self.trophy_samples.append((now, int(self.current_trophies)))
        self.trophy_samples = [s for s in self.trophy_samples
                               if s[0] >= now - TROPHY_RATE_MAX_WINDOW_S]

    def _rate_window(self, window_s: int, samples=None):
        """The exact sample pair the rate is derived from, or None."""
        if samples is None:
            samples = self.trophy_samples
            if not samples:
                self.record_trophy_sample()
                samples = self.trophy_samples
        if len(samples) < 2:
            return None
        cutoff = time.time() - window_s
        # Sort defensively: a negative span would silently produce a rate with
        # the wrong sign, which is worse than reporting nothing.
        window = sorted((s for s in samples if s[0] >= cutoff), key=lambda s: s[0])
        if len(window) < 2:
            window = sorted(samples[-2:], key=lambda s: s[0])
        span = window[-1][0] - window[0][0]
        if span <= 0 or span < TROPHY_RATE_MIN_SPAN_S:
            return None
        return window[0], window[-1]

    def trophy_rate_per_hour(self, window_s: int = TROPHY_RATE_WINDOW_S):
        """Trophies per hour over the recent window, or None if unknowable yet."""
        pair = self._rate_window(window_s)
        if pair is None:
            return None
        (t0, v0), (t1, v1) = pair
        return round((v1 - v0) / ((t1 - t0) / 3600.0), 1)

    def record_account_total(self, value):
        """Note the account's trophy total as shown in the lobby.

        Rejected unless it is plausible next to the last one we believed. OCR
        happily reads 252796 off a bar that says 29224, and a single such jump
        would show up as thousands of trophies per hour. A real match moves the
        total by tens, so anything beyond that band is a misread, not progress.
        """
        if value is None:
            return
        try:
            value = int(value)
        except (TypeError, ValueError):
            return
        if not ACCOUNT_TOTAL_MIN <= value <= ACCOUNT_TOTAL_MAX:
            print(f"Ignoring account total {value}: outside the plausible band "
                  f"{ACCOUNT_TOTAL_MIN}-{ACCOUNT_TOTAL_MAX}.")
            self._pending_account = None
            return
        previous = self.account_total
        if previous is not None:
            drift = abs(value - previous)
            allowed = max(ACCOUNT_TOTAL_MAX_DRIFT, int(previous * ACCOUNT_TOTAL_MAX_RELATIVE))
            if drift > allowed:
                # The bot may genuinely have been off for a long while, and then
                # the total really has moved by thousands. A real total keeps its
                # digit count and leading digit; a misread usually does not. This
                # jump is accepted only after two matching reads, because being
                # wrong here re-bases the rate for the rest of the run.
                same_shape = (len(str(value)) == len(str(previous))
                              and str(value)[0] == str(previous)[0])
                if same_shape and self._pending_account == value:
                    self.account_total = value
                    self._pending_account = None
                    self._commit_account_sample(value)
                    print(f"Account total re-based to {value}: a real jump, confirmed "
                          f"twice (was {previous}).")
                    return
                if same_shape:
                    self._pending_account = value
                    print(f"Account total {value} read as a jump from {previous}; "
                          "waiting for a second matching read before re-basing.")
                    return
                print(f"Ignoring an implausible account total {value}: it differs from "
                      f"{previous} by {drift}, more than a match can move it ({allowed}), "
                      "and the shape says it is not this account.")
                return
        else:
            # No baseline yet, which is exactly the restart case where a bad read
            # is accepted unchecked and 317550 turns up instead of 31606. A real
            # number survives to the next lobby visit; a misread does not, so a
            # value has to appear twice before it is believed.
            if self._pending_account == value:
                self.account_total = value
                self._pending_account = None
                self._commit_account_sample(value)
                return
            if self._pending_account is not None:
                print(f"Account total read {self._pending_account} then {value}; "
                      "neither was seen twice, so no total is trusted yet.")
            self._pending_account = value
            print(f"Account total {value} seen once, waiting for a second matching read.")
            return
        self._commit_account_sample(value)

    def _commit_account_sample(self, value):
        """Record a value the rate is allowed to be built from."""
        self.account_total = value
        self._pending_account = None
        now = time.time()
        if self.account_samples and self.account_samples[-1][1] == value:
            self.save_account_state()
            return
        self.account_samples.append((now, value))
        self.account_samples = [s for s in self.account_samples
                                if s[0] >= now - TROPHY_RATE_MAX_WINDOW_S]
        self.save_account_state()

    def load_account_state(self):
        """Adopt the last account total from a previous run.

        Without this every restart starts blind: no baseline for the drift guard,
        no anchor for the reader, and a rate that has to refill its whole
        history before it can say anything. The value is only a hint — it still
        has to survive the same plausibility checks before it is believed.
        """
        try:
            import json
            from utils import account_state_path
            path = account_state_path()
            if not path.is_file():
                return None
            data = json.loads(path.read_text(encoding="utf-8"))
            value = int(data["account_total"])
            samples = data.get("samples") or []
        except Exception:  # noqa: BLE001
            return None
        if not ACCOUNT_TOTAL_MIN <= value <= ACCOUNT_TOTAL_MAX:
            return None
        # The rate is a list of (when, value) pairs, and those timestamps stay
        # true across a restart - only the memory of them was lost. Without this
        # every restart threw the measurement away and the panel sat on
        # "collecting" for another twenty minutes before it could say anything.
        now = time.time()
        restored = []
        for pair in samples:
            try:
                stamp, sample = float(pair[0]), int(pair[1])
            except (TypeError, ValueError, IndexError):
                continue
            if ACCOUNT_TOTAL_MIN <= sample <= ACCOUNT_TOTAL_MAX and stamp <= now:
                restored.append((stamp, sample))
        restored.sort()
        self.account_samples = restored
        self.account_total = value
        print(f"Resumed account total {value} from {path.name} with "
              f"{len(restored)} readings over "
              f"{(round((restored[-1][0] - restored[0][0]) / 60.0, 1) if len(restored) > 1 else 0)} min; "
              "it will be re-checked against the lobby before it is believed.")
        return value

    def save_account_state(self):
        if self.account_total is None:
            return
        try:
            import json
            from utils import account_state_path
            path = account_state_path()
            path.write_text(json.dumps(
                {"account_total": self.account_total,
                 "saved_at": time.time(),
                 "samples": [[round(stamp, 1), sample]
                             for stamp, sample in self.account_samples]},
                indent=2), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass

    def account_rate_detail(self, window_s: int = TROPHY_RATE_WINDOW_S):
        """Trophies per hour for the whole account, over the recent window."""
        pair = self._rate_window(window_s, self.account_samples)
        samples = sorted(self.account_samples)
        span_minutes = 0.0
        if len(samples) >= 2:
            span_minutes = round((samples[-1][0] - samples[0][0]) / 60.0, 1)
        detail = {
            "rate_per_hour": None,
            "window_minutes": window_s // 60,
            "samples": len(self.account_samples),
            "account_total": self.account_total,
            "measured_minutes": span_minutes,
            "gained": 0,
            # Why the rate is missing, in numbers. Lobby reads only happen when
            # the bot actually reaches the lobby, and on this server that can be
            # rare, so "no rate" needs to be explainable rather than mysterious.
            "min_span_minutes": TROPHY_RATE_MIN_SPAN_S // 60,
        }
        if pair is None:
            return detail
        (t0, v0), (t1, v1) = pair
        detail["rate_per_hour"] = round((v1 - v0) / ((t1 - t0) / 3600.0), 1)
        detail["measured_minutes"] = round((t1 - t0) / 60.0, 1)
        detail["gained"] = v1 - v0
        return detail

    def trophy_rate_detail(self, window_s: int = TROPHY_RATE_WINDOW_S):
        rate = self.trophy_rate_per_hour(window_s)
        samples = sorted(self.trophy_samples, key=lambda s: s[0])
        oldest, newest = (samples[0], samples[-1]) if len(samples) >= 2 else (None, None)
        return {
            "rate_per_hour": rate,
            "window_minutes": window_s // 60,
            "samples": len(samples),
            "trophies": self.current_trophies,
            "measured_minutes": round((newest[0] - oldest[0]) / 60.0, 1) if oldest else 0.0,
            "gained": (newest[1] - oldest[1]) if oldest else 0,
        }

    def calc_lost_decrement(self, underdog):
        for max_trophies, loss in self.trophy_lose_ranges:
            if float(self.current_trophies) <= float(max_trophies):
                return loss - (3 if underdog else 0)
        raise ValueError("Current trophies exceed all defined ranges")

    def calc_win_increment(self, underdog):
        for max_trophies, gain in self.trophy_win_ranges:
            if float(self.current_trophies) <= float(max_trophies):
                return gain * self.trophies_multiplier + self.win_streak_gain() + (5 if underdog else 0)
        raise ValueError("Current trophies exceed all defined ranges")

    def calc_draw_increment(self, underdog):
        return 4 if (underdog and self.current_trophies < 2000) else 0

    def calc_showdown_delta(self, place):
        for max_trophies, deltas in self.showdown_trio_ranges:
            if float(self.current_trophies) <= float(max_trophies):
                return deltas[place] * self.trophies_multiplier + (self.win_streak_gain() if place < 2 else 0)
        raise ValueError("Current trophies exceed all defined ranges")

    def load_history(self):
        if os.path.exists(self.history_file) and os.path.getsize(self.history_file) > 0:
            try:
                with open(self.history_file, "r", encoding="utf-8-sig", newline="") as handle:
                    reader = csv.DictReader(handle, strict=True)
                    if not reader.fieldnames:
                        raise ValueError("No columns to parse")

                    missing_columns = [
                        column for column in self.HISTORY_COLUMNS
                        if column not in reader.fieldnames
                    ]
                    if missing_columns:
                        raise ValueError(
                            f"Missing required columns: {', '.join(missing_columns)}"
                        )

                    history = []
                    for row in reader:
                        if None in row:
                            raise ValueError("A row contains more values than the CSV header")
                        history.append(self._normalize_history_row(row))

                return history
            except Exception as e:
                timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                backup = self.history_file.with_name(
                    f"{self.history_file.stem}.corrupt-{timestamp}-{secrets.token_hex(3)}{self.history_file.suffix}"
                )
                os.replace(self.history_file, backup)
                print(f"Error reading match history CSV ({e}). Preserved the corrupt file as {backup.name}.")

        history = []
        try:
            self._atomic_save_history(history)
        except Exception as e:
            print(f"Error creating match history CSV: {e}")
        return history

    def save_history(self):
        self._atomic_save_history(self.match_history)

    def _atomic_save_history(self, history):
        self.history_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.history_file.with_name(
            f".{self.history_file.name}.{secrets.token_hex(8)}.tmp"
        )
        try:
            with open(temporary, "w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=self.HISTORY_COLUMNS,
                    lineterminator="\n",
                )
                writer.writeheader()
                writer.writerows(history)
                handle.flush()
                os.fsync(handle.fileno())
            self._replace_when_available(temporary, self.history_file)
        finally:
            if temporary.exists():
                temporary.unlink()

    @classmethod
    def _normalize_history_row(cls, row):
        normalized = {
            column: row.get(column, "")
            for column in cls.HISTORY_COLUMNS
        }
        for column in cls.INTEGER_HISTORY_COLUMNS:
            value = normalized[column]
            if value in (None, ""):
                continue
            try:
                normalized[column] = int(value)
            except (TypeError, ValueError):
                try:
                    normalized[column] = int(float(value))
                except (TypeError, ValueError):
                    pass
        return normalized


    def parse_game_result(self, raw_result: str) -> ParsedGameResult:
        """Parses raw game result string into a structured data class."""
        print(f"Found game result: {raw_result}")
        if "showdown" in raw_result:
            place = int(raw_result.split("_")[-1])
            gamemode = GameMode.TRIO_SHOWDOWN if "trio_showdown" in raw_result else GameMode.CLASSIC

            if place < 2:
                result = MatchResult.VICTORY
            elif place == 2:
                if self.current_trophies is not None:
                    try:
                        delta = self.calc_showdown_delta(place)
                        if delta < 0:
                            result = MatchResult.DEFEAT
                        else:
                            result = MatchResult.DRAW
                    except Exception as e:
                        print(f"Error calculating showdown delta for place {place}: {e}")
                        result = MatchResult.DRAW
                else:
                    result = MatchResult.DRAW
            else:
                result = MatchResult.DEFEAT

            return ParsedGameResult(gamemode=gamemode, result=result, place=place, raw_string=raw_result)
        else:
            result_map = {
                "victory": MatchResult.VICTORY,
                "draw": MatchResult.DRAW,
                "defeat": MatchResult.DEFEAT
            }
            return ParsedGameResult(
                gamemode=GameMode.CLASSIC,
                result=result_map.get(raw_result, MatchResult.DEFEAT),
                place=None,
                raw_string=raw_result
            )

    def add_trophies(self, parsed_result: ParsedGameResult, current_brawler, playstyle_info, underdog, power_level=None):
        if self.current_trophies is None:
            self.current_trophies = 0
        old_trophies = self.current_trophies
        if old_trophies >= 2000:
            underdog = False
        old_win_streak = self.win_streak

        if parsed_result.result == MatchResult.VICTORY:
            self.win_streak += 1
            if parsed_result.place is not None:
                trophy_delta = self.calc_showdown_delta(parsed_result.place)
            else:
                trophy_delta = self.calc_win_increment(underdog)
        elif parsed_result.result == MatchResult.DEFEAT:
            if not underdog:
                self.win_streak = 0
            if parsed_result.place is not None:
                trophy_delta = self.calc_showdown_delta(parsed_result.place)
            else:
                trophy_delta = -self.calc_lost_decrement(underdog)
        elif parsed_result.result == MatchResult.DRAW:
            if parsed_result.place is not None:
                trophy_delta = self.calc_showdown_delta(parsed_result.place)
            else:
                print("Nothing changed. Draw detected")
                trophy_delta = self.calc_draw_increment(underdog)
        else:
            print("Catastrophic failure")
            trophy_delta = 0
        if self.current_trophies >= 1000 and self.current_trophies + trophy_delta < 1000:
            self.current_trophies = 1000
        elif self.current_trophies >= 2000 and self.current_trophies + trophy_delta < 2000:
            self.current_trophies = 2000
        else:
            self.current_trophies += trophy_delta

        print(f"Trophies: {old_trophies} -> {self.current_trophies}")
        print(f"Win Streak: {old_win_streak} -> {self.win_streak}")
        self.record_trophy_sample()
        if self.current_wins:
            print(f"Current Wins: {self.current_wins}")

        info = playstyle_info if isinstance(playstyle_info, dict) else {}
        self.match_history.append({
            "date_time": datetime.now().isoformat(),
            "brawler_name": current_brawler,
            "result": parsed_result.result.value,
            "current_trophies": old_trophies,
            "trophy_delta": trophy_delta,
            "new_winstreak": self.win_streak,
            "playstyle_hash": hash_playstyle(info),
            "playstyle_name": info.get("name", ""),
            "playstyle_gamemodes": "|".join(info.get("gamemodes") or []),
            "playstyle_brawlers": "|".join(info.get("brawlers") or []),
            "xlambot_version": XLAMBOT_VERSION,
            "power_level": power_level if power_level is not None else -1,
        })
        self.match_counter += 1
        if self.match_counter % 3 == 0:
            self.send_results_to_api()
        self.save_history()

    def add_win(self, parsed_result: ParsedGameResult):
        if parsed_result.result == MatchResult.VICTORY:
            if not isinstance(self.current_wins, int):
                self.current_wins = 0
            self.current_wins += 1

    def change_trophies(self, new):
        print(f"Trophies changed from {self.current_trophies} to {new}")
        self.current_trophies = new
        self.record_trophy_sample()

    def send_results_to_api(self):
        new_matches = self.match_history[self.last_sent_index:]
        if not new_matches:
            return
        payload = [match.copy() for match in new_matches]
        if api_base_url != "localhost":
            try:
                response = requests.post(
                    f'https://{api_base_url}/api/matches',
                    json=payload,
                    timeout=(3.05, 10),
                )
                if response.status_code == 200:
                    print("Match history successfully sent to API")
                    self.last_sent_index = len(self.match_history)
                else:
                    print("Failed to send match history to API.")
            except requests.exceptions.RequestException as e:
                print(f"Error sending match history to API: {e}")
