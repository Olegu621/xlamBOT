"""Validate the published update without importing or executing bundled bytecode."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Public verification key used by the original xlamBOT bootstrap (not a secret).
PUBLIC_KEY = "9a7d7864c03c38ece7f571ca9808aa41a37b0f1d468e3b2c74e1dbe1b4b36b32"
REPOSITORY = "Olegu621/xlamBOT"
MAX_SIZE = 64 * 1024 * 1024
PYTHON_MAGIC = {"3.13": bytes.fromhex("f30d0d0a")}
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


class ValidationError(ValueError):
    """The distribution cannot safely be accepted by the updater."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_manifest(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)


def canonical(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def safe_path(name: str) -> None:
    require(isinstance(name, str) and bool(name), "Empty or non-string archive path")
    path = PurePosixPath(name)
    require(
        "\\" not in name and ":" not in name and not path.is_absolute()
        and ".." not in path.parts and str(path) == name,
        f"Unsafe archive path: {name}",
    )
    require(path.suffix in {".pyc", ".js", ".css", ".html"}, f"Unsupported update file: {name}")
    require(path.parts[0] not in {"cfg", "devices", "models", "training", "playstyles", "vendor", "scrcpy", "runtime"},
            f"Update overwrites user data or runtime: {name}")


def validate_manifest(envelope: dict) -> dict:
    require(isinstance(envelope, dict), "Manifest envelope must be an object")
    manifest = envelope.get("manifest")
    require(isinstance(manifest, dict), "Missing manifest object")
    signature = envelope.get("signature")
    require(isinstance(signature, str) and re.fullmatch(r"[0-9a-f]{128}", signature) is not None,
            "Invalid Ed25519 signature encoding")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUBLIC_KEY)).verify(
            bytes.fromhex(signature), canonical(manifest)
        )
    except InvalidSignature as error:
        raise ValidationError("Ed25519 signature verification failed") from error
    require(manifest.get("repository") == REPOSITORY, "Unexpected update repository")
    require(type(manifest.get("bootstrap")) is int and manifest["bootstrap"] == 1, "Unsupported bootstrap")
    require(type(manifest.get("revision")) is int and manifest["revision"] > 0, "Invalid revision")
    require(manifest.get("python") in PYTHON_MAGIC, "Unsupported Python bytecode version")
    require(type(manifest.get("size")) is int and 0 < manifest["size"] <= MAX_SIZE, "Invalid archive size")
    require(isinstance(manifest.get("sha256"), str) and DIGEST.fullmatch(manifest["sha256"]) is not None,
            "Invalid archive SHA-256")
    files = manifest.get("files")
    require(isinstance(files, dict) and bool(files), "Empty file inventory")
    for name, digest in files.items():
        safe_path(name)
        require(isinstance(digest, str) and DIGEST.fullmatch(digest) is not None, f"Invalid SHA-256: {name}")
    return manifest


def validate_archive(archive: bytes, manifest: dict) -> dict[str, bytes]:
    require(len(archive) == manifest["size"], "Archive size mismatch")
    require(hashlib.sha256(archive).hexdigest() == manifest["sha256"], "Archive SHA-256 mismatch")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(names)), "Duplicate ZIP paths")
        require(set(names) == set(manifest["files"]), "ZIP file inventory differs from manifest")
        require(sum(entry.file_size for entry in entries) <= MAX_SIZE, "Unpacked update exceeds size limit")
        contents = {}
        for entry in entries:
            name = entry.filename
            safe_path(name)
            require(not entry.is_dir(), f"Unexpected directory: {name}")
            require(not stat.S_ISLNK(entry.external_attr >> 16), f"Symlink in update: {name}")
            data = bundle.read(entry)
            require(hashlib.sha256(data).hexdigest() == manifest["files"][name], f"File SHA-256 mismatch: {name}")
            if name.endswith(".pyc"):
                require(len(data) >= 16 and data[:4] == PYTHON_MAGIC[manifest["python"]],
                        f"Wrong or truncated Python bytecode header: {name}")
            else:
                data.decode("utf-8")
            contents[name] = data
        return contents


def check_javascript(root: Path, contents: dict[str, bytes]) -> int:
    node = shutil.which("node")
    require(node is not None, "Node.js is required for JavaScript syntax checks")
    scripts = sorted((root / "static").rglob("*.js"))
    require(bool(scripts), "No standalone JavaScript resources found")
    checked = 0
    with tempfile.TemporaryDirectory(prefix="xlambot-ci-") as temporary:
        packed = []
        for name, data in contents.items():
            if name.endswith(".js"):
                # validate_archive has already checked every path before any writes.
                target = Path(temporary) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                packed.append(target)
        for script in scripts + packed:
            result = subprocess.run([node, "--check", str(script)], capture_output=True, text=True, timeout=30)
            require(result.returncode == 0, f"JavaScript syntax error in {script}:\n{result.stderr}")
            checked += 1
    return checked


def validate_distribution(root: Path) -> tuple[int, int, int]:
    manifest = validate_manifest(read_manifest(root / "manifest.json"))
    require((root / "scripts.zip").stat().st_size <= MAX_SIZE, "Archive exceeds size limit")
    contents = validate_archive((root / "scripts.zip").read_bytes(), manifest)
    checked = check_javascript(root, contents)
    return manifest["revision"], len(contents), checked


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        revision, files, scripts = validate_distribution(args.root.resolve())
    except (ValidationError, OSError, ValueError, zipfile.BadZipFile, subprocess.TimeoutExpired) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: revision {revision}; verified signature and {files} files; checked {scripts} JavaScript files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
