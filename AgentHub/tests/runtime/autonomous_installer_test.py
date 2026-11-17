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
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "distribution/install_release.py"
spec = importlib.util.spec_from_file_location("installer", SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@unittest.skipUnless(os.name == "nt", "Windows recipient installer")
class AutonomousInstallerTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node process fixture")
    def test_real_node_hub_path_as_data_does_not_grant_stop_authority(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/"selected"; root.mkdir()
            unrelated=Path(temp)/"unrelated-node.mjs"
            unrelated.write_text("console.log('started');setInterval(()=>{},1000)",encoding="utf-8")
            process=subprocess.Popen([shutil.which("node"),str(unrelated),str(root/"agent-hub-main.mjs")],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,creationflags=0x08000000)
            try:
                self.assertEqual(process.stdout.readline().strip(),b"started")
                row=next(r for r in installer.process_snapshot() if int(r["ProcessId"])==process.pid)
                self.assertFalse(installer.selected_process(row,root))
                self.assertEqual(installer.stop_selected(root),[])
                self.assertIsNone(process.poll())
            finally:
                process.kill(); process.wait(); process.stdout.close()

    def test_node_entry_program_position_and_option_values(self):
        node=str(Path(sys.executable).parent/"node.exe"); root=Path(tempfile.gettempdir())/"selected"
        entry=str(root/"agent-hub-main.mjs"); unrelated=str(root.parent/"unrelated-node.mjs")
        for args, expected in [([entry,unrelated],True),([unrelated,entry],False),
            (["--require",entry,unrelated],False),(["--import",unrelated,entry],True),
            (["--no-warnings","--",entry],True),(["--eval",entry],False),
            (["--unknown-value-option",entry,unrelated],False)]:
            row=dict(ExecutablePath=node,CommandLine=subprocess.list2cmdline([node,*args]))
            self.assertEqual(installer.selected_process(row,root),expected,args)

    def test_actual_stop_algorithm_rejects_reused_ppid_and_all_foreign_legacy_entries(self):
        c,w,_=installer.native_api(); root=Path(tempfile.gettempdir())/"selected"
        parent=dict(ProcessId=101,ParentProcessId=0,ExecutablePath=str(root/"AgentHub.RuntimeHost.exe"),CommandLine="host",Created="20000")
        class Kernel:
            def __init__(self,rows): self.rows=rows; self.live={r['ProcessId'] for r in rows}; self.killed=[]
            def OpenProcess(self,access,inherit,pid): return pid
            def CloseHandle(self,h): return True
            def WaitForSingleObject(self,h,timeout): return 258 if h in self.live else 0
            def TerminateProcess(self,h,code): self.live.remove(h); self.killed.append(h); return True
        def run(child):
            kernel=Kernel([parent,child])
            def identity(pid):
                row=next(r for r in kernel.rows if r['ProcessId']==pid)
                return dict(created=row['Created'],image=str(Path(row['ExecutablePath']).resolve()))
            with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_identity',side_effect=identity),patch.object(installer,'process_snapshot',side_effect=lambda:[r for r in kernel.rows if r['ProcessId'] in kernel.live]):
                installer.stop_selected(root)
            return kernel
        child=dict(ProcessId=102,ParentProcessId=101,ExecutablePath=sys.executable,CommandLine="python worker",Created="10000")
        self.assertEqual(run(child).killed,[101])
        self.assertCountEqual(run({**child,'Created':'30000'}).killed,[101,102])
        node=str(Path(sys.executable).parent/'node.exe')
        for name in installer.HUB_NODE_ENTRIES:
            child={**child,'Created':'30000','ExecutablePath':node,'CommandLine':subprocess.list2cmdline([node,str(root.parent/'foreign'/name)])}
            kernel=Kernel([parent,child])
            with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_snapshot',return_value=[parent,child]):
                with self.assertRaisesRegex(RuntimeError,'Another Hub installation'):
                    installer.stop_selected(root)
            self.assertEqual(kernel.killed,[])

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
