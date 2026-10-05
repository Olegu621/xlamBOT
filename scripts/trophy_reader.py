"""Reads the real per-brawler trophy count off the screen.

The bot's own counter is not read from the game: `trophy_observer` starts from
whatever number is in the queue and keeps adding its own computed deltas. That
number drifts further from reality with every match, and it is what the
"reached the target" check compares against, so a brawler that is 43 trophies
short looks 643 short and the bot plays it forever.

Two figures are read here:

* the selected brawler's own trophy count, in the middle of the lobby, and
* the account's trophy total, in the yellow bar under the crown badge.

The account total is the one that can carry a trophies-per-hour rate, because it
does not restart when the brawler changes.
"""
from __future__ import annotations

import os
import pathlib
import re
import shutil
import sys

import cv2
import numpy as np

try:
    import pytesseract

    # Сначала ищем переносимую копию, которая едет вместе с программой: у
    # установленного пользователя своего Tesseract может не быть, и раньше
    # читать трофеи было просто нечем. Папка vendor лежит рядом с проектом,
    # а в собранной программе - в _internal.
    TESSERACT_PATH = ""

    def _tesseract_candidates():
        roots = []
        if getattr(sys, "frozen", False):
            roots.append(getattr(sys, "_MEIPASS", ""))
        roots.append(str(pathlib.Path(__file__).resolve().parent))

        for root in roots:
            if not root:
                continue
            yield os.path.join(root, "vendor", "tesseract", "tesseract.exe")

        # Системные установки - последним выбором, чтобы рабочая копия
        # пользователя не перебивала ту, что мы положили рядом.
        for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                yield os.path.join(base, "Tesseract-OCR", "tesseract.exe")
        yield shutil.which("tesseract") or ""

    for candidate in _tesseract_candidates():
        if not candidate or not os.path.isfile(candidate):
            continue
        try:
            pytesseract.pytesseract.tesseract_cmd = candidate
            # Проверяем не только по existence файла: папка может найтись, а
            # запуститься exe не сможет - не хватит DLL.
            pytesseract.get_tesseract_version()
            TESSERACT_PATH = candidate
            break
        except Exception:  # noqa: BLE001
            continue

    OCR_AVAILABLE = bool(TESSERACT_PATH)
except Exception:  # noqa: BLE001
    OCR_AVAILABLE = False
    TESSERACT_PATH = ""

# The per-brawler trophy count, in the 1920x1080 base the rest of the project
# uses. It sits in the centre of the lobby next to the prestige badge, not in
# the corner: the top-left counter is the account total, and reading that one
# reports a completely different number for the same brawler.
# Measured on the emulator at 1280x720, where the digits span x 620-690,
# y 100-135.
DEFAULT_REGION = (900, 150, 150, 53)
# Neighbouring crops tried in order. The first that yields clean digits wins,
# which absorbs small layout shifts and interpolation differences.
CANDIDATE_REGIONS = (
    DEFAULT_REGION,
    (930, 150, 105, 53),
    (922, 147, 120, 60),
    (900, 143, 150, 67),
)
OCR_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789"

# On the brawler screen every card prints its own name and trophy count, so the
# card the game considers the lowest can simply be read instead of guessed.
# Measured on the emulator at 1280x720 and expressed in the usual 1920x1080 base.
FIRST_CARD_NAME_REGION = (540, 350, 170, 38)
FIRST_CARD_TROPHY_REGION = (380, 388, 85, 34)
# Tesseract reads a space or a dash in the whitelist as a separate argument and
# refuses to start, so the whitelist is letters and digits only; the match
# below strips punctuation from both sides anyway.
NAME_OCR_CONFIG = "--psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

# A whitelisted pass fails outright on some card backgrounds, so this
# second pass lets the OCR engine pick its own characters.
NAME_OCR_LOOSE_CONFIG = "--psm 7"

