from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import build_release as stage


class PackageCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hub-package-checkpoint-", dir=os.environ.get("AGENT_HUB_TEST_TEMP"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prepared = self.root / "prepared"
        self.prepared.mkdir()
        content = {"AgentHub.RuntimeHost.exe": b"synthetic: never execute",
                   "agent-hub-main.mjs": b"export {};\n",
                   "node_modules/example/package.json": b'{"name":"example","version":"1.0.0","license":"MIT"}',
                   "node_modules/example/LICENSE": b"synthetic dependency notice"}
        for name, data in content.items():
            target = self.prepared / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        self.manifest = {"releaseId": "checkpoint-fixture", "version": "2026.10.22", "releaseVersion": "2026.10.22.1",
                         "publicationRevision": "1" * 40, "sourceRoot": str(self.root / "private-source"),
                         "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                                   for name, data in content.items()]}
        self.manifest_file = self.prepared / "runtime-manifest.json"
        self.manifest_file.write_text(json.dumps(self.manifest), encoding="utf-8")
        self.receipt = {"schema": 1, "phase": "PREPARED", "operationId": "original-operation", "generation": 2,
                        "sourceCommit": "1" * 40, "releaseId": self.manifest["releaseId"],
                        "version": self.manifest["releaseVersion"], "releaseRoot": str(self.prepared),
                        "manifestSha256": stage.file_hash(self.manifest_file)}
        self.receipt_file = self.root / "prepared.json"
        self.save_receipt()
        self.license = self.root / "LICENSE"
        self.notices = self.root / "NOTICES"
        self.license.write_text("synthetic own license", encoding="utf-8")
        self.notices.write_text("synthetic notices", encoding="utf-8")
        self.output = self.root / "output"
        self.namespace = self.output / self.receipt["version"]

    def save_receipt(self):
        self.receipt_file.write_text(json.dumps(self.receipt), encoding="utf-8")
        self.receipt_sha = stage.file_hash(self.receipt_file)

    def run_stage(self, **overrides):
        arguments = dict(receipt_path=self.receipt_file, receipt_sha256=self.receipt_sha, source_commit="1" * 40,
                         version=self.manifest["releaseVersion"], license_file=self.license,
                         notices_file=self.notices, output_root=self.output)
        arguments.update(overrides)
        return stage.package_release(**arguments)

    def snapshot(self):
        return {str(p.relative_to(self.namespace)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.namespace.rglob("*") if p.is_file()}

    @unittest.skipUnless(os.name == "nt", "Windows release-operation path length")
    def test_deep_operation_checkpoint_verifies_long_dependency_path_and_reuses_result(self):
        name = "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.d.mts.map"
        data = b"synthetic declared dependency source map"
        target = self.prepared / name
        target.parent.mkdir(parents=True)
        target.write_bytes(data)
        self.manifest["files"].append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        self.manifest_file.write_text(json.dumps(self.manifest), encoding="utf-8")
        self.receipt["manifestSha256"] = stage.file_hash(self.manifest_file)
        self.save_receipt()
        self.output = self.root / "release-operation-executions" / ("e" * 64) / "distribution"
        self.namespace = self.output / self.receipt["version"]
        self.assertGreater(len(str(self.namespace / ".verify-owned" / "package/runtime" / name)), 260)
        # Cleanup also uses the native Windows namespace, independently of the
        # implementation being checked, so a failing regression keeps no files.
        self.addCleanup(shutil.rmtree, Path("\\\\?\\" + str(self.root.absolute())), True)
        first = self.run_stage()
        before = self.snapshot()
        self.assertEqual(first["phase"], "PACKAGED")
        self.assertEqual(self.run_stage(), first)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(any(p.name.startswith(".verify-") for p in self.namespace.iterdir()))

    def test_exact_retry_reuses_saved_artifacts_without_build_or_external_effect(self):
        original = self.manifest_file.read_bytes()
        with patch.object(stage, "build_package", wraps=stage.build_package) as builder:
            with patch("socket.create_connection", side_effect=AssertionError("network forbidden")):
                first = self.run_stage()
                before = self.snapshot()
                second = self.run_stage()
            self.assertEqual(builder.call_count, 1)
        self.assertEqual(first, second)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.manifest_file.read_bytes(), original)
        self.assertEqual(first["phase"], "PACKAGED")
        self.assertEqual({row["name"] for row in first["assets"]}, set(stage.ASSETS))
        self.assertFalse(any(p.name.startswith(".verify-") for p in self.namespace.iterdir()))
        self.assertNotIn("releaseRoot", first["inputs"])

    def test_cli_is_the_same_safe_checkpoint_on_repeat(self):
        command = [sys.executable, str(stage.ROOT / "build_release.py"), "--prepared-receipt", str(self.receipt_file),
                   "--receipt-sha256", self.receipt_sha, "--source-commit", "1" * 40,
                   "--version", self.manifest["releaseVersion"], "--license", str(self.license),
                   "--notices", str(self.notices), "--output-root", str(self.output)]
        results = []
        for _ in range(2):
            value = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(value.returncode, 0, value.stderr)
            self.assertEqual(value.stderr, "")
            results.append(json.loads(value.stdout))
        self.assertEqual(results[0], results[1])

    def test_wrong_expected_inputs_refuse_before_output(self):
        for override in [{"receipt_sha256": "0" * 64}, {"source_commit": "2" * 40},
                         {"version": "2026.10.22.2"}, {"version": "../escape"}]:
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.run_stage(**override)
            self.assertFalse(self.output.exists())

    def test_receipt_schema_and_manifest_binding_refuse_before_output(self):
        original = dict(self.receipt)
        for key, value in [("schema", True), ("phase", "READY"), ("generation", True),
                           ("generation", 0), ("operationId", ""), ("manifestSha256", "0" * 64),
                           ("releaseId", "foreign"), ("releaseRoot", "relative/path"), ("extra", "unknown")]:
            with self.subTest(key=key):
                self.receipt = {**original, key: value}
                self.save_receipt()
                with self.assertRaises(ValueError):
                    self.run_stage()
                self.assertFalse(self.output.exists())

    def test_manifest_version_drift_is_not_patched_or_allocated(self):
        self.manifest["releaseVersion"] = "2026.10.22.99"
        self.manifest_file.write_text(json.dumps(self.manifest), encoding="utf-8")
        self.receipt["manifestSha256"] = stage.file_hash(self.manifest_file)
        self.save_receipt()
        with self.assertRaises(ValueError):
            self.run_stage(version=self.receipt["version"])
        self.assertEqual(json.loads(self.manifest_file.read_text())["releaseVersion"], "2026.10.22.99")
        self.assertFalse(self.output.exists())

    def test_changed_prepared_payload_refuses_even_when_saved_package_is_valid(self):
        self.run_stage()
        before = self.snapshot()
        (self.prepared / "agent-hub-main.mjs").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.run_stage()
        self.assertEqual(self.snapshot(), before)

    def test_changed_license_notices_receipt_and_tool_identity_cannot_replace_saved_version(self):
        self.run_stage()
        before = self.snapshot()
        for target in [self.license, self.notices, self.receipt_file]:
            with self.subTest(target=target.name):
                original = target.read_bytes()
                target.write_bytes(original + b"\n")
                try:
                    overrides = {"receipt_sha256": stage.file_hash(target)} if target == self.receipt_file else {}
                    with self.assertRaises(ValueError):
                        self.run_stage(**overrides)
                    self.assertEqual(self.snapshot(), before)
                finally:
                    target.write_bytes(original)
        real_inputs = stage._inputs

        def changed_tool(*args):
            inputs, prepared, raw = real_inputs(*args)
            inputs["tools"]["build_release.py"] = "0" * 64
            return inputs, prepared, raw

        with patch.object(stage, "_inputs", side_effect=changed_tool), self.assertRaises(ValueError):
            self.run_stage()
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_missing_or_extra_public_asset_refuses_without_overwrite(self):
        self.run_stage()
        originals = self.snapshot()
        for asset in stage.ASSETS:
            with self.subTest(asset=asset):
                target = self.namespace / "assets" / asset
                prior = target.read_bytes()
                target.write_bytes(prior + b"corruption")
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    self.run_stage()
                self.assertTrue(target.read_bytes().endswith(b"corruption"))
                target.write_bytes(prior)
        extra = self.namespace / "assets/private-receipt.json"
        extra.write_text("foreign useful WIP", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.run_stage()
        self.assertEqual(extra.read_text(), "foreign useful WIP")
        extra.unlink()
        target = self.namespace / "assets/SHA256SUMS"
        target.unlink()
        with self.assertRaises(ValueError):
            self.run_stage()
        self.assertFalse(target.exists())
        self.assertEqual(self.namespace.joinpath("result.json").read_bytes(), originals["result.json"][0])

    def test_foreign_namespace_and_overlapping_inputs_are_preserved(self):
        self.namespace.mkdir(parents=True)
        sentinel = self.namespace / "keep.txt"
        sentinel.write_text("foreign", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.run_stage()
        self.assertEqual(sentinel.read_text(), "foreign")
        for target in [self.prepared, stage.ROOT]:
            with self.assertRaisesRegex(ValueError, "overlaps"):
                self.run_stage(output_root=target)
        hop = self.root / "hop"
        hop.mkdir()
        with self.assertRaisesRegex(ValueError, "overlaps"):
            self.run_stage(output_root=hop / ".." / "prepared")

    def test_archive_cutpoint_stays_unknown_and_never_rebuilds(self):
        def interrupted(*args):
            args[-1].write_bytes(b"partial ZIP")
            raise OSError("synthetic ZIP cutpoint")

        with patch.object(stage, "build_package", side_effect=interrupted), self.assertRaises(OSError):
            self.run_stage()
        before = self.snapshot()
        with patch.object(stage, "build_package", side_effect=AssertionError("must not rebuild")):
            with self.assertRaisesRegex(ValueError, "unknown"):
                self.run_stage()
        self.assertEqual(self.snapshot(), before)

    def test_result_persistence_cutpoint_keeps_complete_assets_without_false_success(self):
        writer = stage._write_json

        def deny_result(target, value):
            if target.name == "result.json":
                raise OSError("synthetic result persistence cutpoint")
            writer(target, value)

        with patch.object(stage, "_write_json", side_effect=deny_result), self.assertRaises(OSError):
            self.run_stage()
        self.assertFalse((self.namespace / "result.json").exists())
        self.assertEqual({p.name for p in (self.namespace / "assets").iterdir()}, set(stage.ASSETS))
        before = self.snapshot()
        with patch.object(stage, "build_package", side_effect=AssertionError("must not rebuild")):
            with self.assertRaisesRegex(ValueError, "unknown"):
                self.run_stage()
        self.assertEqual(self.snapshot(), before)

    def test_oversize_receipt_refuses_before_json_or_output(self):
        self.receipt_file.write_bytes(b" " * (1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "size bound"):
            self.run_stage()
        self.assertFalse(self.output.exists())

    def test_reparse_output_and_prepared_directory_are_refused(self):
        target = self.root / "foreign"
        target.mkdir()
        sentinel = target / "keep.txt"
        sentinel.write_text("preserve", encoding="utf-8")
        link = self.root / "alias"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.addCleanup(lambda: link.rmdir() if link.exists() else None)
        else:
            link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Reparse"):
            self.run_stage(output_root=link)
        self.receipt["releaseRoot"] = str(link)
        self.save_receipt()
        with self.assertRaisesRegex(ValueError, "Reparse"):
            self.run_stage()
        self.assertEqual(sentinel.read_text(), "preserve")
        self.assertEqual(list(target.iterdir()), [sentinel])


if __name__ == "__main__":
    unittest.main()
