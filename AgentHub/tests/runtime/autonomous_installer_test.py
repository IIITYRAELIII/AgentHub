"""Recipient installer checks. Run: python -m unittest discover -s tests/runtime -p autonomous_installer_test.py"""
import importlib.util
import hashlib
from contextlib import closing, ExitStack
from copy import deepcopy
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
            # The handle is live at admission, but closing the real Job between
            # identity read and TerminateProcess signals it before termination.
            original_identity=installer.process_identity
            def raced_identity(handle):
                nonlocal job
                identity=original_identity(handle)
                k.CloseHandle(job); job=None
                self.assertEqual(k.WaitForSingleObject(handle,10000),0)
                return identity
            with patch.object(installer,'process_identity',side_effect=raced_identity):
                result=installer.terminate_retained(children[0].pid,int(children[0]._handle),identities[0])
            self.assertTrue(result['alreadyExited'])
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
        with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_identity',side_effect=identity),patch.object(installer,'process_birth',side_effect=lambda pid:identity(pid)['created']),patch.object(installer,'process_parent',side_effect=lambda pid:next(r['ParentProcessId'] for r in rows if r['ProcessId']==pid)),patch.object(installer,'process_snapshot',side_effect=snapshot):
            result=installer.stop_selected(root,trace=timings.append)
        self.assertEqual(len(result),138); self.assertEqual(len(calls),3)
        self.assertEqual(timings[-1]['snapshotCalls'],3)
        kernel=Kernel(); calls=[]
        def slow_snapshot():
            calls.append(True)
            if len(calls)==2: clock[0]=46.0
            return rows
        with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_identity',side_effect=identity),patch.object(installer,'process_birth',side_effect=lambda pid:identity(pid)['created']),patch.object(installer,'process_parent',return_value=101),patch.object(installer,'process_snapshot',side_effect=slow_snapshot),patch.object(installer.time,'monotonic',side_effect=lambda:clock[0]):
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
            with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_identity',side_effect=identity),patch.object(installer,'process_birth',side_effect=lambda pid:identity(pid)['created']),patch.object(installer,'process_parent',side_effect=lambda pid:next(r['ParentProcessId'] for r in kernel.rows if r['ProcessId']==pid)),patch.object(installer,'process_snapshot',side_effect=lambda:[r for r in kernel.rows if r['ProcessId'] in kernel.live]):
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

    def test_disappeared_uncaptured_child_does_not_require_absent_parent(self):
        c,w,_=installer.native_api(); root=Path(tempfile.gettempdir())/'selected-exited'
        rows=[dict(ProcessId=pid,ParentProcessId=parent,Created=str(pid*1000),
                   ExecutablePath=str(root/'AgentHub.RuntimeHost.exe') if pid==101 else sys.executable,
                   CommandLine='fixture') for pid,parent in [(101,0),(102,101),(103,102)]]
        class Kernel:
            def __init__(self): self.live={101}; self.killed=[]
            def OpenProcess(self,a,b,pid):
                if pid in self.live: return pid
                c.set_last_error(87); return 0
            def CloseHandle(self,h): return True
            def WaitForSingleObject(self,h,t): return 258 if h in self.live else 0
            def TerminateProcess(self,h,code): self.live.remove(h); self.killed.append(h); return True
        kernel=Kernel(); snapshots=iter([rows,[rows[0]],[]])
        identity=dict(created=rows[0]['Created'],image=str((root/'AgentHub.RuntimeHost.exe').resolve()))
        with patch.object(installer,'native_api',return_value=(c,w,kernel)),patch.object(installer,'process_birth',return_value=identity['created']),patch.object(installer,'process_identity',return_value=identity),patch.object(installer,'process_snapshot',side_effect=lambda:next(snapshots)):
            result=installer.stop_selected(root)
        self.assertEqual([r['pid'] for r in result],[101]); self.assertEqual(kernel.killed,[101])

    def test_native_denial_requires_same_handle_signal_after_parent_retirement(self):
        c,w,_=installer.native_api(); root=Path(tempfile.gettempdir())/'selected-rundown'
        rows=[dict(ProcessId=pid,ParentProcessId=parent,Created=str(pid*1000),
                   ExecutablePath=str(root/'AgentHub.RuntimeHost.exe') if pid==101 else sys.executable,
                   CommandLine='fixture') for pid,parent in [(101,0),(102,101)]]
        class Kernel:
            def __init__(self,join): self.live={101,102}; self.join=join
            def OpenProcess(self,a,b,pid): return pid
            def CloseHandle(self,h): return True
            def WaitForSingleObject(self,h,t): return 258 if h in self.live else 0
            def TerminateProcess(self,h,code):
                if h==102: c.set_last_error(5); return False
                self.live.remove(h)
                if self.join: self.live.discard(102)
                return True
        for join in [True,False]:
            kernel=Kernel(join); traces=[]
            def identity(pid):
                row=next(r for r in rows if r['ProcessId']==pid)
                return dict(created=row['Created'],image=str(Path(row['ExecutablePath']).resolve()))
            with ExitStack() as stack:
                stack.enter_context(patch.object(installer,'native_api',return_value=(c,w,kernel)))
                stack.enter_context(patch.object(installer,'process_birth',side_effect=lambda pid:identity(pid)['created']))
                stack.enter_context(patch.object(installer,'process_parent',return_value=101))
                stack.enter_context(patch.object(installer,'process_identity',side_effect=identity))
                stack.enter_context(patch.object(installer,'process_snapshot',side_effect=lambda:[r for r in rows if r['ProcessId'] in kernel.live]))
                if join:
                    result=installer.stop_selected(root,trace=traces.append)
                    self.assertTrue(next(r for r in result if r['pid']==102)['alreadyExited'])
                else:
                    with self.assertRaises(PermissionError): installer.stop_selected(root,trace=traces.append)
                    self.assertIn(102,kernel.live)
            self.assertTrue(any(r.get('nativeOperation')=='TerminateProcess' and r['winerror']==5 for r in traces))

    def test_configured_tcp_listener_must_belong_to_verified_node(self):
        child=subprocess.Popen([sys.executable,'-u','-c',
            "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(60)"],
            stdout=subprocess.PIPE,creationflags=0x08000000)
        try:
            port=int(child.stdout.readline())
            installer.assert_listener_owner(child.pid,'127.0.0.1',port)
            with self.assertRaisesRegex(RuntimeError,'not owned'):
                installer.assert_listener_owner(os.getpid(),'127.0.0.1',port)
        finally:
            child.kill(); child.wait(); child.stdout.close()

    def test_partial_retry_preserves_whole_original_and_refuses_changed_boundaries(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'hub'; root.mkdir(); prior=Path(temp)/'prior'; prior.mkdir()
            retained=prior/('resume-partial-'+installer.PARTIAL_RETRY_INSTALLER_SHA[:16]); retained.mkdir()
            archive=Path(temp)/'package.zip'; archive.write_bytes(b'package')
            (prior/'request.json').write_text('{}'); (retained/'install_release.py').write_bytes(b'pinned historical installer')
            binding=dict(archiveSha256=installer.file_hash(archive),previous=dict(releaseId='previous'))
            old=dict(revision=3,metadata=dict(autonomousInstaller=binding,autonomousResume=dict(history='unchanged')))
            proof=dict(priorCache=str(prior),priorRequestSha256=installer.file_hash(prior/'request.json'),
                       expectedOriginal=old,installerSha256=installer.PARTIAL_RETRY_INSTALLER_SHA)
            request=dict(installerSha256=installer.PARTIAL_RETRY_INSTALLER_SHA,operationId='same-original',
                         runtimeRoot=str(root),runtimeIdentity=installer._directory_identity(root),
                         resumePartial=dict(cache=str(prior),original=old),sha256=binding['archiveSha256'],archive=str(archive))
            error=dict(code='RuntimeError',diagnostic='Selected descendant parent identity changed')
            original=dict(kind='restart',streamId='agent-hub-installer',threadId=str(root),status='reconciling',
                          phase='installer-recovery-required',outcome='unknown',revision=5,operationId='same-original',
                          metadata=dict(autonomousInstaller=binding,autonomousResume=old['metadata']['autonomousResume'],
                                        autonomousPartialResume={**proof,'workerPid':123},autonomousError=error))
            for name,value in [('request.json',request),('input-resume-partialstop.json',proof),('failure.json',{**error,'effectsAdmitted':True})]:
                installer._write_record(retained/name,value)
            real_hash=installer.file_hash
            def historical_hash(path):
                return installer.PARTIAL_RETRY_INSTALLER_SHA if Path(path)==retained/'install_release.py' else real_hash(path)
            def prior_verify(r,p,o):
                self.assertEqual((r,p,o),(root,prior,old)); return dict(oldProcesses=[dict(pid=1),dict(pid=2)])
            # Prior revision3/native proof is a separate existing boundary. This
            # test executes the new revision5 verifier and all its file bindings.
            with patch.object(installer,'file_hash',side_effect=historical_hash),patch.object(installer,'verify_partial_stop_resume',side_effect=prior_verify),patch.object(installer,'verify_retired_worker',return_value=dict(pid=123)) as retired:
                result=installer.verify_partial_retry_resume(root,retained,original)
                self.assertEqual(result['expectedOriginal'],original); self.assertEqual(result['priorCache'],str(retained))
                for delta in [dict(revision=6),dict(status='succeeded'),dict(operationId='other'),dict(threadId=str(prior))]:
                    with self.assertRaises(RuntimeError): installer.verify_partial_retry_resume(root,retained,{**original,**delta})
                changed=deepcopy(original); changed['metadata']['autonomousPartialResume']['expectedOriginal']['revision']=4
                with self.assertRaises(RuntimeError): installer.verify_partial_retry_resume(root,retained,changed)
                for name in ['backup','retired.json','install.stdout','launch-intent.json','recovery-launch-intent.json','result.json']:
                    (retained/name).touch()
                    with self.assertRaises(RuntimeError): installer.verify_partial_retry_resume(root,retained,original)
                    (retained/name).unlink()
                with patch.object(installer,'verify_retired_worker',side_effect=RuntimeError('worker still live')):
                    with self.assertRaisesRegex(RuntimeError,'still live'): installer.verify_partial_retry_resume(root,retained,original)
                archive.write_bytes(b'changed')
                with self.assertRaises(RuntimeError): installer.verify_partial_retry_resume(root,retained,original)

    def test_owner_ready_uses_existing_observer_and_refuses_failed_web(self):
        # Execute the shipped owner, actual Ready observer and SQLite-shaped CAS
        # port. Native assertion is separately exercised with real TCP ownership.
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'hub'; root.mkdir(); pkg=base/'package'; runtime=pkg/'runtime'
            def module(name,body):
                path=runtime/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(body,encoding='utf-8')
            module('src/infrastructure/persistence/maintenance-operation-store.mjs',
                "import fs from 'node:fs';import path from 'node:path';export class MaintenanceOperationStore {"
                "constructor({dataDir}){this.file=path.join(dataDir,'operation.json')}get(){return JSON.parse(fs.readFileSync(this.file))}"
                "transition(id,delta,{expectedRevision}){let op=this.get();if(op.revision!==expectedRevision)return {applied:false};"
                "op={...op,...delta,revision:op.revision+1};fs.writeFileSync(this.file,JSON.stringify(op));return {applied:true,operation:op}}}")
            module('src/infrastructure/process/desktop-control.mjs',
                "import fs from 'node:fs';import path from 'node:path';let calls=0;"
                "export async function readDesktopControlEndpoint(){return {endpointId:'same-endpoint'}}"
                "export async function callDesktopControl(a,b,{runtimeRoot}){let health=JSON.parse(fs.readFileSync(path.join(runtimeRoot,'health.json')));"
                "calls++;Date.now=()=>calls*200000;health.ready=calls>health.startingProbes;return health}")
            module('src/infrastructure/filesystem/runtime-layout.mjs',"export const defaultRuntimeRoot=()=>'';")
            module('src/infrastructure/process/process-liveness.mjs',"export const processIsAlive=()=>true;")
            module('src/infrastructure/filesystem/config.mjs',"export const miniAppSettings=value=>value;")
            module('src/runtime/runtime-manager.mjs',
                "export async function runtimeStatus(){return {current:'new',runningRelease:'new',running:true,ready:true,pid:123}}")
            module('src/runtime/publication-readiness.mjs',(SOURCE.parents[1]/'src/runtime/publication-readiness.mjs').read_text(encoding='utf-8'))
            owner=base/'owner.mjs'; owner.write_text(installer.OWNER_MODULE,encoding='utf-8')
            assertion=base/'assert.py'; assertion.write_text(
                "import sys,json,pathlib; pathlib.Path(sys.argv[2],'asserted.json').write_text(json.dumps(sys.argv[1:]))",encoding='utf-8')
            (root/'data').mkdir(); (root/'data/bot.lock').write_text('{"pid":123}')
            (root/'config.json').write_text('{"miniApp":{"host":"127.0.0.1","port":8787}}')
            value=dict(releaseId='new',hostPid=456,hostCreated='789',python=sys.executable,installer=str(assertion))
            input_path=base/'input.json'; installer._write_record(input_path,value)
            for state in ['ready','failed','disabled']:
                with self.subTest(state=state):
                    original=dict(operationId='same-original',revision=6,status='reconciling',outcome='unknown')
                    (root/'data/operation.json').write_text(json.dumps(original),encoding='utf-8')
                    (root/'health.json').write_text(json.dumps(dict(live=True,ready=False,startingProbes=3,
                        process=dict(releaseId='new',pid=123),capabilities=[dict(name='mini_app',state=state)])),encoding='utf-8')
                    result=subprocess.run([shutil.which('node'),str(owner),str(pkg),str(root),'same-original','ready',str(input_path)],
                        capture_output=True,encoding='utf-8',timeout=15,creationflags=0x08000000)
                    op=installer._read_record(root/'data/operation.json')
                    if state=='failed':
                        self.assertNotEqual(result.returncode,0); self.assertEqual(op,original)
                    else:
                        self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(op['status'],'succeeded')
                        asserted=json.loads((root/'asserted.json').read_text(encoding='utf-8'))
                        self.assertEqual(asserted[:4],['--assert-launch',str(root),'456','789'])
                        self.assertEqual(len(asserted),4 if state=='disabled' else 5)
                        if state=='ready': self.assertEqual(json.loads(asserted[4]),dict(pid=123,host='127.0.0.1',port=8787))

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