# The account's trophy total: the number in the yellow bar under the crown badge,
# with the prestige tier next to it. This is the one figure that survives a
# brawler switch, so the per-hour rate is built on it.
#
# Do not confuse it with the counter further right, next to the lightning icon:
# that one reads lower and is a different quantity entirely.
# Measured off a live 1280x720 lobby frame: the gold digits of the account total
# sit at x≈436-532, y≈38-72 in 1920x1080 reference terms. The old crop started at
# 413 and therefore straddled the trophy icon, which is why it read 7568 - the
# neighbouring "trophies to next prestige" number - and why it now reads nothing
# at all. Keep the neighbours as fallbacks: the bar carries several numbers and
# which one is under the edge changes as the layout shifts.
ACCOUNT_TOTAL_REGION = (436, 38, 96, 34)
ACCOUNT_TOTAL_REGIONS = (
    ACCOUNT_TOTAL_REGION,
    (430, 34, 110, 40),
    (438, 41, 85, 30),
    (413, 36, 122, 40),
    (455, 34, 90, 42),
)


def available() -> bool:
    return OCR_AVAILABLE


def _digits(text: str):
    match = re.search(r"\d{1,7}", str(text).replace(" ", ""))
    if not match:
        return None
    value = int(match.group())
    return value if value > 0 else None


def read(frame, region=DEFAULT_REGION) -> int | None:
    """Return the trophy count shown in the lobby, or None if unreadable.

    Otsu and adaptive thresholding both damaged this number (dropping the leading
    digit or inventing one), so plain grey at 3x turned out to be the reliable
    recipe. Anything that does not come back as clean digits is discarded rather
    than trusted, because a wrong trophy count silently corrupts the queue.
    """
    if not OCR_AVAILABLE or frame is None or frame.size == 0:
        return None
    for candidate in CANDIDATE_REGIONS:
        value = _read_one(frame, candidate)
        if value is not None:
            return value
    return None


