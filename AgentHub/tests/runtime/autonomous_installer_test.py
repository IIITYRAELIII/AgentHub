"""Recipient installer checks. Run: python -m unittest discover -s tests/runtime -p autonomous_installer_test.py"""
import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "distribution/install_release.py"
spec = importlib.util.spec_from_file_location("installer", SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@unittest.skipUnless(os.name == "nt", "Windows recipient installer")
class AutonomousInstallerTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node process fixture")
    def test_real_foreign_peer_survives_and_nested_installation_refuses_before_stop(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/"selected"; foreign=base/"foreign"
            root.mkdir(); foreign.mkdir()
            entry=root/"agent-hub-main.mjs"; other=foreign/"agent-hub-main.mjs"
            other.write_text("setInterval(()=>{},1000)",encoding="utf-8")
            entry.write_text("import {spawn} from 'node:child_process'; const p=process.argv[2]?spawn(process.execPath,[process.argv[2]],{windowsHide:true,stdio:'ignore'}):null; console.log(JSON.stringify({child:p?.pid})); setInterval(()=>{},1000);",encoding="utf-8")
            peer=subprocess.Popen([shutil.which("node"),str(other)],stdin=subprocess.DEVNULL,creationflags=0x08000000)
            selected=subprocess.Popen([shutil.which("node"),str(entry)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,creationflags=0x08000000)
            try:
                json.loads(selected.stdout.readline())
                installer.stop_selected(root)
                selected.wait(timeout=10)
                self.assertIsNone(peer.poll())
            finally:
                if selected.poll() is None: selected.kill(); selected.wait()
                selected.stdout.close(); peer.kill(); peer.wait()
            nested=subprocess.Popen([shutil.which("node"),str(entry),str(other)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,creationflags=0x08000000)
            child=None
            try:
                pid=json.loads(nested.stdout.readline())["child"]
                c,w,k=installer.native_api(); child=k.OpenProcess(0x1000|0x100000|1,False,pid)
                self.assertTrue(child)
                with self.assertRaisesRegex(RuntimeError,"Another Hub installation"):
                    installer.stop_selected(root)
                self.assertIsNone(nested.poll()); self.assertEqual(k.WaitForSingleObject(child,0),258)
            finally:
                if child:
                    k.TerminateProcess(child,1); k.WaitForSingleObject(child,10000); k.CloseHandle(child)
                if nested.poll() is None: nested.kill(); nested.wait()
                nested.stdout.close()

    def test_missing_legacy_database_and_table_are_read_only_absence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "data").mkdir()
            self.assertIsNone(installer.read_update_original(root, "original"))
            self.assertFalse((root / "data/runtime.sqlite").exists())
            with closing(sqlite3.connect(root / "data/runtime.sqlite")) as db:
                db.execute("CREATE TABLE historical(value TEXT)")
                db.commit()
            self.assertIsNone(installer.read_update_original(root, "original"))
            with closing(sqlite3.connect(root / "data/runtime.sqlite")) as db:
                self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [("historical",)])

    def test_selected_installation_and_foreign_node_have_distinct_ownership(self):
        root = Path(tempfile.gettempdir()) / "installer-selected"
        row = {"ExecutablePath": sys.executable, "CommandLine": "python anything"}
        self.assertFalse(installer.selected_process(row, root))
        node = str(Path(sys.executable).parent / "node.exe")
        for script, expected in [(root / "agent-hub-main.mjs", True),
                                 (root / "releases/old/agent-hub-main.mjs", True),
                                 (root / "data/task-worktrees/source/agent-hub-main.mjs", False),
                                 (root.parent / "foreign/agent-hub-main.mjs", False)]:
            self.assertEqual(installer.selected_process({"ExecutablePath": node,
                "CommandLine": subprocess.list2cmdline([node, str(script)])}, root), expected)

    def test_worker_is_outside_all_jobs_without_inheriting_hub_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "native.json"
            code = "import pathlib,json,os; pathlib.Path(" + repr(str(output)) + ").write_text(json.dumps({'pid':os.getpid(),'hub':[k for k in os.environ if k.startswith('AGENT_HUB_')]}))"
            proof = installer.independent_worker([sys.executable, "-c", code], Path(temp), installer.clean_installer_environment())
            c, w, k = installer.native_api()
            handle = k.OpenProcess(0x1000 | 0x100000, False, proof["pid"])
            if handle:
                try:
                    self.assertTrue(installer.outside_jobs(handle))
                    self.assertEqual(k.WaitForSingleObject(handle, 10000), 0)
                finally: k.CloseHandle(handle)
            self.assertEqual(json.loads(output.read_text())["hub"], [])
            self.assertTrue(proof["outsideAllJobs"])


if __name__ == "__main__":
    unittest.main()
