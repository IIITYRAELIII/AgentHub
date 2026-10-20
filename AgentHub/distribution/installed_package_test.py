from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from build_package import build_package
from install_release import extract_verified

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
            # Materialize the exact future two-file Utilities entry in a fresh
            # recipient directory with no source checkout or .git metadata.
            recipient = root/"recipient-utilities"
            entry = json.loads((ROOT/"utilities-entry.json").read_text(encoding="utf-8"))
            for record in entry["files"]:
                source = ROOT.parents[1]/record["source"]
                target = recipient/record["target"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            self.assertEqual(sorted(p.relative_to(recipient).as_posix() for p in recipient.rglob("*") if p.is_file()),
                             ["AgentHub/README.md", "AgentHub/install.py"])
            bootstrap = recipient/"AgentHub/install.py"

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
                output = run(["node", str(ROOT/"prepare-fixture.mjs"), str(area), f"synthetic-{i}", f"synthetic app {i}", str(i)*40])
                prepared = Path(json.loads(output.stdout.splitlines()[-1])["releaseRoot"])
                archive = root/f"synthetic-{i}.zip"
                manifest = build_package(prepared, license_file, notices, str(i)*40, archive)
                package = root/f"package-{i}"
                extract_verified(archive, manifest["sha256"], package)
                packages.append(package)
                archives.append((archive, manifest["sha256"]))

            def install(index, *, rollback=False, success=True):
                archive, checksum = archives[index]
                return run([sys.executable, "-X", "utf8", "-B", str(bootstrap), "--archive", str(archive),
                            "--sha256", checksum, "--runtime-root", str(runtime), "--scratch-root", str(root/"package-scratch"),
                            *(["--rollback"] if rollback else [])], success=success)

            install(0)
            run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
            pointer_before = (runtime/"current.json").read_bytes()
            install(0)
            self.assertEqual((runtime/"current.json").read_bytes(), pointer_before)
            config = runtime/"config.json"
            config.write_text('{"provider":"codex","privateMarker":"synthetic-user-configuration"}', encoding="utf-8")
            before_config = config.read_bytes()
            data = runtime/"data"
            data.mkdir(exist_ok=True)
            (data/"user-state.keep").write_bytes(b"synthetic unfinished work and receipts")
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
            install(1)
            run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
            pointer = json.loads((runtime/"current.json").read_text())
            self.assertEqual((pointer["current"], pointer["previous"]), ("synthetic-2", "synthetic-1"))
            install(1, rollback=True)
            run([str(runtime/"AgentHub.RuntimeHost.exe"), "--check"])
            pointer = json.loads((runtime/"current.json").read_text())
            self.assertEqual((pointer["current"], pointer["previous"]), ("synthetic-1", "synthetic-2"))
            self.assertEqual(config.read_bytes(), before_config)
            self.assertEqual((data/"user-state.keep").read_bytes(), before_data)
            self.assertEqual((runtime/"releases/synthetic-1/agent-hub-main.mjs").read_text(), 'console.log("synthetic app 1");\n')
            self.assertEqual((runtime/"releases/synthetic-2/agent-hub-main.mjs").read_text(), 'console.log("synthetic app 2");\n')


if __name__ == "__main__":
    unittest.main()
