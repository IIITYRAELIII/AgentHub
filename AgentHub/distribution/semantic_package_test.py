from __future__ import annotations

import json
import hashlib
import io
from pathlib import Path
import tempfile
from unittest.mock import patch
import install_release as installer
import unittest
import build_release_test as _base
from install_release import semantic_fields, valid_artifact_version, extract_verified


class SemanticPackageTests(_base.PackageCheckpointTests):
    """Exercise the SAME real pack/checkpoint/reuse/cutpoints with the new identity."""
    def setUp(self):
        super().setUp()
        self.manifest.update(version="2.0.0", publicVersion="2.0.0", buildNumber=30000001,
                             versionScheme="semver-build-v1", releaseVersion="2.0.0+build.30000001")
        self.manifest_file.write_text(json.dumps(self.manifest), encoding="utf-8")
        self.receipt.update(version=self.manifest["releaseVersion"],
                            manifestSha256=__import__("build_release").file_hash(self.manifest_file))
        self.save_receipt()
        self.namespace = self.output/self.receipt["version"]

    def test_semantic_descriptor_and_original_nine_field_receipt_stay_bound(self):
        result = self.run_stage()
        self.assertEqual(set(self.receipt), __import__("build_release").RECEIPT_FIELDS)
        descriptor = json.loads((self.namespace/"assets/AgentHub-win32-x64.zip.json").read_text())
        for key, value in semantic_fields(self.manifest).items():
            self.assertEqual(descriptor[key], value)
            self.assertEqual(result["inputs"][key], value)
        extracted = self.root/"consumer"
        inner = extract_verified(self.namespace/"assets/AgentHub-win32-x64.zip", descriptor["sha256"], extracted)
        self.assertEqual(semantic_fields(inner, descriptor=True), semantic_fields(self.manifest))
        self.assertEqual(json.loads((extracted/"runtime/runtime-manifest.json").read_text())["version"], "2.0.0")

    def test_stable_public_tag_is_distinct_from_artifact_and_mismatch_refuses(self):
        self.run_stage()
        archive = self.namespace/"assets/AgentHub-win32-x64.zip"
        descriptor = archive.with_suffix(".zip.json").read_bytes()
        body = archive.read_bytes()
        for tag, success in [("2.0.0", True), ("2.0.1", False)]:
            base = f"https://github.com/{installer.REPOSITORY}/releases/download/{tag}/"
            def asset(name, raw):
                return dict(name=name, browser_download_url=base+name, size=len(raw),
                            state="uploaded", digest="sha256:"+hashlib.sha256(raw).hexdigest())
            metadata = dict(tag_name=tag, draft=False, prerelease=False, published_at="2026-10-22T00:00:00Z",
                            assets=[asset(installer.PACKAGE_ASSET, body), asset(installer.PACKAGE_ASSET+".json", descriptor)])
            responses = {f"https://api.github.com/repos/{installer.REPOSITORY}/releases/latest": json.dumps(metadata).encode(),
                         base+installer.PACKAGE_ASSET: body, base+installer.PACKAGE_ASSET+".json": descriptor}
            with tempfile.TemporaryDirectory(dir=self.root) as scratch, patch(
                    "urllib.request.OpenerDirector.open", side_effect=lambda request, timeout: io.BytesIO(responses[request.full_url])):
                if success:
                    _, actual, outer = installer.fetch_release("latest", Path(scratch))
                    self.assertEqual((actual, outer["version"]), ("2.0.0", "2.0.0+build.30000001"))
                else:
                    with self.assertRaisesRegex(ValueError, "tag"):
                        installer.fetch_release("latest", Path(scratch))

    def test_prerelease_cannot_enter_stable_discovery_with_a_false_provider_flag(self):
        self.run_stage()
        descriptor = json.loads((self.namespace/"assets/AgentHub-win32-x64.zip.json").read_text())
        descriptor.update(publicVersion="2.0.0-rc.1", version="2.0.0-rc.1+build.30000001")
        raw = json.dumps(descriptor).encode()
        tag = "2.0.0-rc.1"
        base = f"https://github.com/{installer.REPOSITORY}/releases/download/{tag}/"
        def asset(name, body):
            return dict(name=name, browser_download_url=base+name, size=len(body), state="uploaded",
                        digest="sha256:"+hashlib.sha256(body).hexdigest())
        metadata = dict(tag_name=tag, draft=False, prerelease=False, published_at="2026-10-22T00:00:00Z",
                        assets=[asset(installer.PACKAGE_ASSET, (self.namespace/"assets/AgentHub-win32-x64.zip").read_bytes()),
                                asset(installer.PACKAGE_ASSET+".json", raw)])
        requests = []
        def response(request, timeout):
            requests.append(request.full_url)
            return io.BytesIO(raw if request.full_url.endswith(".json") else json.dumps(metadata).encode())
        with tempfile.TemporaryDirectory(dir=self.root) as scratch, patch("urllib.request.OpenerDirector.open", side_effect=response):
            with self.assertRaisesRegex(ValueError, "Prerelease"):
                installer.fetch_release("latest", Path(scratch))
        self.assertEqual(len(requests), 2)

    def test_build_drift_and_unknown_scheme_refuse_before_packaging(self):
        for changes in [{"buildNumber": 30000002}, {"publicVersion": "2.0.1"}, {"versionScheme": "unknown"}]:
            saved = dict(self.manifest)
            self.manifest.update(changes)
            self.manifest_file.write_text(json.dumps(self.manifest), encoding="utf-8")
            self.receipt["manifestSha256"] = __import__("build_release").file_hash(self.manifest_file)
            self.save_receipt()
            with self.assertRaises(ValueError):
                self.run_stage()
            self.assertFalse(self.output.exists())
            self.manifest = saved

    def test_public_precedence_grammar_is_distinct_from_artifact_identity(self):
        for value in ["2.0.0+build.12", "2.0.0-beta.1+build.12", "2.0.0-rc.1+build.13", "2026.10.12.31"]:
            self.assertTrue(valid_artifact_version(value))
        for value in ["2.0.0+build.0", "2.0.0-rc.01+build.12", "2.0.0+build.2100000001", "../2.0.0"]:
            self.assertFalse(valid_artifact_version(value))


if __name__ == "__main__":
    unittest.main()