def _read_one(frame, region):
    crop = _crop(frame, region)
    if crop is None:
        return None
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    upscaled = cv2.resize(grey, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    try:
        text = pytesseract.image_to_string(upscaled, config=OCR_CONFIG)
    except Exception as error:  # noqa: BLE001
        print(f"Trophy OCR failed: {error}")
        return None
    return _digits(text)


def read_account_total(frame, expected=None):
    """The account's total trophies as shown in the lobby, or None.

    Only meaningful on the lobby screen. The first region is the calibrated one
    and is trusted on its own; the others are only a second opinion. A second
    opinion that parses AND disagrees means the read is wrong, so it is dropped.
    (The observer applies a further check against the last value it saw.)
    """
    if not OCR_AVAILABLE or frame is None or frame.size == 0:
        return None
    candidates = []
    for region in ACCOUNT_TOTAL_REGIONS:
        value = _read_region_digits(frame, region)
        if value is not None and 1000 <= value <= 999999:
            candidates.append(value)
    if not candidates:
        return None
    if expected is not None:
        # Closest to what we already believe. A trophy total creeps by tens, so
        # the real one is always nearest and a neighbour's digits never win.
        scored = candidates + _completions(candidates, expected)
        # Only a value that could actually be this account next visit counts. If
        # nothing lands in that band the read is unusable - a digit was misread
        # and no amount of prefixing recovers it - so say so rather than hand the
        # caller a plausible-looking guess.
        allowed = max(ACCOUNT_TOTAL_MAX_DRIFT, int(expected * ACCOUNT_TOTAL_MAX_RELATIVE))
        plausible = [v for v in scored if abs(v - expected) <= allowed]
        if plausible:
            return min(plausible, key=lambda v: abs(v - expected))
        # Nothing lands nearby, so either the total really has moved a long way
        # (the bot was off for a while) or the read is a different number
        # entirely. Those are told apart by shape rather than by amount: a real
        # total keeps its digit count and its leading digit. 37568 is the same
        # account a week later; 7568 and 317550 are not this account at all.
        #
        # Only the digits actually read are eligible here. Completions are not:
        # padding a neighbour's 7568 up to 37568 gives it this account's shape
        # and its leading digit, which is precisely the mistake this is meant to
        # catch. A partial read is already handled by the band above.
        same_shape = [v for v in candidates
                      if len(str(v)) == len(str(expected)) and str(v)[0] == str(expected)[0]]
        if same_shape:
            return min(same_shape, key=lambda v: abs(v - expected))
        return None
    # With no history to lean on, only a value seen in more than one crop is
    # worth reporting; a single crop is how 317550 got believed.
    for value in candidates:
        if candidates.count(value) >= 2:
            return value
    return None


# How far the total may move between two lobby visits. Deliberately tighter than
# the observer's outer guard: this band also has to separate two numbers that
# differ only in digits OCR could not see, and 10% of 31k is 3187 - wide enough to
# accept 32861 when the truth is 31861.
ACCOUNT_TOTAL_MAX_DRIFT = 400
ACCOUNT_TOTAL_MAX_RELATIVE = 0.02


def _completions(values, expected):
    """Fill in the leading digits a covering animation hid from the crop.

    The lobby plays a trophy-hand animation over the counter, and OCR then reads
    whatever digits the hand is not sitting on: "1870" for a total of 31870. A
    total only moves by tens between matches, so prefixing 1-3 digits and
    keeping every completion lands on exactly one number close to the last known
    one - the rest are ten thousand away and get dropped.
    """
    out = []
    for value in values:
        # The span comes from the digits actually read. A 4-digit read of a
        # 5-digit total needs a 1-digit prefix (3 * 10^4 + 1870 = 31870); sizing
        # it off the expected value instead would build nothing plausible.
        span = 10 ** len(str(int(value)))
        for missing in (1, 2, 3):
            for prefix in range(1, 10 ** missing):
                candidate = prefix * span + value
                if 1000 <= candidate <= 999999:
                    out.append(candidate)
    # Prefixing 1, 2 or 3 digits yields the same number more than once.
    return list(dict.fromkeys(out))


# The grid the rotation walks, matching brawlers_card_NN in buttons_config.
# Three visible columns by three rows; the fourth column is off the screen.
CARD_GRID_COLUMNS = 3
CARD_GRID_ROWS = 3
CARD_COLUMN_STEP = 475
CARD_ROW_STEP = 293


def card_offset(card_index):
    """How far a card sits from the first one, in grid steps."""
    try:
        index = max(0, int(card_index or 0))
    except (TypeError, ValueError):
        index = 0
    if index >= CARD_GRID_COLUMNS * CARD_GRID_ROWS:
        index = 0
    column = index % CARD_GRID_COLUMNS
    row = index // CARD_GRID_COLUMNS
    return column * CARD_COLUMN_STEP, row * CARD_ROW_STEP


def shifted(region, card_index):
    """Move a region from the first card onto the card at `card_index`."""
    dx, dy = card_offset(card_index)
    x, y, width, height = region
    return (x + dx, y + dy, width, height)


def read_card(frame, card_index=0):
    """Read the brawler name and trophies off one card of the grid.

    Returns ``{"brawler": name, "trophies": count}`` with either value set to
    None when it could not be read. The name is matched against the brawlers the
    project actually knows about, because raw OCR of a card returns things like
    "SIRIUS |" and a name that is not in the list is not worth reporting.

    card_index must match the card that was tapped. Reading always from the
    first card made every position look like the same brawler, and the rotation
    walked the grid forever without ever accepting a switch.
    """
    result = {"brawler": None, "trophies": None}
    if not OCR_AVAILABLE or frame is None or frame.size == 0:
        return result
    result["brawler"] = _read_card_name(frame, card_index)
    result["trophies"] = _read_region_digits(
        frame, shifted(FIRST_CARD_TROPHY_REGION, card_index))
    return result


def read_first_card(frame, card_index=0):
    """Kept for callers that only ever want the first card."""
    return read_card(frame, card_index)


# The measured region first, then wider and tighter variants of it. One narrow
# crop with one OCR pass missed often enough that the panel kept naming the
# previous brawler after a switch that had in fact happened.
CARD_NAME_REGIONS = (
    FIRST_CARD_NAME_REGION,
    (536, 344, 180, 44),
    (532, 338, 188, 50),
    (544, 352, 162, 36),
)

# Character-level distance, sized to swallow OCR noise without letting a
# different brawler win: "BROCK" vs "BRDCK" is 2.
NAME_MAX_DISTANCE = 2


def _levenshtein(left, right):
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for i, lchar in enumerate(left, 1):
        current = [i]
        for j, rchar in enumerate(right, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (lchar != rchar),
            ))
        previous = current
    return previous[-1]


