"""Runs the bot for a target number of matches and works out why the player dies.

    python match_audit.py --serial emulator-5554 --target 100

The panel snapshot is sampled once a second into a short ring buffer. When a
match ends, the frames from the seconds before the end are replayed through the
gas and entity models to answer the only question that matters: was the player
standing in gas, was an enemy on top of them, or something else.

Each finished match appends one record to ``match_audit.jsonl`` and one evidence
frame per death to ``audit_frames/``, so a conclusion can always be checked
against the picture it was drawn from.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, deque
from pathlib import Path

import cv2
import numpy as np

from detect import Detect
from utils import load_toml_as_dict

# A match ends with this line; the trophy line follows it.
RESULT_RE = re.compile(r"Found game result:\s*(\S+)")
TROPHY_RE = re.compile(r"Trophies:\s*(-?\d+)\s*->\s*(-?\d+)")
# The result string ends in a 0-based placement index (see
# state_finder.showdown_place_templates), so "trio_showdown_0" is 1st place.
PLACE_BY_INDEX = {0: 1, 1: 2, 2: 3, 3: 4}
# A "match" shorter than this is a matchmaking blip, not a game. Counting those
# put 2-second phantom matches into the statistics.
MIN_MATCH_SECONDS = 20
STATE_LOG_RE = re.compile(r"State:\s*(\S+)")
TROPHY_LINE_RE = re.compile(r"Trophies:\s*(-?\d+)\s*->\s*(-?\d+)")
# The bot logs the state change before it logs the trophy move, so finalising the
# instant the match ends lost the delta on most matches. Wait a few seconds and
# pick up the trailing lines.
MATCH_END_GRACE_S = 5.0
# Frames at the very end of a match are the spectator view after death.
EVIDENCE_SKIP_LAST_FRAMES = 4
# The widest trophy swing a single brawl match can produce. Used only on the
# fallback that derives a delta from the per-brawler counter, because that
# counter restarts whenever the rotation changes brawlers.
MAX_PLAUSIBLE_DELTA = 120
# How long to wait for the lobby to refresh the account total before giving up
# on this match's delta.
ACCOUNT_TOTAL_WAIT_S = 25

GAS_MODEL = "models/gasDetector.onnx"
ENTITY_MODEL = "models/mainInGameModel.onnx"
# Share of the player's own box that counts as "standing in gas".
GAS_DEATH_SHARE = 0.15
# How close an enemy has to come, as a share of the frame width. A fixed pixel
# count would mean something different on every resolution: the panel hands the
# audit 640x360 frames, where 150px is nearly a quarter of the screen.
ENEMY_CLOSE_SHARE = 0.23
# A side with at least this much gas counts as blocked, i.e. the arena had closed.
TRAPPED_SHARE = 0.25


def alive_frame_check(total: int, position: int) -> bool:
    """Whether this frame is far enough from the end to prove anything."""
    return (total - 1 - position) >= EVIDENCE_SKIP_LAST_FRAMES


def place_from_result(raw_result: str):
    """Placement as a human number, or None when the result carries no place."""
    tail = str(raw_result or "").rsplit("_", 1)[-1]
    return PLACE_BY_INDEX.get(int(tail)) if tail.isdigit() else None


class Panel:
    """Talks to the running panel, and refreshes its token when it changes."""

    def __init__(self, base: str, serial: str):
        self.base = base.rstrip("/")
        self.serial = serial
        self.token = self._read_token()

    def _read_token(self) -> str:
        page = urllib.request.urlopen(f"{self.base}/panel", timeout=20).read().decode()
        marker = 'name="xlam-ui-token" content="'
        start = page.find(marker) + len(marker)
        return page[start:page.find('"', start)]

    def _get(self, path: str, timeout: int = 60) -> bytes:
        try:
            return self._get_once(path, timeout)
        except urllib.error.HTTPError as error:
            if error.code != 403:
                raise
            # The panel mints a new UI token on every start, so a cached one
            # goes stale the moment the panel is restarted. Refresh once and
            # retry; without this the audit keeps getting 403 and records
            # nothing while looking perfectly healthy from the outside.
            try:
                self.token = self._read_token()
            except Exception:  # noqa: BLE001
                raise error
            return self._get_once(path, timeout)

    def _get_once(self, path: str, timeout: int = 60) -> bytes:
        request = urllib.request.Request(f"{self.base}{path}")
        request.add_header("X-Xlam-UI-Token", self.token)
        return urllib.request.urlopen(request, timeout=timeout).read()

    def snapshot(self) -> bytes | None:
        try:
            return self._get(f"/api/devices/{self.serial}/snapshot", timeout=40)
        except Exception:  # noqa: BLE001
            return None

    def logs(self) -> list[str]:
        try:
            return json.loads(self._get(f"/api/devices/{self.serial}/logs?limit=400").decode())["logs"]
        except Exception:  # noqa: BLE001
            return []

    def telemetry(self) -> dict:
        try:
            return json.loads(self._get(f"/api/devices/{self.serial}/telemetry").decode())["telemetry"]
        except Exception:  # noqa: BLE001
            return {}


class Auditor:
    """Decides what killed the player from the frames just before a match ended."""

    def __init__(self, evidence_dir: Path):
        self.evidence = evidence_dir
        self.evidence.mkdir(parents=True, exist_ok=True)
        # Detect takes the model path in its constructor and loads it there;
        # classes narrow the output to what the verdict actually asks about.
        # Three classes, as the model is trained: filtering it down to two made
        # the detector drop one id on every single frame.
        self.entities = Detect(ENTITY_MODEL, classes=["enemy", "teammate", "player"])
        self.gas = Detect(GAS_MODEL, classes=["gas", "bush"])

    def _decode(self, data: bytes):
        if not data:
            return None
        try:
            array = np.frombuffer(data, np.uint8)
            return cv2.imdecode(array, cv2.IMREAD_COLOR)
        except Exception:  # noqa: BLE001
            return None

    def _gas_mask(self, image):
        height, width = image.shape[:2]
        # Trim the top of the frame: tree crowns there were being read as gas.
        cut = int(height * float(load_toml_as_dict("cfg/debug_settings.toml").get("gas_area_top", 0.21)))
        found = self.gas.detect_objects(image[:max(1, height - cut)], conf_tresh=0.4)
        mask = np.zeros((height, width), np.uint8)
        for box in found.get("gas") or []:
            x1, y1, x2, y2 = (int(v) for v in box[:4])
            mask[max(0, y1):y2, max(0, x1):x2] = 255
        return mask

    def _clearest_side(self, mask, player_box) -> float:
        """Gas share on the least covered side, which is where escape lies."""
        height, width = mask.shape[:2]
        x1, y1, x2, y2 = player_box
        best = None
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1),
                       (-1, -1), (1, -1), (-1, 1), (1, 1)):
            cx = min(max((x1 + x2) // 2 + dx * 90, 0), width - 1)
            cy = min(max((y1 + y2) // 2 + dy * 90, 0), height - 1)
            window = mask[max(0, cy - 40):cy + 40, max(0, cx - 40):cx + 40]
            share = float((window > 0).mean()) if window.size else 1.0
            best = share if best is None else min(best, share)
        return best if best is not None else 1.0

    def analyse(self, frames, limit: int | None = None) -> dict:
        """Walk backwards from the end of the match and characterise the death."""
        peak_gas = 0.0
        peak_clearest = 1.0
        closest_enemy = None
        frame_width = 0
        player_frames = 0
        seen_player = False
        worst_frame = None
        worst_image = None
        enemy_frame = None
        enemy_image = None
        last_seen_frame = None
        last_seen_stamp = None

        # The tail runs past the moment of death into the spectator view, where
        # the player is already gone and the frame proves nothing. Skip the very
        # last few frames when looking for evidence.
        # Walk backwards from the end, but stop after the configured number of
        # frames. total stays the length of what we actually walk, because
        # alive_frame_check compares a position against it.
        walk = list(frames)[-limit:] if limit and len(frames) > limit else list(frames)
        total = len(walk)
        for position, (stamp, data) in enumerate(reversed(walk)):
            image = self._decode(data)
            if image is None:
                continue
            found = self.entities.detect_objects(image, conf_tresh=0.4)
            players = found.get("player") or []
            if not players:
                continue
            seen_player = True
            player_frames += 1
            # The gas-peak frame only exists when the bot stood in gas. Without a
            # fallback, an "unknown" verdict came with no picture at all, which
            # makes the unexplained matches impossible to look at.
            if alive_frame_check(total, position):
                last_seen_stamp, last_seen_frame = stamp, image
            if not frame_width:
                frame_width = image.shape[1]
            x1, y1, x2, y2 = (int(v) for v in players[0][:4])
            if x2 <= x1 or y2 <= y1:
                continue
            alive_frame = alive_frame_check(total, position)

            mask = self._gas_mask(image)
            # The box can reach past the frame, and an empty slice makes mean()
            # return nan, which silently poisons the gas figure.
            mh, mw = mask.shape[:2]
            bx1, by1 = max(0, min(x1, mw)), max(0, min(y1, mh))
            bx2, by2 = max(0, min(x2, mw)), max(0, min(y2, mh))
            window = mask[by1:by2, bx1:bx2] if bx2 > bx1 and by2 > by1 else None
            share = float((window > 0).mean()) if (window is not None and window.size and mask.any()) else 0.0
            if share > peak_gas:
                peak_gas = share
                peak_clearest = self._clearest_side(mask, (x1, y1, x2, y2))
                if alive_frame or worst_image is None:
                    worst_frame = stamp
                    worst_image = image

            # Closest an enemy came across the whole tail, not just the last
            # frame: the killer is often out of shot by the time the player dies,
            # and reading one frame turned those deaths into "unknown".
            px, py = (x1 + x2) / 2, (y1 + y2) / 2
            for enemy in found.get("enemy") or []:
                ex1, ey1, ex2, ey2 = (int(v) for v in enemy[:4])
                distance = float(np.hypot((ex1 + ex2) / 2 - px, (ey1 + ey2) / 2 - py))
                if closest_enemy is None or distance < closest_enemy:
                    closest_enemy = distance
                    # Keep the frame where the enemy was nearest. Without it an
                    # "enemy" verdict is a claim nobody can check, and the only
                    # frames ever saved were gas ones.
                    if alive_frame:
                        enemy_frame = stamp
                        enemy_image = image

        enemy_share = None
        if closest_enemy is not None and frame_width:
            enemy_share = closest_enemy / frame_width
        enemy_threshold_px = ENEMY_CLOSE_SHARE * frame_width if frame_width else None

        if not seen_player:
            cause = "player_not_found"
        elif peak_gas >= GAS_DEATH_SHARE:
            # Gas on the player, but was there anywhere to run? If the clearest
            # side was also covered, the arena had closed and no movement logic
            # could have saved the run.
            cause = "gas_trapped" if peak_clearest >= TRAPPED_SHARE else "gas_avoidable"
        elif enemy_share is not None and enemy_share <= ENEMY_CLOSE_SHARE:
            cause = "enemy"
        else:
            cause = "unknown"

        # Keep a frame even when the verdict is "unknown". Without it the
        # unexplained matches cannot be looked at at all. The frame has to match
        # the verdict: gas deaths show the gas frame, enemy deaths show the frame
        # where the enemy was closest.
        evidence_path = None
        if cause == "enemy" and enemy_image is not None:
            chosen, chosen_stamp = enemy_image, enemy_frame
        elif worst_image is not None:
            chosen, chosen_stamp = worst_image, worst_frame
        elif last_seen_frame is not None:
            chosen, chosen_stamp = last_seen_frame, last_seen_stamp
        else:
            chosen = chosen_stamp = None
        if chosen is not None:
            name = f"death_{cause}_{int(chosen_stamp or time.time())}.jpg"
            # Writing the picture must never take the collector down with it:
            # a missing or read-only folder would otherwise abort the whole run
            # and quietly end the statistics.
            try:
                self.evidence.mkdir(parents=True, exist_ok=True)
                cv2.imencode(".jpg", chosen)[1].tofile(str(self.evidence / name))
                evidence_path = name
            except Exception as error:  # noqa: BLE001
                print(f"Could not save the evidence frame: {error}")

        return {
            "cause": cause,
            "peak_gas_share": round(peak_gas, 4),
            "clearest_side_share": peak_clearest,
            "closest_enemy_px": round(closest_enemy, 1) if closest_enemy is not None else None,
            "closest_enemy_share": round(enemy_share, 4) if enemy_share is not None else None,
            "enemy_threshold_px": round(enemy_threshold_px, 1) if enemy_threshold_px else None,
            "player_frames": player_frames,
            "player_seen": seen_player,
            "frames_examined": len(frames),
            "evidence": evidence_path,
        }


def _pid_alive(pid_text: str) -> bool:
    try:
        pid = int(pid_text)
    except (TypeError, ValueError):
        return True
    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def acquire_lock(serial: str) -> Path:
    """One auditor per serial.

    Two auditors on the same device both watch the log ring, both fire on the
    same result line, and both append to the same jsonl — the counts stop
    meaning anything. Refuse to start instead of quietly corrupting the data.
    """
    lock_path = Path(f"match_audit.{re.sub(r'[^A-Za-z0-9_.-]', '_', serial)}.lock")
    try:
        handle = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        owner = ""
        try:
            owner = lock_path.read_text(encoding="utf-8").strip()
        except OSError:
            pass
        if owner and not _pid_alive(owner):
            # Stale lock from a crashed run — reclaim it.
            lock_path.unlink(missing_ok=True)
            return acquire_lock(serial)
        print(
            f"Аудит для {serial} уже запущен (pid {owner or 'неизвестен'}).\n"
            "Второй экземпляр нельзя: два аудита пишут в один файл и портят статистику.\n"
            "Остановить прежний:  Stop-Process -Id " + (owner or "0"),
            file=sys.stderr,
        )
        raise SystemExit(2)
    os.write(handle, str(os.getpid()).encode())
    os.close(handle)
    return lock_path


def _fresh_logs(panel, cursor):
    """Log lines the audit has not seen yet.

    A positional cursor cannot work against this window. The panel always
    returns the newest N lines, so once N is reached len(logs) equals the cursor
    and every later call returns nothing at all - the audit silently stopped
    seeing the bot's log a couple of matches in, which is why "Trophies: X -> Y"
    never arrived and every delta fell back to a stale counter. So the position
    is found by content instead: look for the last line we already consumed and
    take whatever follows it.
    """
    try:
        logs = panel.logs()
    except Exception:  # noqa: BLE001
        return []
    if not logs:
        return []
    last_seen = cursor[0]
    if isinstance(last_seen, str):
        # Walk back a little: identical lines repeat ("State: match"), and the
        # copy we saw may have scrolled off while an identical one is still in
        # the window. Matching the last occurrence keeps us from re-emitting
        # duplicates.
        for index in range(len(logs) - 1, -1, -1):
            if logs[index] == last_seen:
                # The anchor moves to the newest line we just handed over, not to
                # the line we matched. Leaving it on the matched line pins it in
                # place and the next call re-emits the same tail.
                cursor[0] = logs[-1]
                return logs[index + 1:]
        cursor[0] = logs[-1]
        return []
    # First call: everything currently in the window is unread.
    cursor[0] = logs[-1]
    return logs[last_seen:] if isinstance(last_seen, int) and last_seen < len(logs) else []


def main() -> int:
    parser = argparse.ArgumentParser(description="Run matches and diagnose deaths.")
    parser.add_argument("--panel", default="http://127.0.0.1:5195")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--target", type=int, default=100)
    parser.add_argument("--out", default="match_audit.jsonl")
    parser.add_argument("--interval", type=float, default=1.0)
    # A full match, not just its tail. Trio Showdown keeps you spectating after
    # you die, and a 50-frame tail is 50 seconds - so a death in the first round
    # was already gone by the time the match ended and came back as
    # "player_not_found". The state machine decides the boundaries, so a bigger
    # ring does not make matches split or merge.
    parser.add_argument("--buffer", type=int, default=300)
    # The detector does not need the whole match: the death is near the end. This
    # caps how far back the walk goes so the extra frames cost nothing per match.
    parser.add_argument("--analyse-frames", type=int, default=140)
    args = parser.parse_args()

    lock_path = acquire_lock(args.serial)
    try:
        return run(args, lock_path)
    finally:
        lock_path.unlink(missing_ok=True)


def run(args, lock_path: Path) -> int:
    panel = Panel(args.panel, args.serial)
    auditor = Auditor(Path("audit_frames"))
    out_path = Path(args.out)

    done = 0
    causes: Counter = Counter()
    if out_path.is_file():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            done += 1
            try:
                causes[json.loads(line).get("cause")] += 1
            except Exception:  # noqa: BLE001
                pass
    print(f"Уже разобрано матчей в {out_path}: {done} (цель {args.target})", flush=True)

    # A match is a run of states, not a log line. The bot log is a bounded ring
    # buffer: keying off "Found game result" counted the same match twice every
    # time the buffer wrapped, and produced matches that lasted 0.1s or eight
    # minutes. The state machine says exactly when a match starts and ends.
    in_match_states = {"match_making", "match"}
    place_re = re.compile(r"^end_.*_(\d+)$")

    frames: deque = deque(maxlen=args.buffer)
    match_logs: list[str] = []
    log_cursor = [0]  # holds the last line consumed; see _fresh_logs
    in_match = False
    match_started = None
    brawler = None
    trophies_before = None
    account_before = None
    last_state = None
    place_index = None
    pending_end_at = None

    while done < args.target:
        telemetry = panel.telemetry()
        state = telemetry.get("detected_state")

        if in_match:
            data = panel.snapshot()
            if data:
                frames.append((time.time(), data))
            if brawler is None and telemetry.get("brawler"):
                brawler = telemetry.get("brawler")
            if trophies_before is None and telemetry.get("trophies") is not None:
                trophies_before = telemetry.get("trophies")
            # The account total is the only counter that survives a brawler
            # switch, so it is what a missing trophy line is measured against.
            if account_before is None and telemetry.get("account_total") is not None:
                account_before = telemetry.get("account_total")
            match_logs.extend(_fresh_logs(panel, log_cursor))

        matched = place_re.match(state or "")
        if matched:
            place_index = int(matched.group(1))

        if in_match and state not in in_match_states:
            if pending_end_at is None:
                # First poll after the match ended: start draining, do not judge yet.
                pending_end_at = time.time()
                match_logs.extend(_fresh_logs(panel, log_cursor))
                time.sleep(args.interval)
                continue
            if time.time() - pending_end_at < MATCH_END_GRACE_S:
                match_logs.extend(_fresh_logs(panel, log_cursor))
                time.sleep(args.interval)
                continue
            # Match over: the frames we kept are the only ones from inside it.
            elapsed = round(time.time() - match_started, 1) if match_started else None
            if elapsed is not None and elapsed < MIN_MATCH_SECONDS:
                # Too short to be a real game; drop it instead of counting a
                # matchmaking blip as a match.
                frames.clear()
                match_logs.clear()
                in_match = False
                pending_end_at = None
                match_started = None
                brawler = None
                trophies_before = None
                account_before = None
                place_index = None
                time.sleep(args.interval)
                continue
            verdict = auditor.analyse(list(frames), limit=args.analyse_frames)
            # The end screen shows for well under a second, so polling often
            # misses it. The bot's own state line is the reliable source.
            for line in match_logs:
                found = STATE_LOG_RE.search(line)
                if found and place_re.match(found.group(1)):
                    place_index = int(place_re.match(found.group(1)).group(1))
            delta = None
            trophies_after = None
            for line in match_logs:
                found = TROPHY_LINE_RE.search(line)
                if found:
                    delta = int(found.group(2)) - int(found.group(1))
                    trophies_after = int(found.group(2))
            # Fallback source. It used to be the per-brawler counter, and that
            # was simply wrong: that counter is only refreshed when the bot
            # returns to the lobby, so reading it moments after the match gave
            # the identical number and produced delta = 0. All 65 zero deltas in
            # the file were invented that way - not one was a real draw. On a
            # brawler switch it was worse and produced -267, which on its own
            # turned +4.5/match into -0.9/match for a whole experiment.
            #
            # The account total is read from the lobby and moves for real, so it
            # is the fallback. If it has not refreshed yet the honest answer is
            # no delta at all - a missing number is recoverable, a fabricated
            # one quietly becomes the average.
            account_after = None
            if delta is None and account_before is not None:
                deadline = time.time() + ACCOUNT_TOTAL_WAIT_S
                while time.time() < deadline:
                    latest = panel.telemetry().get("account_total")
                    if latest is not None and latest != account_before:
                        account_after = latest
                        break
                    time.sleep(args.interval)
                if account_after is not None:
                    candidate = account_after - account_before
                    if -MAX_PLAUSIBLE_DELTA <= candidate <= MAX_PLAUSIBLE_DELTA:
                        delta = candidate
                    else:
                        print(f"[{done + 1}] счёт аккаунта сдвинулся на {candidate} "
                              f"за один матч - это не матч, дельта не засчитывается.")
            place = PLACE_BY_INDEX.get(place_index) if place_index is not None else None
            record = {
                "index": done + 1,
                "mode": f"trio_showdown_{place_index}" if place_index is not None else None,
                "place": place,
                "place_index": place_index,
                "brawler": brawler,
                "trophies_before": trophies_before,
                "trophies_after": trophies_after,
                "account_before": account_before,
                "account_after": account_after,
                "delta_source": ("bot_log" if trophies_after is not None
                                 else ("account_total" if delta is not None else None)),
                "delta": delta,
                "duration_s": elapsed,
                "finished_at": time.time(),
                **verdict,
            }
            with out_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            done += 1
            causes[verdict["cause"]] += 1
            print(
                f"[{done}/{args.target}] место={place} {record['brawler']} "
                f"delta={delta} причина={verdict['cause']} "
                f"газ={verdict['peak_gas_share']} "
                f"чистая_сторона={verdict['clearest_side_share']} "
                f"враг={verdict['closest_enemy_share']} "
                f"кадров={verdict['frames_examined']} "
                f"длит={elapsed}с | всего: {dict(causes)}",
                flush=True,
            )
            frames.clear()
            match_logs.clear()
            in_match = False
            pending_end_at = None
            match_started = None
            brawler = None
            trophies_before = None
            place_index = None
        elif not in_match and state in in_match_states:
            in_match = True
            pending_end_at = None
            match_started = time.time()
            frames.clear()
            match_logs.clear()
            brawler = None
            trophies_before = None
            place_index = None

        if state != last_state:
            last_state = state
        time.sleep(args.interval)

    print(f"\nГотово: {done} матчей. Причины смерти: {dict(causes)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
