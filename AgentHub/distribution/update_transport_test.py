"""Recipient preparation controls; HTTPS is synthetic, filesystem/SQLite are real.

No fixture application or native updater runs. The final subprocess boundary is
observed only after the actual package and public-asset verification owners.
"""
from __future__ import annotations

from contextlib import closing, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import zipfile

import install_release as installer


def sha(body):
    return hashlib.sha256(body).hexdigest()


class PreparationTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hub-transport-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.runtime = self.root/"runtime"
        (self.runtime/"data").mkdir(parents=True)
        self.database = self.runtime/"data/runtime.sqlite"
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE TABLE maintenance_operations(operation_id TEXT PRIMARY KEY,operation_json TEXT)")
            db.commit()
        self.scratch = self.root/"scratch"
        self.scratch.mkdir()
        self.args = SimpleNamespace(runtime_root=self.runtime, scratch_root=self.scratch,
                                    operation_id="same-original", release="2.1.1", sha256=None)
        self.base = "https://github.com/IIITYRAELIII/AgentHub/releases/download/2.1.1/"
        files = {"install-prepared.mjs": b"fixture; never executed", "config.example.json": b"{}",
                 "LICENSE": b"fixture", "THIRD_PARTY_NOTICES.md": b"fixture",
                 "runtime/runtime-manifest.json": b'{}',
                 "runtime/AgentHub.RuntimeHost.exe": b"fixture; never executed",
                 "runtime/src/runtime/runtime-package-handoff.mjs": b"fixture; never executed"}
        package = dict(schema=1, repository=installer.REPOSITORY, platform="win32-x64", releaseId="transport-fixture",
                       sourceCommit="a"*40, version="2.1.1", files=[dict(path=k, bytes=len(v), sha256=sha(v)) for k,v in files.items()])
        raw = json.dumps(package).encode()
        body = io.BytesIO()
        with zipfile.ZipFile(body, "w") as archive:
            archive.writestr("package-manifest.json", raw)
            for name, value in files.items():
                archive.writestr(name, value)
        self.archive = body.getvalue()
        descriptor = dict(schema=1, repository=installer.REPOSITORY, platform="win32-x64", asset=installer.PACKAGE_ASSET,
                          releaseId=package["releaseId"], sourceCommit=package["sourceCommit"], version=package["version"],
                          bytes=len(self.archive), sha256=sha(self.archive), packageManifestSha256=sha(raw))
        self.descriptor = json.dumps(descriptor).encode()
        bodies = {installer.PACKAGE_ASSET: self.archive, installer.PACKAGE_ASSET+".json": self.descriptor,
                  "install_release.py": Path(installer.__file__).read_bytes()}
        self.metadata = dict(tag_name="2.1.1", draft=False, prerelease=False, published_at="2026-01-01T00:00:00Z",
                             assets=[dict(name=n, state="uploaded", size=len(b), digest="sha256:"+sha(b),
                                          browser_download_url=self.base+n) for n,b in bodies.items()])
        self.requests = []
        self.dispatches = []
        self.fail_asset = installer.PACKAGE_ASSET+".json"
        self.fail_once = True
        self.entered = None
        self.release_read = None

        test = self
        class Response(io.BytesIO):
            def __init__(self, data, fail=False):
                super().__init__(data)
                self.fail = fail
                self.headers = {"Content-Length": str(len(data))}
                self.status = 200
            def read(self, size=-1):
                if self.fail:
                    self.fail = False
                    raise TimeoutError("controlled TLS body interruption")
                if test.entered is not None:
                    test.entered.set()
                    if not test.release_read.wait(5):
                        raise RuntimeError("fixture reader not released")
                return super().read(size)
        def open_response(opener, request, timeout):
            url = request.full_url
            self.requests.append(url)
            if url == "https://api.github.com/repos/IIITYRAELIII/AgentHub/releases/tags/2.1.1":
                return Response(json.dumps(self.metadata).encode())
            name = url.removeprefix(self.base)
            self.assertIn(name, bodies)
            fail = self.fail_once and name == self.fail_asset
            if fail:
                self.fail_once = False
            return Response(bodies[name], fail)
        def dispatch(command, **kwargs):
            request = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
            self.dispatches.append(request)
            return SimpleNamespace(returncode=0)
        self.open_patch = patch.object(installer.urllib.request.OpenerDirector, "open", open_response)
        self.run_patch = patch.object(installer.subprocess, "run", dispatch)
        self.which_patch = patch.object(installer.shutil, "which", return_value="fixture-node-not-executed")
        for current in [self.open_patch, self.run_patch, self.which_patch]:
            current.start()
            self.addCleanup(current.stop)

    def prepare(self):
        with redirect_stdout(io.StringIO()) as output:
            installer.prepare_update(self.args)
        return output.getvalue()

    def partial(self):
        with self.assertRaises(TimeoutError):
            self.prepare()
        self.assertEqual(self.dispatches, [])
        return {p: p.read_bytes() for p in self.scratch.rglob("*") if p.is_file()}

    def test_interrupted_body_manual_same_original_finishes_once_and_keeps_failed_bytes(self):
        retained = self.partial()
        self.prepare()
        self.assertEqual(len(self.dispatches), 1, "working transport must allow explicit PRE-dispatch continuation")
        request = self.dispatches[0]
        self.assertEqual((request["operationId"], request["tag"]), (self.args.operation_id, self.args.release))
        self.assertEqual(Path(request["archive"]).read_bytes(), self.archive)
        self.assertEqual(Path(request["descriptor"]).read_bytes(), self.descriptor)
        for path, body in retained.items():
            self.assertEqual(path.read_bytes(), body, str(path))
        requests = len(self.requests)
        self.prepare()
        self.assertEqual((len(self.dispatches), len(self.requests)), (1, requests))

    def test_interrupted_archive_is_retained_and_explicit_continuation_reverifies_all_assets(self):
        self.fail_asset = installer.PACKAGE_ASSET
        retained = self.partial()
        self.assertTrue(any(p.name == "release.json" and b == self.descriptor for p,b in retained.items()))
        self.prepare()
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(self.requests.count(self.base+installer.PACKAGE_ASSET+".json"), 2)
        for path, body in retained.items():
            self.assertEqual(path.read_bytes(), body)

    def test_drifted_public_selection_refuses_before_another_asset_read(self):
        retained = self.partial()
        self.metadata["assets"][0]["digest"] = "sha256:"+"f"*64
        count = len(self.requests)
        with self.assertRaisesRegex(ValueError, "selection changed"):
            self.prepare()
        self.assertEqual(len(self.requests), count+1)  # metadata only
        self.assertEqual(self.dispatches, [])
        for path, body in retained.items():
            self.assertEqual(path.read_bytes(), body)

    def test_missing_asset_selection_after_partial_body_is_not_repinned(self):
        self.partial()
        selection = next(self.scratch.glob("*/selection.json"))
        selection.rename(self.root/"retained-selection.json")
        count = len(self.requests)
        with self.assertRaisesRegex(ValueError, "selection is missing"):
            self.prepare()
        self.assertEqual((len(self.requests), len(self.dispatches)), (count+1, 0))

    def test_changed_additional_pin_refuses_same_original_before_network(self):
        self.partial()
        count = len(self.requests)
        self.args.sha256 = "a"*64
        with self.assertRaisesRegex(ValueError, "selection or physical"):
            self.prepare()
        self.assertEqual((len(self.requests), len(self.dispatches)), (count, 0))

    def test_changed_executing_installer_refuses_before_network(self):
        self.partial()
        other = self.root/"changed-installer.py"
        other.write_bytes(Path(installer.__file__).read_bytes()+b"\n# changed\n")
        count = len(self.requests)
        with patch.object(installer, "__file__", str(other)):
            with self.assertRaisesRegex(ValueError, "selection or physical"):
                self.prepare()
        self.assertEqual((len(self.requests), len(self.dispatches)), (count, 0))

    def test_real_sqlite_read_failure_is_not_absence_and_never_dispatches(self):
        self.partial()
        before = self.database.read_bytes()
        count = len(self.requests)
        with closing(sqlite3.connect(self.database)) as database:
            database.execute("BEGIN EXCLUSIVE")
            with self.assertRaises(sqlite3.OperationalError):
                self.prepare()
            database.rollback()
        self.assertEqual((len(self.requests), len(self.dispatches)), (count, 0))
        self.assertEqual(self.database.read_bytes(), before)

    def test_existing_unknown_original_is_read_only_even_with_preparation_receipt(self):
        self.partial()
        original = dict(operationId=self.args.operation_id, kind="restart", status="reconciling", outcome="unknown")
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("INSERT INTO maintenance_operations VALUES(?,?)", (self.args.operation_id, json.dumps(original)))
            db.commit()
        before = self.database.read_bytes()
        count = len(self.requests)
        self.assertEqual(json.loads(self.prepare())["outcome"], "unknown")
        self.assertEqual((len(self.requests), len(self.dispatches)), (count, 0))
        self.assertEqual(self.database.read_bytes(), before)

    def test_lost_spawn_reply_and_absent_sql_never_reopen_durable_dispatch_fence(self):
        self.fail_once = False
        with patch.object(installer.subprocess, "run", side_effect=OSError("controlled lost spawn reply")) as spawn:
            with self.assertRaises(OSError):
                self.prepare()
            fences = list(self.scratch.rglob("dispatch-intent.json"))
            self.assertEqual(len(fences), 1)
            fence = json.loads(fences[0].read_text(encoding="utf-8"))
            request = fences[0].parent/"update-request.json"
            self.assertEqual(fence["requestSha256"], sha(request.read_bytes()))
            count = len(self.requests)
            self.assertEqual(json.loads(self.prepare())["state"], "unknown")
            self.assertEqual((spawn.call_count, len(self.requests)), (1, count))

    def test_concurrent_explicit_continuation_cannot_share_dispatch_admission(self):
        self.partial()
        self.entered, self.release_read = threading.Event(), threading.Event()
        # Do not redirect process-global stdout concurrently; only the canonical
        # owner/file lock is shared by these two actual preparation calls.
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(installer.prepare_update, self.args)
            try:
                self.assertTrue(self.entered.wait(5))
                with self.assertRaises(OSError):
                    installer.prepare_update(self.args)
            finally:
                self.release_read.set()
            first.result(timeout=5)
        self.assertEqual(len(self.dispatches), 1)

    def test_legacy_unbound_cache_is_never_adopted_or_modified(self):
        identity = sha((str(self.runtime.resolve())+"\0"+self.args.operation_id).encode())[:32]
        cache = self.scratch/("agenthub-update-"+identity)
        cache.mkdir()
        failed = cache/"release.json"
        failed.write_bytes(b"")
        before = failed.stat()
        self.assertEqual(json.loads(self.prepare())["state"], "unknown")
        self.assertEqual(list(cache.iterdir()), [failed])
        self.assertEqual((failed.stat().st_ino, failed.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertEqual((self.requests, self.dispatches), ([], []))

    def test_partial_receipt_hardlink_and_runtime_replacement_refuse(self):
        self.partial()
        receipt = next(self.scratch.glob("*/preparation.json"))
        body = receipt.read_bytes()
        count = len(self.requests)
        receipt.write_bytes(b'{"binding":')
        with self.assertRaises(json.JSONDecodeError):
            self.prepare()
        receipt.write_bytes(body)
        foreign = self.root/"foreign-receipt"
        os.link(receipt, foreign)
        try:
            with self.assertRaisesRegex(ValueError, "Linked, shared"):
                self.prepare()
            self.assertEqual(foreign.read_bytes(), body)
        finally:
            foreign.unlink()
        old = self.root/"retained-runtime"
        self.runtime.rename(old)
        self.runtime.mkdir()
        with self.assertRaisesRegex(ValueError, "selection or physical"):
            self.prepare()
        self.assertEqual((len(self.requests), len(self.dispatches)), (count, 0))

    @unittest.skipUnless(os.name == "nt", "actual Windows junction")
    def test_replaced_cache_junction_preserves_foreign_bytes_without_network(self):
        self.partial()
        cache = next(self.scratch.glob("agenthub-update-*"))
        saved = self.root/"retained-cache"
        cache.rename(saved)
        foreign = self.root/"foreign"
        foreign.mkdir()
        marker = foreign/"keep"
        marker.write_bytes(b"foreign untouched")
        # Setup invokes the real stdlib process function, not the observed
        # bootstrap subprocess boundary patched above.
        self.run_patch.stop()
        try:
            import subprocess
            subprocess.run(["cmd", "/c", "mklink", "/J", str(cache), str(foreign)], check=True, capture_output=True)
        finally:
            self.run_patch.start()
        count = len(self.requests)
        try:
            with self.assertRaisesRegex(ValueError, "Linked, shared"):
                self.prepare()
            self.assertEqual(marker.read_bytes(), b"foreign untouched")
            self.assertEqual((len(self.requests), len(self.dispatches)), (count, 0))
        finally:
            cache.rmdir()  # ONLY the exact owned junction, never its target.


if __name__ == "__main__":
    unittest.main()
