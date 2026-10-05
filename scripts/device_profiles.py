"""Per-device configuration profiles.

Several bots can run at once, and each needs its own trophy goals, button
coordinates and playstyle without stepping on the others. A device gets a
directory under ``devices/<key>/cfg`` which mirrors the repository's own ``cfg``.
The profile root is registered with ``utils`` so that ``load_toml_as_dict("cfg/...")
`` prefers the device's own files and falls back to the repository, meaning a
profile only has to carry the files it actually overrides.

``utils`` owns the switching (get_config_root / config_scope) so that there is a
single source of truth; this module only knows where a device's files live.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import utils

# Serial numbers contain characters that are awkward in a path ("127.0.0.1:5555",
# "emulator-5554"). Keep the name readable but predictable.
_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]")


def sanitize_key(serial: str) -> str:
    """Turn a device serial into a directory-safe profile key."""
    return _UNSAFE.sub("-", str(serial or "").strip()).strip("-") or "default"


def profile_dir(key: str) -> Path:
    return utils.resolve_project_path("devices", sanitize_key(key))


def config_root_for(key: str) -> Path:
    """The device's own config root, created on demand."""
    root = profile_dir(key) / "cfg"
    root.mkdir(parents=True, exist_ok=True)
    return root


def ensure_profile(key: str) -> Path:
    """Make sure the device has a profile directory; return its path.

    A profile is seeded with the shipped cfg whenever its cfg folder holds no
    toml yet - not only when the folder itself is new. An interrupted first run
    leaves the folder behind and empty, and checking only for the folder's
    existence left such a profile permanently without settings. The seeding is
    per-file and never overwrites, so it only ever fills gaps.
    """
    base = profile_dir(key)
    (base / "cfg").mkdir(parents=True, exist_ok=True)
    if not any((base / "cfg").glob("*.toml")):
        try:
            copy_repository_defaults(key)
        except Exception:  # noqa: BLE001
            # Отсутствие значений по умолчанию не повод отказывать в профиле:
            # панель покажет пустое, но устройство будет работать.
            pass
    return base


def use_profile(key: str):
    """Context manager routing config reads to one device's profile."""
    ensure_profile(key)
    return utils.config_scope(config_root_for(key))


def load_queue(key: str) -> list[dict[str, Any]]:
    """The brawler queue stored for this device."""
    with use_profile(key):
        try:
            return utils.load_brawler_data()
        except Exception:  # noqa: BLE001
            return []


def save_queue(key: str, queue: list[dict[str, Any]]) -> None:
    with use_profile(key):
        utils.save_brawler_data(queue)


def copy_repository_defaults(key: str) -> None:
    """Seed a profile with the repository's cfg so it is self-contained."""
    source = utils.resolve_project_path("cfg")
    target = config_root_for(key)
    for item in source.glob("*.toml"):
        destination = target / item.name
        if not destination.exists():
            shutil.copy2(item, destination)


def read_settings(key: str) -> dict[str, Any]:
    """The whole config tree for a device, as nested plain dicts.

    Reads from the active config root, which under a profile is the device's
    own folder. resolve_project_path("cfg") would always answer with the
    repository's copy, so the panel displayed the shared values while saving
    to the device, and a reload appeared to undo the save.
    """
    with use_profile(key):
        settings: dict[str, Any] = {}
        for path in utils.get_config_root().glob("*.toml"):
            try:
                settings[path.stem] = utils.load_toml_as_dict(path)
            except Exception:  # noqa: BLE001
                continue
        return settings


def update_settings(key: str, section: str, updates: dict[str, Any]) -> dict[str, Any]:
    """Merge values into one section of one toml file and write it back."""
    ensure_profile(key)
    match = re.fullmatch(r'(?:cfg[/\\])?([A-Za-z0-9_-]+?)(?:\.toml)?', str(section or '').strip(), re.I)
    if not match:
        raise ValueError('Invalid settings section')
    filename = match.group(1).lower() + '.toml'
    allowed = {p.name.lower() for p in utils.resolve_project_path('cfg').glob('*.toml')}
    allowed.update(p.name.lower() for p in config_root_for(key).glob('*.toml'))
    if filename not in allowed:
        raise ValueError('Unknown settings section: ' + filename)
    section = 'cfg/' + filename
    with use_profile(key):
        current = utils.load_toml_as_dict(section) if section else {}
        merged = dict(current or {})
        for name, value in (updates or {}).items():
            if isinstance(value, dict) and isinstance(merged.get(name), dict):
                merged[name] = {**merged[name], **value}
            else:
                merged[name] = value
        utils.save_dict_as_toml(merged, section)
        utils.invalidate_toml_cache(section)
        return merged


def read_profile_meta(key: str) -> dict[str, Any]:
    """Free-form notes about a device, stored beside its config."""
    path = profile_dir(key) / "profile.json"
    try:
        data = json.loads(utils.read_text_auto(path))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def list_profiles() -> list[dict[str, Any]]:
    """Every device profile on disk, for the panel's profile picker."""
    root = utils.resolve_project_path("devices")
    profiles: list[dict[str, Any]] = []
    if not root.is_dir():
        return profiles
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        profiles.append({
            "key": entry.name,
            "has_config": (entry / "cfg").is_dir(),
            "meta": read_profile_meta(entry.name),
        })
    return profiles
