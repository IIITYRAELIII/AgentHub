"""Recipient installer checks. Run: python -m unittest discover -s tests/runtime -p autonomous_installer_test.py"""
import importlib.util
import hashlib
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


def foreign_layout(root, entries):
    root.mkdir(parents=True,exist_ok=True); (root/'data').mkdir(exist_ok=True)
    release=root/'releases/fixture'; release.mkdir(parents=True,exist_ok=True)
    (root/'AgentHub.RuntimeHost.exe').write_bytes(b'isolated native identity fixture')
    files=[dict(path='AgentHub.RuntimeHost.exe',sha256=installer.file_hash(root/'AgentHub.RuntimeHost.exe'))]
    for entry in entries:
        files.append(dict(path=entry.name,sha256=installer.file_hash(entry)))
    (root/'current.json').write_text(json.dumps(dict(current='fixture')))
    (release/'runtime-manifest.json').write_text(json.dumps(dict(releaseId='fixture',files=files)))


@unittest.skipUnless(os.name == "nt", "Windows recipient installer")
class AutonomousInstallerTests(unittest.TestCase):
    def test_real_job_close_signals_original_handles_and_live_access_denied_refuses(self):
        c,w,k=installer.native_api()
        k.CreateJobObjectW.argtypes=[c.c_void_p,w.LPCWSTR]; k.CreateJobObjectW.restype=w.HANDLE
        k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
        k.SetInformationJobObject.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD]
        class Basic(c.Structure):
            _fields_=[('processTime',c.c_longlong),('jobTime',c.c_longlong),('flags',w.DWORD),
                ('minimum',c.c_size_t),('maximum',c.c_size_t),('active',w.DWORD),('affinity',c.c_size_t),
                ('priority',w.DWORD),('scheduling',w.DWORD)]
        class Limits(c.Structure):
            _fields_=[('basic',Basic),('io',c.c_ulonglong*6),('processMemory',c.c_size_t),
                ('jobMemory',c.c_size_t),('peakProcess',c.c_size_t),('peakJob',c.c_size_t)]
        job=k.CreateJobObjectW(None,None); limits=Limits(); limits.basic.flags=0x2000
        self.assertTrue(job)
        self.assertTrue(k.SetInformationJobObject(job,9,c.byref(limits),c.sizeof(limits)))
        children=[]; identities=[]
        try:
            for _ in range(2):
                process=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],creationflags=0x08000000)
                children.append(process)
                self.assertTrue(k.AssignProcessToJobObject(job,int(process._handle)))
                identities.append(installer.process_identity(int(process._handle)))
            k.CloseHandle(job); job=None
            for process,identity in zip(children,identities):
                self.assertEqual(k.WaitForSingleObject(int(process._handle),10000),0)
                self.assertFalse(k.TerminateProcess(int(process._handle),1))
                self.assertEqual(c.get_last_error(),5)
                result=installer.terminate_retained(process.pid,int(process._handle),identity)
                self.assertTrue(result['alreadyExited'])
                process.wait(timeout=10)
        finally:
            if job: k.CloseHandle(job)
            for process in children:
                if process.poll() is None: process.kill(); process.wait()
        live=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],creationflags=0x08000000)
        handle=k.OpenProcess(0x1000|0x100000,False,live.pid)
        try:
            self.assertTrue(handle)
            with self.assertRaises(PermissionError) as refused:
                installer.terminate_retained(live.pid,handle,installer.process_identity(handle))
            self.assertEqual(refused.exception.winerror,5)
            self.assertIsNone(live.poll())
        finally:
            k.CloseHandle(handle); live.kill(); live.wait()

    def test_batch_capture_137_descendants_and_budget_before_first_kill(self):
        c,w,_=installer.native_api(); root=Path(tempfile.gettempdir())/'selected-batch'
        parent=dict(ProcessId=101,ParentProcessId=0,ExecutablePath=str(root/'AgentHub.RuntimeHost.exe'),Created='20000',CommandLine='host')
        rows=[parent]+[dict(ProcessId=pid,ParentProcessId=101,ExecutablePath=sys.executable,
                Created=str(30000+pid),CommandLine='python worker') for pid in range(102,239)]
        class Kernel:
            def __init__(self): self.live={r['ProcessId'] for r in rows}; self.killed=[]
            def OpenProcess(self,a,b,pid): return pid
            def CloseHandle(self,h): return True
            def WaitForSingleObject(self,h,t): return 258 if h in self.live else 0
            def TerminateProcess(self,h,code): self.live.remove(h); self.killed.append(h); return True
        def identity(pid):
            row=next(r for r in rows if r['ProcessId']==pid)
            return dict(created=row['Created'],image=str(Path(row['ExecutablePath']).resolve()))
        kernel=Kernel(); calls=[]; clock=[0.0]; timings=[]
        def snapshot():
            calls.append(True)
            return [r for r in rows if r['ProcessId'] in kernel.live]
        with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_identity',side_effect=identity),patch.object(installer,'process_snapshot',side_effect=snapshot):
            result=installer.stop_selected(root,trace=timings.append)
        self.assertEqual(len(result),138); self.assertEqual(len(calls),3)
        self.assertEqual(timings[-1]['snapshotCalls'],3)
        kernel=Kernel(); calls=[]
        def slow_snapshot():
            calls.append(True)
            if len(calls)==2: clock[0]=46.0
            return rows
        with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_identity',side_effect=identity),patch.object(installer,'process_snapshot',side_effect=slow_snapshot),patch.object(installer.time,'monotonic',side_effect=lambda:clock[0]):
            with self.assertRaisesRegex(RuntimeError,'did not converge'):
                installer.stop_selected(root,trace=timings.append)
        self.assertEqual(kernel.killed,[])
        self.assertEqual(timings[-1]['outcome'],'failed')

    def test_partial_stop_resume_rejects_different_original_before_io(self):
        root=Path(tempfile.gettempdir())/'selected'
        original=dict(kind='restart',streamId='agent-hub-installer',threadId=str(root),status='reconciling',
            phase='installer-stopping',outcome='unknown',revision=3,metadata={})
        for delta in [dict(revision=4),dict(status='succeeded'),dict(kind='context-compaction'),
                dict(phase='installer-backed-up'),dict(threadId=str(root.parent/'foreign'))]:
            with self.assertRaises(RuntimeError):
                installer.verify_partial_stop_resume(root,root/'missing',{**original,**delta})

    def test_pre_stop_resume_rejects_other_scope_and_later_effects_before_io(self):
        root=Path(tempfile.gettempdir())/'selected'
        original=dict(kind='restart',streamId='agent-hub-installer',threadId=str(root),status='reconciling',
            phase='installer-recovery-required',outcome='unknown',revision=2,metadata={})
        for patch_fields in [dict(kind='context-compaction'),dict(threadId=str(root.parent/'other')),
                             dict(revision=3),dict(phase='installer-backed-up'),dict(status='succeeded'),
                             dict(metadata={'autonomousBackup':{}})]:
            with self.assertRaises(RuntimeError):
                installer.verify_pre_stop_resume(root,root/'absent-retained',{**original,**patch_fields})

    @unittest.skipUnless(shutil.which("node"), "Node process fixture")
    def test_real_node_hub_path_as_data_does_not_grant_stop_authority(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/"selected"; root.mkdir()
            unrelated=Path(temp)/"unrelated-node.mjs"
            unrelated.write_text("console.log('started');setInterval(()=>{},1000)",encoding="utf-8")
            (root/"agent-hub-main.mjs").write_text("throw Error('must not execute')",encoding="utf-8")
            for program in [[str(unrelated)], ["--eval=console.log('started');setInterval(()=>{},1000)"]]:
                process=subprocess.Popen([shutil.which("node"),*program,str(root/"agent-hub-main.mjs")],
                    stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,creationflags=0x08000000)
                try:
                    self.assertEqual(process.stdout.readline().strip(),b"started")
                    row=next(r for r in installer.process_snapshot() if int(r["ProcessId"])==process.pid)
                    self.assertFalse(installer.selected_process(row,root))
                    self.assertEqual(installer.stop_selected(root),[])
                    self.assertIsNone(process.poll())
                finally:
                    process.kill(); process.wait(); process.stdout.close()

    @unittest.skipUnless(shutil.which("node"), "Node process fixture")
    def test_real_import_equals_preserves_actual_script_ownership(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); entry=root/"agent-hub-main.mjs"; preload=root/"preload.mjs"
            preload.write_text("export{}",encoding="utf-8")
            entry.write_text("console.log('actual entry');setInterval(()=>{},1000)",encoding="utf-8")
            process=subprocess.Popen([shutil.which("node"),"--import="+preload.as_uri(),str(entry)],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,creationflags=0x08000000)
            try:
                self.assertEqual(process.stdout.readline().strip(),b"actual entry")
                row=next(r for r in installer.process_snapshot() if int(r["ProcessId"])==process.pid)
                self.assertTrue(installer.selected_process(row,root))
                installer.stop_selected(root); process.wait(timeout=10)
            finally:
                if process.poll() is None: process.kill(); process.wait()
                process.stdout.close()

    def test_node_entry_program_position_and_option_values(self):
        node=str(Path(sys.executable).parent/"node.exe"); root=Path(tempfile.gettempdir())/"selected"
        entry=str(root/"agent-hub-main.mjs"); unrelated=str(root.parent/"unrelated-node.mjs")
        for args, expected in [([entry,unrelated],True),([unrelated,entry],False),
            (["--require",entry,unrelated],False),(["--import",unrelated,entry],True),
            (["--no-warnings","--",entry],True),(["--eval",entry],False),
            (["--eval=code",entry],False),(["--print=code",entry],False),
            (["--check=code",entry],False),(["--run=task",entry],False),(["--test=filter",entry],False),
            (["--import="+unrelated,entry],True),
            (["--require="+unrelated,entry],True),
            (["--unknown-mode=value",entry],False),(["--prof-process=logfile",entry],False),
            (["--unknown-value-option",entry,unrelated],False)]:
            row=dict(ExecutablePath=node,CommandLine=subprocess.list2cmdline([node,*args]))
            self.assertEqual(installer.selected_process(row,root),expected,args)

    def test_actual_stop_algorithm_rejects_reused_ppid_and_all_foreign_legacy_entries(self):
        c,w,_=installer.native_api(); temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root=Path(temp.name)/"selected"; foreign=Path(temp.name)/'foreign'; foreign.mkdir()
        entries=[]
        for name in installer.HUB_NODE_ENTRIES:
            f=foreign/name; f.write_text('setInterval(()=>{},1000)'); entries.append(f)
        foreign_layout(foreign,entries)
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
            foreign_layout(foreign,[other])
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

    @unittest.skipUnless(shutil.which('node'), 'Node process fixture')
    def test_owned_mcp_server_child_is_retired_without_foreign_installation_markers(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'selected'; root.mkdir()
            mcp=base/'codex-security/mcp/server.mjs'; mcp.parent.mkdir(parents=True)
            mcp.write_text('setInterval(()=>{},1000)')
            entry=root/'agent-hub-main.mjs'
            entry.write_text("import {spawn} from 'node:child_process';let p=spawn(process.execPath,[process.argv[2],'--stdio'],{windowsHide:true,stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000)")
            parent=subprocess.Popen([shutil.which('node'),str(entry),str(mcp)],stdout=subprocess.PIPE,stdin=subprocess.DEVNULL,creationflags=0x08000000)
            c,w,k=installer.native_api(); child=None
            try:
                pid=int(parent.stdout.readline()); child=k.OpenProcess(0x1000|0x100000|1,False,pid)
                row=next(x for x in installer.process_snapshot() if x['ProcessId']==pid)
                self.assertFalse(installer.foreign_hub_installation(row,root))
                records=installer.stop_selected(root); parent.wait(timeout=10)
                self.assertIn(pid,[x['pid'] for x in records]); self.assertEqual(k.WaitForSingleObject(child,10000),0)
            finally:
                if child:
                    if k.WaitForSingleObject(child,0)==258: k.TerminateProcess(child,1); k.WaitForSingleObject(child,10000)
                    k.CloseHandle(child)
                if parent.poll() is None: parent.kill(); parent.wait()
                parent.stdout.close()

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
