"""Regression tests for tampered, incompatible and unsafe update packages."""

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tools import validate_distribution as validation


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.generate()
        self.public_key = patch.object(validation, "PUBLIC_KEY", self.key.public_key().public_bytes_raw().hex())
        self.public_key.start()
        self.addCleanup(self.public_key.stop)

    def package(self, files=None, *, entries=None):
        files = files if files is not None else {
            "main.pyc": validation.PYTHON_MAGIC["3.13"] + bytes(12) + b"fixture",
            "static/js/panel.js": b"const ready = true;",
        }
        buffer = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(buffer, "w") as bundle:
                for name, data in entries if entries is not None else files.items():
                    bundle.writestr(name, data)
        archive = buffer.getvalue()
        manifest = {
            "repository": validation.REPOSITORY, "bootstrap": 1, "revision": 1,
            "python": "3.13", "size": len(archive), "sha256": hashlib.sha256(archive).hexdigest(),
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        }
        return archive, self.sign(manifest)

    def sign(self, manifest):
        return {"manifest": manifest, "signature": self.key.sign(validation.canonical(manifest)).hex()}

    def test_accepts_valid_signed_update(self):
        archive, envelope = self.package()
        contents = validation.validate_archive(archive, validation.validate_manifest(envelope))
        self.assertIn("main.pyc", contents)

    def test_detects_manifest_tampering(self):
        _, envelope = self.package()
        envelope["manifest"]["revision"] = 2
        with self.assertRaisesRegex(validation.ValidationError, "signature verification"):
            validation.validate_manifest(envelope)

    def test_rejects_different_signing_key(self):
        _, envelope = self.package()
        envelope["signature"] = Ed25519PrivateKey.generate().sign(validation.canonical(envelope["manifest"])).hex()
        with self.assertRaisesRegex(validation.ValidationError, "signature verification"):
            validation.validate_manifest(envelope)

    def test_rejects_wrong_repository(self):
        _, envelope = self.package()
        envelope["manifest"]["repository"] = "bsdedus/xlamBOT"
        with self.assertRaisesRegex(validation.ValidationError, "repository"):
            validation.validate_manifest(self.sign(envelope["manifest"]))

    def test_rejects_unsupported_python(self):
        _, envelope = self.package()
        envelope["manifest"]["python"] = "3.14"
        with self.assertRaisesRegex(validation.ValidationError, "Python"):
            validation.validate_manifest(self.sign(envelope["manifest"]))

    def test_rejects_invalid_revision(self):
        for revision in (True, 0, -1, "23"):
            with self.subTest(revision=revision):
                _, envelope = self.package()
                envelope["manifest"]["revision"] = revision
                with self.assertRaisesRegex(validation.ValidationError, "revision"):
                    validation.validate_manifest(self.sign(envelope["manifest"]))

    def test_rejects_invalid_file_digest(self):
        _, envelope = self.package()
        envelope["manifest"]["files"]["main.pyc"] = "not-a-hash"
        with self.assertRaisesRegex(validation.ValidationError, "SHA-256"):
            validation.validate_manifest(self.sign(envelope["manifest"]))

    def test_rejects_duplicate_json_keys(self):
        with self.assertRaisesRegex(validation.ValidationError, "Duplicate JSON"):
            json.loads('{"revision": 1, "revision": 2}', object_pairs_hook=validation.unique_object)

    def test_rejects_unsafe_paths(self):
        for name in ("../main.pyc", "/main.pyc", "C:/main.pyc", "static\\panel.js", "static//panel.js",
                     "cfg/bot.pyc", "devices/profile.pyc", "runtime/patch.pyc", "models/model.pyc", "main.exe"):
            with self.subTest(name=name), self.assertRaises(validation.ValidationError):
                validation.safe_path(name)

    def test_detects_archive_size_change(self):
        archive, envelope = self.package()
        with self.assertRaisesRegex(validation.ValidationError, "size mismatch"):
            validation.validate_archive(archive + b"changed", envelope["manifest"])

    def test_detects_archive_corruption(self):
        archive, envelope = self.package()
        changed = archive[:-1] + bytes([archive[-1] ^ 1])
        with self.assertRaisesRegex(validation.ValidationError, "Archive SHA-256"):
            validation.validate_archive(changed, envelope["manifest"])

    def test_detects_wrong_file_hash(self):
        archive, envelope = self.package()
        envelope["manifest"]["files"]["main.pyc"] = "0" * 64
        with self.assertRaisesRegex(validation.ValidationError, "File SHA-256"):
            validation.validate_archive(archive, envelope["manifest"])

    def test_rejects_zip_duplicates(self):
        files = {"static/js/panel.js": b"const x = 1;"}
        archive, envelope = self.package(files, entries=list(files.items()) * 2)
        with self.assertRaisesRegex(validation.ValidationError, "Duplicate ZIP"):
            validation.validate_archive(archive, envelope["manifest"])

    def test_rejects_extra_files(self):
        archive, envelope = self.package()
        del envelope["manifest"]["files"]["main.pyc"]
        with self.assertRaisesRegex(validation.ValidationError, "inventory"):
            validation.validate_archive(archive, envelope["manifest"])

    def test_rejects_symlinks(self):
        entry = zipfile.ZipInfo("static/js/link.js")
        entry.create_system = 3
        entry.external_attr = 0o120777 << 16
        archive, envelope = self.package({entry.filename: b"target"}, entries=[(entry, b"target")])
        with self.assertRaisesRegex(validation.ValidationError, "Symlink"):
            validation.validate_archive(archive, envelope["manifest"])

    def test_rejects_excessive_unpacked_size(self):
        archive, envelope = self.package()
        with patch.object(validation, "MAX_SIZE", 1), self.assertRaisesRegex(validation.ValidationError, "Unpacked"):
            validation.validate_archive(archive, envelope["manifest"])

    def test_rejects_wrong_or_truncated_bytecode(self):
        for code in (b"short", bytes.fromhex("cb0d0d0a") + bytes(16)):
            with self.subTest(code=code):
                archive, envelope = self.package({"main.pyc": code})
                with self.assertRaisesRegex(validation.ValidationError, "bytecode header"):
                    validation.validate_archive(archive, envelope["manifest"])

    def test_detects_invalid_javascript_in_both_channels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "static/js/panel.js"
            script.parent.mkdir(parents=True)
            script.write_text("const ready = true;", encoding="utf-8")
            packed = {"static/js/panel.js": b"const ready = true;"}
            self.assertEqual(validation.check_javascript(root, packed), 2)
            packed["static/js/panel.js"] = b"const = ;"
            with self.assertRaisesRegex(validation.ValidationError, "JavaScript syntax"):
                validation.check_javascript(root, packed)
            packed["static/js/panel.js"] = b"const ready = true;"
            script.write_text("const = ;", encoding="utf-8")
            with self.assertRaisesRegex(validation.ValidationError, "JavaScript syntax"):
                validation.check_javascript(root, packed)


if __name__ == "__main__":
    unittest.main()
