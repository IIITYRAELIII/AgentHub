from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
import zipfile

from build_package import build_package
from install_release import extract_verified, file_hash, safe_name, validate_source_url


class ReadyPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hub-package-test-", dir=os.environ.get("AGENT_HUB_TEST_TEMP"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prepared = self.root/"prepared"
        self.prepared.mkdir()
        content = {"AgentHub.RuntimeHost.exe": b"synthetic fixture: never execute",
                   "agent-hub-main.mjs": b"export {};\n", "codex-stop-hook-launcher.mjs": b"export {};\n",
                   "node_modules/example/package.json": b'{"name":"example","version":"1.0.0","license":"MIT"}',
                   "node_modules/example/LICENSE": b"synthetic dependency notice"}
        for name, data in content.items():
            path = self.prepared/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.manifest = {"releaseId": "synthetic-1", "version": "0.0.0", "sourceRoot": "X:/private-author/source", "publicationRevision": "1"*40,
                         "files": [{"path": p, "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest()}
                                   for p, b in content.items()]}
        (self.prepared/"runtime-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        self.license = self.root/"LICENSE"
        self.license.write_text("synthetic license")
        self.notices = self.root/"NOTICES"
        self.notices.write_text("synthetic notices")
        self.archive = self.root/"package.zip"

    def build(self):
        return build_package(self.prepared, self.license, self.notices, "1"*40, self.archive)

    def test_reproducible_new_artifact_exact_files_private_root_removed_original_preserved(self):
        original = (self.prepared/"runtime-manifest.json").read_bytes()
        result = self.build()
        other = build_package(self.prepared, self.license, self.notices, "1"*40, self.root/"other.zip")
        self.assertEqual(result["sha256"], other["sha256"])
        destination = self.root/"extracted"
        descriptor = extract_verified(self.archive, result["sha256"], destination)
        self.assertEqual(descriptor["releaseId"], "synthetic-1")
        runtime_manifest = json.loads((destination/"runtime/runtime-manifest.json").read_text())
        self.assertNotIn("sourceRoot", runtime_manifest)
        self.assertEqual(runtime_manifest["distributionSource"]["preparedManifestSha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual((self.prepared/"runtime-manifest.json").read_bytes(), original)
        inventory = json.loads((destination/"DEPENDENCIES.json").read_text())
        self.assertEqual(inventory["packages"][0]["name"], "example")
        self.assertEqual(len(inventory["packages"][0]["notices"]), 1)
        self.assertFalse(result["publicApproval"])

    def test_bad_outer_checksum_refuses_before_any_extraction(self):
        self.build()
        destination = self.root/"no-extract"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            extract_verified(self.archive, "0"*64, destination)
        self.assertFalse(destination.exists())

    @unittest.skipUnless(os.name == "nt", "Windows recipient scratch path length")
    def test_long_recipient_path_checks_payload_and_removes_only_corrupt_extraction(self):
        name = "node_modules/example/resources/beta/memory-stores/memory-stores.d.mts.map"
        data = b"synthetic dependency body"
        target = self.prepared / name
        target.parent.mkdir(parents=True)
        target.write_bytes(data)
        self.manifest["files"].append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        (self.prepared / "runtime-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        self.addCleanup(shutil.rmtree, Path("\\\\?\\" + str(self.root.absolute())), True)
        result = self.build()
        base = self.root / "release-operation-executions" / ("d" * 64) / "distribution" / "2.0.2+build.12345678" / "verified"
        self.assertGreater(len(str(base / "runtime" / name)), 260)
        sentinel = self.root / "keep.txt"
        sentinel.write_bytes(b"owned input stays")
        extract_verified(self.archive, result["sha256"], base)
        native_base = Path("\\\\?\\" + str(base.absolute()))
        self.assertEqual((native_base / "runtime" / name).read_bytes(), data)
        shutil.rmtree(native_base)
        self.tamper("runtime/" + name, b"corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            extract_verified(self.archive, file_hash(self.archive), base)
        self.assertFalse(base.exists())
        self.assertEqual(sentinel.read_bytes(), b"owned input stays")
        self.assertTrue(self.archive.exists())

    def tamper(self, name, data, *, append=False, mode=None):
        with zipfile.ZipFile(self.archive) as archive:
            entries = [(x.filename, archive.read(x)) for x in archive.infolist()]
        with zipfile.ZipFile(self.archive, "w") as archive:
            for old_name, old_data in entries:
                if old_name == name and not append:
                    old_data = data
                archive.writestr(old_name, old_data)
            if append:
                info = zipfile.ZipInfo(name)
                if mode is not None:
                    info.external_attr = mode << 16
                archive.writestr(info, data)

    def test_inner_corruption_fails_and_removes_only_own_extraction(self):
        self.build()
        supplied = self.root/"keep.txt"
        supplied.write_text("keep supplied input")
        self.tamper("runtime/agent-hub-main.mjs", b"corrupted")
        destination = self.root/"bad"
        with self.assertRaisesRegex(ValueError, "integrity"):
            extract_verified(self.archive, file_hash(self.archive), destination)
        self.assertFalse(destination.exists())
        self.assertTrue(self.archive.exists())
        self.assertEqual(supplied.read_text(), "keep supplied input")

    def test_zip_slip_duplicate_and_link_refuse_before_extract(self):
        self.build()
        original = self.archive.read_bytes()
        for name, mode in [("../escape", None), ("runtime/AGENT-HUB-MAIN.MJS", None),
                           ("runtime/link", stat.S_IFLNK | 0o777), ("runtime/CON.txt", None)]:
            with self.subTest(name=name):
                self.archive.write_bytes(original)
                self.tamper(name, b"target", append=True, mode=mode)
                destination = self.root/"bad"
                with self.assertRaises(ValueError):
                    extract_verified(self.archive, file_hash(self.archive), destination)
                self.assertFalse(destination.exists())
                self.assertFalse((self.root/"escape").exists())

    def test_prepared_file_mutation_refuses(self):
        (self.prepared/"agent-hub-main.mjs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.build()
        self.assertFalse(self.archive.exists())

    def test_existing_versioned_asset_is_never_overwritten(self):
        self.archive.write_bytes(b"pre-existing supplied asset")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        self.assertEqual(self.archive.read_bytes(), b"pre-existing supplied asset")

    def test_old_publication_identity_cannot_be_relabelled_as_new_export(self):
        with self.assertRaisesRegex(ValueError, "cannot be relabeled"):
            build_package(self.prepared, self.license, self.notices, "2"*40, self.archive)
        self.assertFalse(self.archive.exists())

    def test_only_versioned_public_publisher_and_https_redirects(self):
        valid = "https://github.com/IIITYRAELIII/AgentHub/releases/download/v1/package.zip"
        self.assertEqual(validate_source_url(valid), valid)
        for url in [valid.replace("https:", "http:"), valid.replace("AgentHub", "Utilities"),
                    "https://evil.example/package.zip", "https://github.com/IIITYRAELIII/AgentHub/archive/main.zip"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_source_url(url)
        with self.assertRaises(ValueError):
            validate_source_url("https://evil.example/redirect", redirect=True)
        for name in ["a/../b", "/absolute", "C:/absolute", "a\\b", "a/NUL", "a/end.", "a//b"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_name(name)


if __name__ == "__main__":
    unittest.main()
