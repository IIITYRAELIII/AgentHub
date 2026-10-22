from __future__ import annotations

from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import package_test
import install_release as installer


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = package_test.ReadyPackageTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.descriptor = self.fixture.build()
        self.descriptor["asset"] = installer.PACKAGE_ASSET
        self.zip_bytes = self.fixture.archive.read_bytes()
        self.tag = "v1.0.0"
        self.base = f"https://github.com/{installer.REPOSITORY}/releases/download/{self.tag}/"
        self.requests = []
        self.descriptor_bytes = json.dumps(self.descriptor).encode()
        self.metadata = {"tag_name": self.tag, "draft": False, "prerelease": False,
                         "published_at": "2026-01-01T00:00:00Z", "assets": [
                             self.asset(installer.PACKAGE_ASSET, self.zip_bytes),
                             self.asset(installer.PACKAGE_ASSET+".json", self.descriptor_bytes)]}

    def asset(self, name, data):
        return {"name": name, "browser_download_url": self.base+name, "size": len(data),
                "state": "uploaded", "digest": "sha256:"+hashlib.sha256(data).hexdigest()}

    def open(self, request, timeout):
        self.assertEqual(timeout, 30)
        self.assertNotIn("Authorization", request.headers)
        self.requests.append(request.full_url)
        if request.full_url.startswith(f"https://api.github.com/repos/{installer.REPOSITORY}/releases/"):
            return io.BytesIO(json.dumps(self.metadata).encode())
        if request.full_url == self.base+installer.PACKAGE_ASSET+".json":
            return io.BytesIO(self.descriptor_bytes)
        if request.full_url == self.base+installer.PACKAGE_ASSET:
            return io.BytesIO(self.zip_bytes)
        raise AssertionError("Unexpected network destination")

    def fetch(self, release="latest"):
        scratch = self.fixture.root/"download"
        scratch.mkdir()
        with patch("urllib.request.OpenerDirector.open", self.open):
            return installer.fetch_release(release, scratch)

    def test_latest_and_exact_tag_resolve_once_to_same_versioned_verified_package(self):
        for selector in ("latest", self.tag):
            with self.subTest(selector=selector), tempfile.TemporaryDirectory(
                    dir=os.environ.get("AGENT_HUB_TEST_TEMP")) as temporary:
                with patch("urllib.request.OpenerDirector.open", self.open):
                    archive, tag, outer = installer.fetch_release(selector, Path(temporary))
                extracted = Path(temporary)/"verified"
                inner = installer.extract_verified(archive, outer["sha256"], extracted)
                installer.verify_release_descriptor(inner, extracted, outer)
                self.assertEqual((tag, inner["releaseId"]), (self.tag, "synthetic-1"))
                self.assertEqual(archive.read_bytes(), self.zip_bytes)
        self.assertEqual(len(self.requests), 6)

    def test_missing_release_fails_without_source_archive_fallback(self):
        error = urllib.error.HTTPError("https://api.github.com/", 404, "No release", {}, None)
        self.addCleanup(error.close)
        with patch("urllib.request.OpenerDirector.open", side_effect=error):
            with self.assertRaises(urllib.error.HTTPError):
                installer.release_metadata("latest")
        self.assertEqual(self.requests, [])

    def test_unpublished_prerelease_foreign_or_duplicate_assets_refuse_before_download(self):
        original = deepcopy(self.metadata)
        mutations = [lambda x: x.update(draft=True), lambda x: x.update(prerelease=True),
                     lambda x: x.update(published_at=None), lambda x: x.update(tag_name="../bad"),
                     lambda x: x["assets"][0].update(browser_download_url=self.base.replace("AgentHub", "Utilities")+installer.PACKAGE_ASSET),
                     lambda x: x["assets"].append(deepcopy(x["assets"][0])),
                     lambda x: x["assets"][0].update(digest=None),
                     lambda x: x["assets"][0].update(size=True)]
        for mutate in mutations:
            self.metadata = deepcopy(original)
            mutate(self.metadata)
            with self.subTest(metadata=self.metadata), tempfile.TemporaryDirectory(
                    dir=os.environ.get("AGENT_HUB_TEST_TEMP")) as temporary:
                self.requests.clear()
                with patch("urllib.request.OpenerDirector.open", self.open), self.assertRaises(ValueError):
                    installer.fetch_release("latest", Path(temporary))
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_exact_tag_mismatch_and_api_redirect_refuse(self):
        with patch("urllib.request.OpenerDirector.open", self.open), self.assertRaises(ValueError):
            installer.release_metadata("v2")
        with self.assertRaisesRegex(ValueError, "redirect"):
            installer.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid/")

    def test_descriptor_tamper_refuses_before_zip_request(self):
        self.descriptor_bytes += b" "
        with self.assertRaisesRegex(ValueError, "descriptor SHA-256"):
            self.fetch()
        self.assertEqual(len(self.requests), 2)

    def test_consistent_descriptor_hash_with_wrong_repository_refuses(self):
        self.descriptor["repository"] = "other/AgentHub"
        self.descriptor_bytes = json.dumps(self.descriptor).encode()
        self.metadata["assets"][1] = self.asset(installer.PACKAGE_ASSET+".json", self.descriptor_bytes)
        with self.assertRaisesRegex(ValueError, "descriptor and published"):
            self.fetch()
        self.assertEqual(len(self.requests), 2)

    def test_zip_mutation_refuses_before_extraction_or_execution(self):
        self.zip_bytes = self.zip_bytes[:-1]+bytes([self.zip_bytes[-1] ^ 1])
        with self.assertRaisesRegex(ValueError, "ZIP SHA-256"):
            self.fetch()
        self.assertFalse((self.fixture.root/"download/verified").exists())

    def test_wrong_inner_identity_or_manifest_refuses(self):
        archive, _, outer = self.fetch()
        extracted = self.fixture.root/"verified"
        inner = installer.extract_verified(archive, outer["sha256"], extracted)
        for change in ({"sourceCommit": "2"*40}, {"releaseId": "other"},
                       {"version": "999"}, {"packageManifestSha256": "0"*64}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "Extracted package"):
                installer.verify_release_descriptor(inner, extracted, {**outer, **change})

    def test_metadata_and_descriptor_budget_before_zip(self):
        original_open = self.open
        with patch("urllib.request.OpenerDirector.open", lambda *a, **k: io.BytesIO(b" "*(installer.MAX_METADATA_BYTES+1))):
            with self.assertRaisesRegex(ValueError, "metadata exceeds"):
                installer.release_metadata("latest")
        self.descriptor_bytes = b" "*(installer.MAX_METADATA_BYTES+1)
        with patch("urllib.request.OpenerDirector.open", original_open):
            with self.assertRaisesRegex(ValueError, "download budget"):
                self.fetch()


if __name__ == "__main__":
    unittest.main()