def _match_brawler_name(squashed, known):
    """Find the brawler whose name this OCR text is meant to be."""
    if not squashed:
        return None
    normalised = sorted(
        ((re.sub(r"[^A-Z0-9]", "", name.upper()), name) for name in known),
        key=lambda pair: -len(pair[0]),
    )
    # Longest name first so "EL PRIMO" wins over a shorter name it contains.
    for candidate, name in normalised:
        if candidate and (squashed.startswith(candidate) or candidate in squashed):
            return name
    # Nothing matched outright, so allow a near miss, but only when the lengths
    # are close enough that this reads as a misread rather than another name.
    best = None
    for candidate, name in normalised:
        if abs(len(candidate) - len(squashed)) > NAME_MAX_DISTANCE:
            continue
        distance = _levenshtein(candidate, squashed)
        if distance <= NAME_MAX_DISTANCE and (best is None or distance < best[0]):
            best = (distance, name)
    return best[1] if best else None


def _read_card_name(frame, card_index=0):
    known = _known_brawler_names()
    if not known:
        return None
    dx, dy = card_offset(card_index)
    seen = []
    for index, region in enumerate(CARD_NAME_REGIONS):
        moved = (region[0] + dx, region[1] + dy, region[2], region[3])
        for config in (NAME_OCR_CONFIG, NAME_OCR_LOOSE_CONFIG):
            text = _read_region_text(frame, moved, config)
            if not text:
                continue
            squashed = re.sub(r"[^A-Z0-9]", "", text.upper())
            seen.append(squashed)
            name = _match_brawler_name(squashed, known)
            if name:
                if index or config != NAME_OCR_CONFIG:
                    print(f"Card name read from region {index} as {name} "
                          f"(OCR saw {squashed!r}).")
                return name
    if seen:
        print(f"No brawler matched the card text {seen!r}.")
    return None


def _known_brawler_names():
    try:
        from utils import load_brawlers_info

        return list(load_brawlers_info().keys())
    except Exception:  # noqa: BLE001
        return []


def _crop(frame, region):
    height, width = frame.shape[:2]
    x, y, w, h = region
    ratio_x, ratio_y = width / 1920, height / 1080
    x1, y1 = max(0, int(x * ratio_x)), max(0, int(y * ratio_y))
    x2, y2 = min(width, int((x + w) * ratio_x)), min(height, int((y + h) * ratio_y))
    if x2 - x1 < 8 or y2 - y1 < 8:
        return None
    return frame[y1:y2, x1:x2]


def _read_region_text(frame, region, config, scale=4):
    crop = _crop(frame, region)
    if crop is None:
        return ""
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    upscaled = cv2.resize(grey, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    try:
        return pytesseract.image_to_string(upscaled, config=config).strip()
    except Exception as error:  # noqa: BLE001
        print(f"Card OCR failed: {error}")
        return ""


def _read_region_digits(frame, region):
    return _digits(_read_region_text(frame, region, OCR_CONFIG))
