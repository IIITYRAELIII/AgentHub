from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from install_release import extract_verified, file_hash

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(os.name == "nt", "Windows native RuntimeHost packaging contract")
class InstalledPackageTests(unittest.TestCase):
    def test_real_preparation_native_host_install_update_rollback_and_running_refusal(self):
        with tempfile.TemporaryDirectory(prefix="hub-installed-package-", dir=os.environ.get("AGENT_HUB_TEST_TEMP")) as temporary:
            root = Path(temporary)
            runtime = root/"local"/"AgentHub"
            env = {k: v for k, v in os.environ.items() if not k.startswith(("AGENT_HUB_", "CODEX_", "CLAUDE_", "ANTHROPIC_", "GIT_"))
                   and k not in {"NODE_OPTIONS", "NODE_PATH"}}
            for name, child in [("TEMP", "temp"), ("TMP", "temp"), ("LOCALAPPDATA", "local"),
                                ("APPDATA", "roaming"), ("USERPROFILE", "home")]:
                directory = root/child
                directory.mkdir(exist_ok=True)
                env[name] = str(directory)
            license_file = root/"LICENSE"
            notices = root/"NOTICES"
            license_file.write_text("Synthetic fixture license, not a public distribution grant")
            notices.write_text("Synthetic fixture; actual runtime owner and native host copied for isolated testing")
            # The standalone installer runs without a Utilities source checkout.
            # Link-only Utilities carries no executable or copied release assets.
            recipient = root/"recipient-standalone"
            recipient.mkdir()
            entry = json.loads((ROOT/"utilities-entry.json").read_text(encoding="utf-8"))
            self.assertEqual(entry["files"], [])
            bootstrap = recipient/"install_release.py"
            shutil.copy2(ROOT/"install_release.py", bootstrap)
            self.assertEqual(sorted(p.relative_to(recipient).as_posix() for p in recipient.rglob("*") if p.is_file()),
                             ["install_release.py"])
            legacy_utilities = root/"legacy-utilities"
            legacy_source = legacy_utilities/"AgentHub"
            legacy_source.mkdir(parents=True)
            (legacy_source/"install.py").write_text("raise RuntimeError('legacy source installer must not execute')\n", encoding="utf-8")
            profile = legacy_utilities/".team/fixture.json"
            profile.parent.mkdir()
            profile.write_text(json.dumps({"decisions": {"app:agent-hub": {"status": "accepted"},
                                                         "android-app:agent-hub": {"status": "declined"}}}), encoding="utf-8")
            prior_profile = profile.read_bytes()

            def run(args, *, success=True):
                result = subprocess.run(args, env=env, capture_output=True, encoding="utf-8", errors="replace", timeout=90)
                if success:
                    self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
                return result

            packages, archives = [], []
            for i in (1, 2):
                area = root/f"prepare-{i}"
                output = run(["node", str(ROOT/"prepare-fixture.mjs"), str(area), f"synthetic-{i}", f"synthetic app {i}", str(i)*40,
                              "2026.10.19" if i == 1 else "2.0.0"])
                prepared = Path(json.loads(output.stdout.splitlines()[-1])["releaseRoot"])
                native_manifest = json.loads((prepared/"runtime-manifest.json").read_text(encoding="utf-8"))
                receipt = root/f"owner-prepared-{i}.json"
                receipt.write_text(json.dumps({"schema": 1, "phase": "PREPARED", "operationId": f"fixture-{i}",
                    "generation": i, "sourceCommit": str(i)*40, "releaseId": f"synthetic-{i}",
                    "version": native_manifest["releaseVersion"], "releaseRoot": str(prepared),
                    "manifestSha256": file_hash(prepared/"runtime-manifest.json")}), encoding="utf-8")
                checkpoint = root/f"package-checkpoint-{i}"
                build = [sys.executable, "-X", "utf8", "-B", str(ROOT/"build_release.py"),
                         "--prepared-receipt", str(receipt), "--receipt-sha256", file_hash(receipt),
                         "--source-commit", str(i)*40, "--version", native_manifest["releaseVersion"],
                         "--license", str(license_file), "--notices", str(notices), "--output-root", str(checkpoint)]
                first = json.loads(run(build).stdout)
                namespace = checkpoint/native_manifest["releaseVersion"]
                before = {str(p.relative_to(namespace)): (p.read_bytes(), p.stat().st_mtime_ns)
                          for p in namespace.rglob("*") if p.is_file()}
                self.assertEqual(json.loads(run(build).stdout), first)
                self.assertEqual({str(p.relative_to(namespace)): (p.read_bytes(), p.stat().st_mtime_ns)
                                  for p in namespace.rglob("*") if p.is_file()}, before)
                self.assertEqual((namespace/"assets/install_release.py").read_bytes(), bootstrap.read_bytes())
                archive = namespace/"assets/AgentHub-win32-x64.zip"
                manifest = json.loads(archive.with_suffix(".zip.json").read_text(encoding="utf-8"))
                package = root/f"package-{i}"
                extract_verified(archive, manifest["sha256"], package)
                packages.append(package)
                archives.append((archive, manifest["sha256"]))

            def install(index, *, rollback=False, success=True, release=False, checksum_override=None):
                archive, checksum = archives[index]
                checksum = checksum_override or checksum
                command = [str(bootstrap), "--archive", str(archive), "--sha256", checksum]
                if release:
                    # Only HTTPS transport is synthetic. The standalone CLI,
                    # ZIP verification, Node entry and native installation owner
                    # run unchanged in a source-free recipient directory.
                    harness = root/"release-transport.py"
                    harness.write_text(
                        "import hashlib, io, json, pathlib, runpy, sys, urllib.request\n"
                        "archive=pathlib.Path("+repr(str(archive))+"); data=archive.read_bytes()\n"
                        "descriptor=json.loads(archive.with_suffix('.zip.json').read_text()); descriptor['asset']='AgentHub-win32-x64.zip'\n"
                        "raw=json.dumps(descriptor).encode(); base='https://github.com/IIITYRAELIII/AgentHub/releases/download/v1/'\n"
                        "def asset(name, body): return dict(name=name, browser_download_url=base+name, size=len(body), state='uploaded', digest='sha256:'+hashlib.sha256(body).hexdigest())\n"
                        "metadata=dict(tag_name='v1',draft=False,prerelease=False,published_at='2026-01-01T00:00:00Z',assets=[asset('AgentHub-win32-x64.zip',data),asset('AgentHub-win32-x64.zip.json',raw)])\n"
                        "responses={'https://api.github.com/repos/IIITYRAELIII/AgentHub/releases/latest':json.dumps(metadata).encode(),base+'AgentHub-win32-x64.zip.json':raw,base+'AgentHub-win32-x64.zip':data}\n"
                        "def open_response(self, request, timeout): return io.BytesIO(responses[request.full_url])\n"
                        "urllib.request.OpenerDirector.open=open_response\n"
                        "target=sys.argv.pop(1); sys.argv[0]=target; runpy.run_path(target,run_name='__main__')\n", encoding="utf-8")
                    command = [str(harness), str(bootstrap), "--release", "latest", "--sha256", checksum]
                return run([sys.executable, "-X", "utf8", "-B", *command,
                            "--runtime-root", str(runtime), "--scratch-root", str(root/"package-scratch"),
                            *(["--rollback"] if rollback else [])], success=success)

            install(0, release=True)
            self.assertEqual(json.loads((runtime/"config.json").read_text())["usageSyncServerUrl"], "")
            run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
            pointer_before = (runtime/"current.json").read_bytes()
            wrong_pin = install(0, release=True, success=False, checksum_override="0"*64)
            self.assertIn("additional SHA-256 pin", wrong_pin.stderr)
            self.assertEqual((runtime/"current.json").read_bytes(), pointer_before)
            install(0)
            self.assertEqual((runtime/"current.json").read_bytes(), pointer_before)
            # Delete only this fixture's synthetic source folder. Neither the
            # installed runtime nor participant choices belong to that folder.
            shutil.rmtree(legacy_source)
            self.assertFalse(legacy_source.exists())
            self.assertEqual((runtime/"current.json").read_bytes(), pointer_before)
            self.assertEqual(profile.read_bytes(), prior_profile)
            config = runtime/"config.json"
            config.write_text(json.dumps({"provider": "codex", "privateMarker": "synthetic-user-configuration",
                                         "usageSyncServerUrl": "https://sync.example.invalid",
                                         "components": {"sharedDashboardBot": True}}), encoding="utf-8")
            before_config = config.read_bytes()
            data = runtime/"data"
            data.mkdir(exist_ok=True)
            (data/"user-state.keep").write_bytes(b"synthetic unfinished work and receipts")
            (data/"sync-cursors.keep").write_bytes(b"synthetic existing sync cursors")
            sync_remote = b'{"serverUrl":"https://sync.example.invalid","deviceId":"synthetic-device","token":"synthetic-token"}'
            (data/"usage-sync-remote.json").write_bytes(sync_remote)
            before_data = (data/"user-state.keep").read_bytes()
            # Exact live process evidence must refuse before pointer/launcher changes.
            (data/"bot.lock").write_text(json.dumps({"pid": os.getpid(), "ready": True, "releaseId": "synthetic-1"}))
            refused = install(1, success=False)
            self.assertIn("Runtime is running", refused.stderr)
            self.assertEqual((runtime/"current.json").read_bytes(), pointer_before)
            (data/"bot.lock").unlink()
            self.assertFalse((runtime/"releases/synthetic-2").exists())
            # Inject a failure at the existing owner's real pointer boundary,
            # after stable-file preparation; no production fault flag is added.
            before_launcher = (runtime/"AgentHub.RuntimeHost.exe").read_bytes()
            target = runtime/"releases/synthetic-2"
            shutil.copytree(packages[1]/"runtime", target)
            cutpoint = root/"pointer-cutpoint.mjs"
            cutpoint.write_text(
                "import { installPreparedRuntime } from "+json.dumps((packages[1]/"runtime/src/runtime/runtime-manager.mjs").as_uri())+";\n"
                "let refused = false;\n"
                "try { await installPreparedRuntime({ runtimeRoot: "+json.dumps(str(runtime))+", releaseId: 'synthetic-2', "
                "beforePointerCommit() { throw new Error('synthetic-pointer-cutpoint'); } }); } "
                "catch (error) { if (!error.message.includes('synthetic-pointer-cutpoint')) throw error; refused = true; }\n"
                "if (!refused) throw new Error('missing expected cutpoint refusal');\n", encoding="utf-8")
            run(["node", str(cutpoint)])
            self.assertEqual((runtime/"current.json").read_bytes(), pointer_before)
            self.assertEqual((runtime/"AgentHub.RuntimeHost.exe").read_bytes(), before_launcher)
            self.assertEqual(config.read_bytes(), before_config)
            self.assertEqual((data/"user-state.keep").read_bytes(), before_data)
            self.assertEqual((data/"sync-cursors.keep").read_bytes(), b"synthetic existing sync cursors")
            self.assertEqual((data/"usage-sync-remote.json").read_bytes(), sync_remote)
            self.assertEqual(profile.read_bytes(), prior_profile)
            self.assertFalse(legacy_source.exists())
            install(1)
            run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
            pointer = json.loads((runtime/"current.json").read_text())
            self.assertEqual((pointer["current"], pointer["previous"]), ("synthetic-2", "synthetic-1"))
            semantic_pointer = (runtime/"current.json").read_bytes()
            downgrade = install(0, success=False)
            self.assertIn("downgrade", downgrade.stderr)
            self.assertEqual((runtime/"current.json").read_bytes(), semantic_pointer)
            install(1, rollback=True)
            run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
            pointer = json.loads((runtime/"current.json").read_text())
            self.assertEqual((pointer["current"], pointer["previous"]), ("synthetic-1", "synthetic-2"))
            self.assertEqual(config.read_bytes(), before_config)
            self.assertEqual((data/"user-state.keep").read_bytes(), before_data)
            self.assertEqual((runtime/"releases/synthetic-1/agent-hub-main.mjs").read_text(), 'console.log("synthetic app 1");\n')
            self.assertEqual((runtime/"releases/synthetic-2/agent-hub-main.mjs").read_text(), 'console.log("synthetic app 2");\n')
            self.assertEqual((data/"sync-cursors.keep").read_bytes(), b"synthetic existing sync cursors")
            self.assertEqual((data/"usage-sync-remote.json").read_bytes(), sync_remote)

            self.assertEqual(profile.read_bytes(), prior_profile)
            self.assertFalse(legacy_source.exists())


if __name__ == "__main__":
    unittest.main()
