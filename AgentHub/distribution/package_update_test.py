"""Bounded package update acceptance with literal applications, no providers.

The legacy native Host is the immutable published 2.0.4 source. Only HTTPS
metadata transport and the applications are synthetic; the native cohort,
control protocol, backup, standalone installer and readiness owners are real.
"""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

from build_package import build_package

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(os.name == "nt", "Windows native package handoff")
class PackageUpdateTests(unittest.TestCase):
    def test_status_cli_is_readonly_and_changed_cached_selection_cannot_dispatch(self):
        with tempfile.TemporaryDirectory(prefix="hub-package-status-") as directory:
            area = Path(directory)
            runtime, scratch = area/"runtime", area/"not-created-by-read"
            (runtime/"data").mkdir(parents=True)
            database = runtime/"data/runtime.sqlite"
            original = dict(operationId="status-original", kind="restart", status="reconciling",
                            phase="package-reconciling", outcome="unknown")
            with closing(sqlite3.connect(database)) as db:
                db.execute("CREATE TABLE maintenance_operations(operation_id TEXT PRIMARY KEY,operation_json TEXT)")
                db.execute("INSERT INTO maintenance_operations VALUES(?,?)", (original["operationId"], json.dumps(original)))
                db.commit()
            before = database.read_bytes()
            command = [sys.executable, "-X", "utf8", "-B", str(ROOT/"install_release.py"), "--release", "2.1.0",
                       "--operation-id", original["operationId"], "--runtime-root", str(runtime), "--scratch-root", str(scratch)]
            result = subprocess.run([*command, "--update-status"], capture_output=True, encoding="utf-8", timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            self.assertEqual(json.loads(result.stdout)["outcome"], "unknown")
            self.assertFalse(scratch.exists())
            self.assertEqual(database.read_bytes(), before)
            identity = hashlib.sha256((str(runtime.resolve())+"\0"+original["operationId"]).encode()).hexdigest()[:32]
            cache = scratch/("agenthub-update-"+identity)
            cache.mkdir(parents=True)
            (cache/"update-request.json").write_text(json.dumps(dict(tag="2.0.9", operationId=original["operationId"],
                                                                    runtimeRoot=str(runtime))), encoding="utf-8")
            refused = subprocess.run([*command, "--prepare-update"], capture_output=True, encoding="utf-8", timeout=10)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("Original update selection changed", refused.stderr)
            self.assertEqual(database.read_bytes(), before)

    def test_legacy_public_host_manual_stop_backup_install_and_exact_original_ready(self):
        area = Path(tempfile.mkdtemp(prefix="hub-package-update-", dir=os.environ.get("AGENT_HUB_TEST_TEMP")))
        runtime = area/"installed"
        old_process = None
        completed = False
        env = {k: v for k, v in os.environ.items() if not k.startswith(("AGENT_HUB_", "CODEX_", "CLAUDE_", "ANTHROPIC_", "GIT_"))
               and k not in {"NODE_OPTIONS", "NODE_PATH"}}
        for name, folder in [("TEMP", "temp"), ("TMP", "temp"), ("LOCALAPPDATA", "local"), ("APPDATA", "roaming")]:
            target = area/folder
            target.mkdir(exist_ok=True)
            env[name] = str(target)

        def run(args, timeout=60, child_env=None, input_text=None):
            result = subprocess.run(args, env=child_env or env, input=input_text,
                                    capture_output=True, encoding="utf-8", timeout=timeout)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            return result

        def wait_for(predicate, timeout=45):
            deadline = time.monotonic()+timeout
            while time.monotonic() < deadline:
                result = predicate()
                if result:
                    return result
                time.sleep(.05)
            self.fail("Owned package fixture boundary did not complete; retained at "+str(area))

        try:
            license_file, notices = area/"LICENSE", area/"NOTICES"
            license_file.write_text("Synthetic local acceptance fixture", encoding="utf-8")
            notices.write_text("No provider or public publication proof", encoding="utf-8")
            packages = []
            for index, role, version in [(1, "legacy-update-fixture", "2.0.4"), (2, "replacement-update-fixture", "2.1.0")]:
                prepared_output = run(["node", str(ROOT/"prepare-fixture.mjs"), str(area/f"source-{index}"),
                                       f"update-fixture-{index}", "literal owned app", str(index)*40, version, role,
                                       version+f"+build.{30000000+index}"])
                prepared = Path(json.loads(prepared_output.stdout.splitlines()[-1])["releaseRoot"])
                archive = area/f"artifacts-{index}"/"AgentHub-win32-x64.zip"
                descriptor = build_package(prepared, license_file, notices, str(index)*40, archive)
                packages.append((archive, descriptor))
            old_archive, old_descriptor = packages[0]
            run([sys.executable, "-X", "utf8", "-B", str(ROOT/"install_release.py"), "--archive", str(old_archive),
                 "--sha256", old_descriptor["sha256"], "--runtime-root", str(runtime), "--scratch-root", str(area/"initial-install")])
            config = runtime/"config.json"
            config.write_text('{"provider":"codex","cursor":19,"privateMarker":"owned-fixture","usageSyncServerUrl":""}', encoding="utf-8")
            config_before = config.read_bytes()
            data = runtime/"data"
            data.mkdir(exist_ok=True)
            with closing(sqlite3.connect(data/"journal.sqlite")) as db:
                db.execute("CREATE TABLE receipts(id TEXT PRIMARY KEY,outcome TEXT)")
                db.execute("INSERT INTO receipts VALUES('original-unknown','unknown')")
                db.commit()
            (data/"cursor.keep").write_bytes(b"original cursor 19")
            old_process = subprocess.Popen([str(runtime/"AgentHub.RuntimeHost.exe")], env=env,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           creationflags=subprocess.CREATE_NO_WINDOW)
            wait_for(lambda: (runtime/"legacy-update-fixture-ready.json").exists())
            self.assertIsNone(old_process.poll())
            archive, descriptor = packages[1]
            # Existing metadata verification receives a canonical-shaped exact
            # inventory from controlled transport; no executable is substituted.
            installer = area/"install_release.py"
            shutil.copy2(ROOT/"install_release.py", installer)
            descriptor_path = archive.with_suffix(".zip.json")
            base = "https://github.com/IIITYRAELIII/AgentHub/releases/download/2.1.0/"
            assets = []
            for name, file in [("AgentHub-win32-x64.zip", archive), ("AgentHub-win32-x64.zip.json", descriptor_path),
                               ("install_release.py", installer)]:
                body = file.read_bytes()
                assets.append(dict(name=name, state="uploaded", size=len(body),
                                   digest="sha256:"+hashlib.sha256(body).hexdigest(), browser_download_url=base+name))
            metadata = dict(tag_name="2.1.0", draft=False, prerelease=False, published_at="2026-01-01T00:00:00Z", assets=assets)
            # Invoke the actual source-free recipient CLI/default Node entry.
            # Only their canonical HTTPS responses are replaced, never a
            # controller, installer, process/Job, database or readiness result.
            transport = area/"https-transport.py"
            transport.write_text("import io,json,pathlib,runpy,sys,urllib.request\n"+
                "metadata="+repr(json.dumps(metadata))+"\n"+
                "responses={'https://api.github.com/repos/IIITYRAELIII/AgentHub/releases/tags/2.1.0':metadata.encode(),"+
                repr(base+"AgentHub-win32-x64.zip")+":pathlib.Path("+repr(str(archive))+").read_bytes(),"+
                repr(base+"AgentHub-win32-x64.zip.json")+":pathlib.Path("+repr(str(descriptor_path))+").read_bytes()}\n"+
                "def open_response(self, request, timeout): return io.BytesIO(responses[request.full_url])\n"+
                "urllib.request.OpenerDirector.open=open_response\n"+
                "target=sys.argv.pop(1);sys.argv[0]=target;runpy.run_path(target,run_name='__main__')\n", encoding="utf-8")
            preload = area/"https-metadata.mjs"
            preload.write_text("globalThis.fetch=async(url)=>{if(String(url)!=='https://api.github.com/repos/IIITYRAELIII/AgentHub/releases/tags/2.1.0')throw Error('unexpected fixture URL');return new Response("+
                               json.dumps(json.dumps(metadata))+",{status:200});};\n", encoding="utf-8")
            transport_env = {**env, "NODE_OPTIONS": "--import="+preload.as_uri()}
            command = [sys.executable, "-X", "utf8", "-B", str(transport), str(installer), "--release", "2.1.0",
                       "--prepare-update", "--operation-id", "owned-package-original", "--runtime-root", str(runtime),
                       "--scratch-root", str(area/"cache")]
            admitted = run(command, child_env=transport_env, input_text="\n")
            self.assertIn('"status":"awaiting-user-stop"', admitted.stdout)
            self.assertIn('"oldHostPid":'+str(old_process.pid), admitted.stdout)
            self.assertIsNone(old_process.poll(), "Arming must not terminate the old app")
            self.assertEqual(json.loads((runtime/"current.json").read_text())["current"], "update-fixture-1")
            # Literal app's natural teardown is the test user's manual stop.
            # It is not a callback or a graceful-control port in the old Host.
            (runtime/"legacy-update-fixture-stop").write_bytes(b"stop owned fixture")
            self.assertEqual(old_process.wait(timeout=15), 0)
            wait_for(lambda: (runtime/"replacement-update-fixture-ready.json").exists())
            with closing(sqlite3.connect(data/"runtime.sqlite")) as db:
                row = json.loads(db.execute("SELECT operation_json FROM maintenance_operations WHERE operation_id=?",
                                            ("owned-package-original",)).fetchone()[0])
            self.assertEqual((row["status"], row["outcome"]), ("succeeded", "succeeded"))
            self.assertEqual(row["metadata"]["packageHandoff"]["binding"]["target"]["releaseId"], "update-fixture-2")
            self.assertTrue(row["metadata"]["packageLaunchAdmission"]["hostPid"] > 0)
            backup = Path(row["metadata"]["packageBackup"]["directory"])
            with closing(sqlite3.connect(backup/"data/journal.sqlite")) as db:
                self.assertEqual(db.execute("SELECT outcome FROM receipts WHERE id='original-unknown'").fetchone()[0], "unknown")
            with closing(sqlite3.connect(data/"journal.sqlite")) as db:
                self.assertEqual(db.execute("SELECT outcome FROM receipts WHERE id='original-unknown'").fetchone()[0], "unknown")
            self.assertEqual(config.read_bytes(), config_before)
            self.assertEqual((data/"cursor.keep").read_bytes(), b"original cursor 19")
            self.assertEqual(json.loads((runtime/"current.json").read_text())["current"], "update-fixture-2")
            replay = json.loads(run(command, child_env=transport_env).stdout.splitlines()[-1])
            self.assertEqual((replay["status"], replay["effectsReplayed"]), ("succeeded", False))
            completed = True
        finally:
            # Never kill an unknown/shared process or remove its files. These
            # markers are consumed only by our literal fixture applications.
            if runtime.exists():
                for role in ["legacy-update-fixture", "replacement-update-fixture"]:
                    (runtime/(role+"-stop")).write_bytes(b"owned fixture teardown")
            if old_process is not None and old_process.poll() is None:
                old_process.wait(timeout=15)
            if completed:
                wait_for(lambda: not (runtime/"data/bot.lock").exists(), timeout=15)
                # Native continuation may still be reading its terminal receipt.
                # Joining the root gate via an existing --check is read-only.
                run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
                shutil.rmtree(area)


if __name__ == "__main__":
    unittest.main()
