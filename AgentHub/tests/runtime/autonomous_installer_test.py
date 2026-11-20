"""Recipient installer checks. Run: python -m unittest discover -s tests/runtime -p autonomous_installer_test.py"""
import importlib.util
import hashlib
from contextlib import closing, ExitStack, redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import time
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
    def test_explicit_modes_and_cancel_never_default_to_force(self):
        for mode in ['wait','force']:
            self.assertEqual(installer.choose_install_mode(mode),mode)
            self.assertEqual(installer.choose_install_mode(None,lambda: mode),mode)
        for invalid in [None,'unknown','']:
            with self.assertRaises(ValueError): installer.choose_install_mode(None,lambda: invalid)
        with patch.object(sys.stdin,'isatty',return_value=False):
            with self.assertRaisesRegex(ValueError,'--mode'): installer.choose_install_mode(None)

    def test_wait_current_observes_drain_and_refuses_unknown_or_changed_owner(self):
        process=dict(pid=123,instanceId='original-instance',releaseId='old')
        def health(count=0,pending=False,**delta):
            state=dict(protocol=1,operationId='same-update',revision=1,mode='wait',admissionClosed=True,
                       activeCount=count,unknownCount=0,pendingAdmission=pending)
            state.update(delta)
            return dict(live=True,ready=True,process=process,installerCutover=state)
        samples=iter([health(2),health(0,True),health()]); observed=[]; waits=[]
        result=installer.wait_for_current_turns(lambda:next(samples),'same-update',process,observed.append,waits.append)
        self.assertEqual(result['activeCount'],0); self.assertEqual(len(observed),3); self.assertEqual(waits,[1,1])
        negatives=[health(unknownCount=1),health(protocol=0),health(operationId='foreign'),health(mode='force'),
                   health(admissionClosed=False),health(activeCount=None),health(pendingAdmission=None),
                   dict(health(),process=dict(process,pid=999)),dict(health(),live=False),dict(health(),ready=False)]
        for sample in negatives:
            with self.subTest(sample=sample):
                with self.assertRaises(RuntimeError):
                    installer.wait_for_current_turns(lambda:sample,'same-update',process,delay=lambda _:self.fail('must refuse'))
        with self.assertRaises(OSError):
            installer.wait_for_current_turns(lambda: (_ for _ in []).throw(OSError('endpoint unavailable')),
                                             'same-update',process)

    def test_actual_entrypoint_retains_each_selected_mode_before_independent_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'hub'; (root/'data').mkdir(parents=True); scratch=base/'scratch'
            archive=base/'package.zip'; archive.write_bytes(b'Not executed: transport selection fixture')
            dispatched=[]
            def dispatch(arguments,cache,environment):
                request=installer._read_record(cache/'request.json')
                self.assertEqual(installer.file_hash(cache/'install_release.py'),installer.file_hash(SOURCE))
                self.assertEqual(arguments[-1],str(cache/'request.json'))
                dispatched.append(request)
                return dict(pid=123,outsideAllJobs=True)
            for mode in ['wait','force']:
                args=[str(SOURCE),'--archive',str(archive),'--sha256',installer.file_hash(archive),
                      '--runtime-root',str(root),'--scratch-root',str(scratch),'--mode',mode]
                with patch.object(sys,'argv',args), patch.object(installer,'independent_worker',side_effect=dispatch):
                    installer.autonomous_main()
                self.assertEqual(dispatched[-1]['mode'],mode)
            self.assertNotEqual(dispatched[0]['operationId'],dispatched[1]['operationId'])
            # Same original/readback never dispatches a second worker.
            with patch.object(sys,'argv',args), patch.object(installer,'independent_worker',side_effect=AssertionError('replay')):
                installer.autonomous_main()

    @unittest.skipUnless(shutil.which('node'), 'Real authenticated IPC/SQLite/native old-layout fixture')
    def test_wait_original_authenticated_drain_then_native_stop_old_layout(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'old-hub'; (root/'data').mkdir(parents=True)
            (root/'data/history-marker').write_text('retained history and input',encoding='utf-8')
            source=SOURCE.parents[1]; package=base/'package'; package.mkdir()
            subprocess.run(['node','-e',"require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                           str(source),str(package/'runtime')],check=True,capture_output=True,creationflags=0x08000000)
            imports={name:(source/name).as_uri() for name in [
                'src/infrastructure/process/desktop-control.mjs','src/infrastructure/persistence/maintenance-operation-store.mjs',
                'src/application/installer-cutover.mjs','src/application/run-coordinator.mjs']}
            code="""import fs from 'node:fs';
const root=process.argv[2]; const urls=JSON.parse(process.argv[3]);
const {DesktopControlServer}=await import(urls['src/infrastructure/process/desktop-control.mjs']);
const {MaintenanceOperationStore}=await import(urls['src/infrastructure/persistence/maintenance-operation-store.mjs']);
const {installerCutoverOperation,installerCutoverSnapshot}=await import(urls['src/application/installer-cutover.mjs']);
const {RunCoordinator}=await import(urls['src/application/run-coordinator.mjs']);
const store=new MaintenanceOperationStore({dataDir:root+'/data'});
store.create({operationId:'fixture-schema',kind:'restart',streamId:'fixture',threadId:'fixture',status:'succeeded'});
const run={id:'actual-current',provider:'codex',threadId:'original-thread',turnId:'original-turn',status:'running'};
let launches=0;
const coordinator=new RunCoordinator({taskRuns:{forTask:()=>run},providers:{call:async()=>{run.status='completed';}},
 externalActivity:async()=>({state:'inactive'}),repositoryConflict:async()=>null,
 beginRun:async()=>{launches++;throw Error('new provider execution');},rollbackAdmission:async()=>{},launchTurn:async()=>{launches++;},
 isRuntimeStopping:()=>Boolean(installerCutoverOperation(store,root+'/data')),
 deferInput:async()=>({id:'same-queued',item:{id:'same-queued'}})});
const server=new DesktopControlServer({runtimeRoot:root,protectSecret:async()=>{},handler:async request=>{
 if(request.action==='fixture-complete'){await coordinator.completeManaged(run,{});return {completed:true};}
 if(request.action==='fixture-input')return coordinator.submitClientInput({input:'retained input',target:run,clientUserMessageId:'same-input'});
 if(request.action!=='runtime-health')throw Error('fixture action');
 return {live:true,ready:true,process:{pid:process.pid,instanceId:'fixture-native',releaseId:'legacy'},
 installerCutover:installerCutoverSnapshot({operation:installerCutoverOperation(store,root+'/data'),runs:[run],
 pendingAdmission:coordinator.hasPendingAdmission(()=>true)}),launches};}});
await server.start();fs.writeFileSync(root+'/fixture-ready','ready');
"""
            entry=root/'bot.mjs'; entry.write_text(code,encoding='utf-8')
            child=subprocess.Popen(['node',str(entry),str(root),json.dumps(imports)],stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,encoding='utf-8',creationflags=0x08000000)
            try:
                deadline=time.monotonic()+10
                while not (root/'fixture-ready').exists():
                    if child.poll() is not None: self.fail(child.communicate()[1])
                    if time.monotonic()>deadline:self.fail('Fixture IPC startup timeout')
                    time.sleep(.02)
                owner=base/'owner.mjs'; owner.write_text(installer.OWNER_MODULE,encoding='utf-8')
                value=base/'value.json'
                def call(action,payload=None):
                    args=['node',str(owner),str(package),str(root),'same-install',action]
                    if payload is not None:
                        value.write_text(json.dumps(payload),encoding='utf-8'); args.append(str(value))
                    result=subprocess.run(args,capture_output=True,encoding='utf-8',timeout=10,creationflags=0x08000000)
                    self.assertEqual(result.returncode,0,result.stderr); return json.loads(result.stdout)
                initial=call('wait-probe'); self.assertEqual(initial['process']['pid'],child.pid)
                original=call('create',dict(runtimeRoot=str(root),mode='wait'))
                self.assertEqual(original['phase'],'installer-waiting')
                def control(action):
                    script='import{callDesktopControl}from '+json.dumps(imports['src/infrastructure/process/desktop-control.mjs'])+";console.log(JSON.stringify(await callDesktopControl(process.argv[1],{},{runtimeRoot:process.argv[2]})));"
                    result=subprocess.run(['node','--input-type=module','-e',script,action,str(root)],
                        capture_output=True,encoding='utf-8',timeout=10,creationflags=0x08000000)
                    self.assertEqual(result.returncode,0,result.stderr); return json.loads(result.stdout)
                queued=control('fixture-input'); self.assertTrue(queued['queued'])
                states=[]
                settled=installer.wait_for_current_turns(lambda:call('wait-probe'),'same-install',initial['process'],
                    record=states.append,delay=lambda _:control('fixture-complete'))
                self.assertEqual([s['activeCount'] for s in states],[1,0]); self.assertIsNone(child.poll())
                self.assertEqual(call('wait-probe')['launches'],0)
                call('wait-complete',dict(state=settled,process=initial['process']))
                stopped=installer.stop_selected(root); child.wait(timeout=10)
                self.assertIn(child.pid,[p['pid'] for p in stopped])
                self.assertEqual((root/'data/history-marker').read_text(encoding='utf-8'),'retained history and input')
            finally:
                if child.poll() is None:child.kill(); child.wait(timeout=10)
                child.stdout.close(); child.stderr.close()

    @unittest.skipUnless(shutil.which('node'), 'Real SQLite owner contention fixture')
    def test_ready_checkpoint_waits_for_real_writer_without_replaying_launch_and_keeps_cas(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'hub'; (root/'data').mkdir(parents=True)
            runtime=base/'package/runtime'
            def module(name,body):
                file=runtime/name; file.parent.mkdir(parents=True,exist_ok=True); file.write_text(body,encoding='utf-8')
            actual=(SOURCE.parents[1]/'src/infrastructure/persistence/maintenance-operation-store.mjs').as_uri()
            module('src/infrastructure/persistence/maintenance-operation-store.mjs',
                'export {MaintenanceOperationStore} from '+json.dumps(actual)+';')
            module('src/runtime/publication-readiness.mjs',"export async function waitForRuntimeReplacement(){}")
            module('src/infrastructure/process/process-liveness.mjs',"export const processIsAlive=()=>true;")
            module('src/infrastructure/process/desktop-control.mjs',
                "export async function callDesktopControl(){return {live:true,ready:true,process:{releaseId:'new',pid:123},capabilities:[{name:'mini_app',state:'disabled'}]}}")
            owner=base/'owner.mjs'; owner.write_text(installer.OWNER_MODULE,encoding='utf-8')
            assertion=base/'assert.py'; assertion.write_text(
                "import pathlib,sys,time\np=pathlib.Path(sys.argv[2]); (p/'verified').write_text('verified')\n"
                "with (p/'assertions').open('a') as f:f.write('one\\n')\n"
                "end=time.monotonic()+10\nwhile not (p/'locked').exists():\n"
                " if time.monotonic()>end:raise TimeoutError('No fixture writer')\n time.sleep(.01)\n",encoding='utf-8')
            (root/'data/bot.lock').write_text('{"pid":123}',encoding='utf-8')
            value=base/'input.json'; value.write_text(json.dumps(dict(releaseId='new',hostPid=456,hostCreated='789',
                python=sys.executable,installer=str(assertion))),encoding='utf-8')
            create="import{MaintenanceOperationStore}from "+json.dumps(actual)+";const s=new MaintenanceOperationStore({dataDir:process.argv[1]});console.log(JSON.stringify(s.create({operationId:process.argv[2],kind:'restart',streamId:'agent-hub-installer',threadId:process.argv[3],status:'running',phase:'installer-backed-up'})));"
            for changed in [False,True]:
                with self.subTest(casChanged=changed):
                    ident='ready-cas' if changed else 'ready-original'
                    initial=subprocess.run(['node','--input-type=module','-e',create,str(root/'data'),ident,str(root)],
                        capture_output=True,encoding='utf-8',check=True,creationflags=0x08000000)
                    original=json.loads(initial.stdout)
                    for name in ['verified','locked','assertions']:(root/name).unlink(missing_ok=True)
                    process=subprocess.Popen(['node',str(owner),str(base/'package'),str(root),ident,'ready',str(value)],
                        stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=0x08000000)
                    try:
                        deadline=time.monotonic()+10
                        while not (root/'verified').exists():
                            if process.poll() is not None or time.monotonic()>deadline:
                                out,err=process.communicate(timeout=3); self.fail(out+err)
                            time.sleep(.01)
                        with closing(sqlite3.connect(root/'data/runtime.sqlite',timeout=0)) as writer:
                            writer.execute('BEGIN IMMEDIATE')
                            if changed:
                                altered={**original,'revision':original['revision']+1,'phase':'foreign-progress'}
                                writer.execute('UPDATE maintenance_operations SET revision=?,operation_json=? WHERE operation_id=?',
                                    (altered['revision'],json.dumps(altered),ident))
                            (root/'locked').touch()
                            time.sleep(.35 if changed else 2.25)
                            if process.poll() is not None:
                                out,err=process.communicate(timeout=3)
                                self.fail('Owner did not await the SAME contended persistence: '+out+err)
                            writer.commit()
                        out,err=process.communicate(timeout=10)
                        with closing(sqlite3.connect(root/'data/runtime.sqlite')) as db:
                            current=json.loads(db.execute('SELECT operation_json FROM maintenance_operations WHERE operation_id=?',(ident,)).fetchone()[0])
                        self.assertEqual((root/'assertions').read_text().splitlines(),['one'])
                        if changed:
                            self.assertNotEqual(process.returncode,0); self.assertEqual(current,altered)
                            self.assertIn('Original Ready checkpoint refused',err)
                        else:
                            self.assertEqual(process.returncode,0,err); self.assertEqual(current['status'],'succeeded')
                            self.assertEqual(current['operationId'],ident); self.assertEqual(current['revision'],original['revision']+1)
                        records=[json.loads(line) for line in (base/'stop-timing.jsonl').read_text().splitlines()]
                        self.assertTrue(any(row['operationId']==ident and row['retries']>0 for row in records))
                    finally:
                        if process.poll() is None:process.kill(); process.wait(timeout=5)
                        process.stdout.close(); process.stderr.close()

    @unittest.skipUnless(shutil.which('node'), 'Node SQLite process fixture')
    def test_owner_backup_persists_creator_intent_before_real_sqlite_copy_and_seals_storage(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'Hub'; (root/'data').mkdir(parents=True)
            cache=base/'owned'; cache.mkdir(); (cache/'verified').mkdir()
            (root/'config.json').write_text('{"marker":"durable-user-data"}',encoding='utf-8')
            with closing(sqlite3.connect(root/'data/sample.sqlite')) as db:
                db.execute('CREATE TABLE sample(value)'); db.execute('INSERT INTO sample VALUES(71)'); db.commit()
            pkg=base/'library'; pkg.mkdir()
            # Reuse actual maintained modules by a junction, not copied implementations.
            subprocess.run([shutil.which('node'),'-e',"require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                str(SOURCE.parents[1]),str(pkg/'runtime')],check=True,capture_output=True,creationflags=0x08000000)
            owner=cache/'installer-owner.mjs'; owner.write_text(installer.OWNER_MODULE,encoding='utf-8')
            worker=cache/'install_release.py'; shutil.copyfile(SOURCE,worker)
            identity=dict(pid=os.getpid(),outsideAllJobs=True,**installer.process_identity(installer.native_api()[2].GetCurrentProcess()))
            request=dict(runtimeRoot=str(root),runtimeIdentity=installer._directory_identity(root),operationId='creator-original',
                archive=str(base/'borrowed.zip'),release=None,installerSha256=installer.file_hash(worker))
            installer._write_record(cache/'request.json',request); installer._write_record(cache/'worker-started.json',identity)
            payload=cache/'verified/body'; payload.write_bytes(b'verified payload fixture')
            installer._write_record(cache/'verified/package-manifest.json',dict(schema=1,repository='IIITYRAELIII/AgentHub',releaseId='new',
                files=[dict(path='body',bytes=payload.stat().st_size,sha256=installer.file_hash(payload))]))
            binding=dict(runtimeRoot=str(root),releaseId='new',workerPid=os.getpid(),installerSha256=request['installerSha256'],
                archiveSha256='a'*64,packageManifestSha256=installer.file_hash(cache/'verified/package-manifest.json'),
                storageScope=dict(cache=installer._directory_identity(cache),worker=identity,requestSha256=installer.file_hash(cache/'request.json')))
            def run(action,value):
                input_file=cache/('input-'+action+'.json'); installer._write_record(input_file,value)
                result=subprocess.run([shutil.which('node'),str(owner),str(pkg),str(root),'creator-original',action,str(input_file)],
                    capture_output=True,encoding='utf-8',timeout=30,creationflags=0x08000000)
                self.assertEqual(result.returncode,0,result.stderr)
                return json.loads(result.stdout)
            run('create',binding)
            copied=run('backup',dict(destination=str(cache/'backup'),python=sys.executable,installer=str(worker)))
            attempt=copied['metadata']['autonomousBackupAttempt']; snapshot=copied['metadata']['autonomousBackup']
            self.assertEqual(attempt['root']['ino'],str((cache/'backup').stat().st_ino))
            self.assertIn('data'+os.sep+'sample.sqlite',[f['path'] for f in attempt['files']])
            self.assertIn('ok',[f.get('integrity') for f in snapshot['files']])
            # Public maintained library seals the actual producer output; no dispatch
            # acknowledgement is needed after caller death when scope is bound.
            script="""import {pathToFileURL} from 'node:url';
const [source,root,cache]=process.argv.slice(1);
const {MaintenanceOperationStore}=await import(pathToFileURL(source+'/src/infrastructure/persistence/maintenance-operation-store.mjs'));
const {sealAutonomousInstallerStorage}=await import(pathToFileURL(source+'/src/infrastructure/persistence/autonomous-installer-storage.mjs'));
const op=new MaintenanceOperationStore({dataDir:root+'/data'}).getReadonly('creator-original');
console.log(JSON.stringify(await sealAutonomousInstallerStorage({runtimeRoot:root,operation:op,cache})));"""
            result=subprocess.run([shutil.which('node'),'--input-type=module','-e',script,str(SOURCE.parents[1]),str(root),str(cache)],
                capture_output=True,encoding='utf-8',timeout=30,creationflags=0x08000000)
            self.assertEqual(result.returncode,0,result.stderr)
            evidence=json.loads(result.stdout); self.assertEqual(len(evidence['artifacts']),1)
            self.assertGreaterEqual(len(evidence['backup']['retentionFiles']),3)

    def test_flat_continuation_avoids_real_sqlite_backup_path_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); root=base/'hub'; root.mkdir()
            flat=installer.continuation_cache(base,root,'same-original','a'*64)
            self.assertEqual(flat.parent,base)
            self.assertEqual(flat,installer.continuation_cache(base,root,'same-original','a'*64))
            self.assertNotEqual(flat,installer.continuation_cache(base,root,'another-original','a'*64))
            self.assertNotEqual(flat,installer.continuation_cache(base,root,'same-original','b'*64))
            filename='journal.sqlite.before-release-status-repair-1786625258183'
            old=base/('x'*(252-len(str(base))-len('/backup/data/'+filename)-1))/'backup'
            flat=flat/'backup'; old.parent.mkdir(); flat.parent.mkdir()
            code="""
import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs/promises';import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [modulePath,root,old,flat,name]=process.argv.slice(1);
const {backupStoppedRuntime}=await import(pathToFileURL(modulePath).href);
await fs.mkdir(path.join(root,'data'));await fs.writeFile(path.join(root,'config.json'),'{}');
const db=new DatabaseSync(path.join(root,'data',name));db.exec('CREATE TABLE data(value);INSERT INTO data VALUES(42)');db.close();
let refused=false;
try{await backupStoppedRuntime({runtimeRoot:root,destination:old,assertStopped:async()=>{}})}
catch(error){if(error.code!=='ERR_SQLITE_ERROR')throw error;refused=true}
if(!refused)throw Error('Expected actual historical path-length counterexample');
const proof=await backupStoppedRuntime({runtimeRoot:root,destination:flat,assertStopped:async()=>{}});
const saved=new DatabaseSync(path.join(flat,'data',name),{readOnly:true});
if(saved.prepare('SELECT value FROM data').get().value!==42)throw Error('Backup content lost');saved.close();
if(proof.files.find(item=>item.path===path.join('data',name)).integrity!=='ok')throw Error('Missing integrity proof');
console.log(JSON.stringify({oldTargetLength:path.join(old,'data',name).length,flatTargetLength:path.join(flat,'data',name).length,passed:true}));
"""
            result=subprocess.run([shutil.which('node'),'--input-type=module','-e',code,
                str(SOURCE.parents[1]/'src/infrastructure/persistence/runtime-maintenance-backup.mjs'),str(root),str(old),str(flat),filename],
                capture_output=True,encoding='utf-8',creationflags=0x08000000,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            proof=json.loads(result.stdout); self.assertEqual(proof['oldTargetLength'],252)
            self.assertLess(proof['flatTargetLength'],252); self.assertTrue(proof['passed'])

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
                "async runMaintenanceMutation(fn){return fn()}"
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

    def test_real_kill_job_caller_exit_does_not_kill_verified_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); output=base/'proof.json'; finish=base/'finish'
            worker=base/'worker.py'
            worker.write_text("import pathlib,time\np=pathlib.Path("+repr(str(finish))+")\n"
                              "while not p.exists(): time.sleep(.05)\n",encoding='utf-8')
            caller=base/'caller.py'
            caller.write_text("import importlib.util,pathlib,json,sys,time\n"
                "s=importlib.util.spec_from_file_location('installer',"+repr(str(SOURCE))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
                "proof=m.independent_worker([sys.executable,str(pathlib.Path("+repr(str(worker))+"))],pathlib.Path("+repr(str(base))+"),m.clean_installer_environment())\n"
                "pathlib.Path("+repr(str(output))+").write_text(json.dumps(proof))\n"
                "time.sleep(60)\n",encoding='utf-8')
            c,w,k=installer.native_api()
            k.CreateJobObjectW.argtypes=[c.c_void_p,w.LPCWSTR];k.CreateJobObjectW.restype=w.HANDLE
            k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
            k.TerminateJobObject.argtypes=[w.HANDLE,w.UINT]
            job=k.CreateJobObjectW(None,None); self.assertTrue(job)
            caller_process=subprocess.Popen([sys.executable,str(caller)],creationflags=4|0x08000000,
                                             stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            handle=None
            try:
                self.assertTrue(k.AssignProcessToJobObject(job,int(caller_process._handle)))
                thread=installer.suspended_worker_thread(caller_process.pid)
                try:
                    k.ResumeThread.argtypes=[w.HANDLE];k.ResumeThread.restype=w.DWORD
                    self.assertEqual(k.ResumeThread(thread),1)
                finally:k.CloseHandle(thread)
                until=time.monotonic()+20
                while not output.exists() and caller_process.poll() is None and time.monotonic()<until:time.sleep(.05)
                self.assertTrue(output.exists(), 'caller did not publish its native dispatch proof')
                proof=json.loads(output.read_text()); handle=k.OpenProcess(0x1000|0x100000|1,False,proof['pid'])
                self.assertTrue(handle);self.assertEqual(installer.process_identity(handle)['created'],proof['created'])
                self.assertTrue(installer.outside_jobs(handle))
                member=w.BOOL();self.assertTrue(k.IsProcessInJob(handle,job,c.byref(member)));self.assertFalse(member.value)
                self.assertTrue(k.TerminateJobObject(job,1));caller_process.wait(timeout=10)
                self.assertEqual(k.WaitForSingleObject(handle,0),258)
                finish.write_text('finish');self.assertEqual(k.WaitForSingleObject(handle,10000),0)
            finally:
                finish.touch(exist_ok=True)
                if handle:
                    if k.WaitForSingleObject(handle,10000)!=0:k.TerminateProcess(handle,1);k.WaitForSingleObject(handle,10000)
                    k.CloseHandle(handle)
                k.TerminateJobObject(job,1);k.CloseHandle(job)
                caller_process.communicate(timeout=10)

    def test_real_job_reassignment_refuses_before_worker_payload_and_joins(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp); marker=base/'must-not-run'
            c,w,k=installer.native_api()
            k.CreateJobObjectW.argtypes=[c.c_void_p,w.LPCWSTR];k.CreateJobObjectW.restype=w.HANDLE
            k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
            job=k.CreateJobObjectW(None,None);self.assertTrue(job)
            real=installer.outside_jobs; retained=[]
            def foreign_assignment(handle):
                if handle!=k.GetCurrentProcess():
                    # Retain an independent handle to prove the same process exit.
                    pid=json.loads((base/'worker-create-result.json').read_text())['pid']
                    probe=k.OpenProcess(0x1000|0x100000|0x0100|1,False,pid)
                    self.assertTrue(probe);self.assertEqual(installer.process_identity(probe),installer.process_identity(handle))
                    retained.append(probe)
                    self.assertTrue(k.AssignProcessToJobObject(job,probe))
                return real(handle)
            try:
                with patch.object(installer,'outside_jobs',side_effect=foreign_assignment):
                    with self.assertRaisesRegex(RuntimeError,'independence unproved'):
                        installer.independent_worker([sys.executable,'-c',"from pathlib import Path;Path("+repr(str(marker))+").touch()"],base,installer.clean_installer_environment())
                self.assertEqual(len(retained),1);self.assertEqual(k.WaitForSingleObject(retained[0],0),0)
                self.assertFalse(marker.exists())
                record = installer._read_record(base/'worker-dispatch-failure.json')
                checks = record["checks"]
                self.assertEqual(checks["stage"], "worker-job-check")
                self.assertEqual(checks["callerOutsideAllJobs"], real(k.GetCurrentProcess()))
                self.assertEqual(checks["providerReturnValue"], 0)
                self.assertIs(checks["workerIdentityVerified"], True)
                self.assertIs(checks["workerOutsideAllJobs"], False)
                self.assertIs(checks["resumeAttempted"], False)
                self.assertIs(checks["workerJoined"], True)
            finally:
                for handle in retained:k.CloseHandle(handle)
                k.CloseHandle(job)

    def test_worker_does_not_require_an_interactive_desktop_shell(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);marker=base/'completed';c,w,k=installer.native_api()
            class Native:
                def __getattr__(self,key):return getattr(c,key)
                def WinDLL(self,name,*args,**kwargs):
                    if name=='user32':raise OSError('No interactive desktop shell in this fixture')
                    return c.WinDLL(name,*args,**kwargs)
            with patch.object(installer,'native_api',return_value=(Native(),w,k)):
                proof=installer.independent_worker([sys.executable,'-c',"from pathlib import Path;Path("+repr(str(marker))+").touch()"],base,installer.clean_installer_environment())
            handle=k.OpenProcess(0x1000|0x100000,False,proof['pid'])
            if handle:
                try:self.assertEqual(k.WaitForSingleObject(handle,10000),0)
                finally:k.CloseHandle(handle)
            self.assertTrue(marker.exists())

    def test_provider_refusal_keeps_one_creation_intent_and_original_readback(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);request=dict(operationId='same-original')
            installer._write_record(base/'request.json',request)
            def refused(command,**kwargs):
                data=json.loads(kwargs['input'])
                reply=dict(returnValue=2,pid=None)
                installer._write_record(Path(data['result']),reply)
                return subprocess.CompletedProcess(command,0,json.dumps(reply),'')
            with patch.object(installer.subprocess,'run',side_effect=refused) as provider:
                with self.assertRaisesRegex(RuntimeError,'refused creation: 2'):
                    installer.independent_worker([sys.executable,'-c','raise AssertionError()'],base,installer.clean_installer_environment())
                self.assertEqual(provider.call_count,1)
            self.assertEqual(installer._read_record(base/'request.json'),request)
            self.assertEqual(installer._read_record(base/'worker-create-intent.json')['operationId'],'same-original')
            self.assertFalse((base/'worker-verified-suspended.json').exists())
            self.assertTrue((base/'worker-dispatch-failure.json').exists())

    def test_cli_reports_dispatch_failure_without_private_input_or_second_creation(self):
        for record_saved in (True, False):
            with self.subTest(record_saved=record_saved), tempfile.TemporaryDirectory() as temp:
                base = Path(temp)
                root = base / "private-installation-path"
                (root / "data").mkdir(parents=True)
                archive = base / "private-archive-name.zip"
                archive.touch()
                args = [str(SOURCE), "--archive", str(archive), "--sha256", installer.file_hash(archive),
                        "--runtime-root", str(root), "--scratch-root", str(base / "scratch"),
                        "--mode", "force", "--operation-id", "same-original"]
                write_record = installer._write_record

                def write_or_refuse(path, value):
                    if not record_saved and path.name == "worker-dispatch-failure.json":
                        raise OSError("private record path unavailable")
                    write_record(path, value)

                def refuse_provider(command, **kwargs):
                    reply = dict(returnValue=2, pid=None)
                    write_record(Path(json.loads(kwargs["input"])["result"]), reply)
                    return subprocess.CompletedProcess(command, 0, json.dumps(reply), "private provider output")

                def invoke():
                    err, out = io.StringIO(), io.StringIO()
                    with redirect_stderr(err), redirect_stdout(out), self.assertRaises(SystemExit) as outcome:
                        installer.autonomous_main()
                    self.assertEqual(outcome.exception.code, 1)
                    self.assertEqual(out.getvalue(), "")
                    self.assertNotIn("private", err.getvalue())
                    return json.loads(err.getvalue())

                with patch.object(sys, "argv", args), patch.object(installer, "_write_record", side_effect=write_or_refuse), \
                     patch.object(installer.subprocess, "run", side_effect=refuse_provider) as provider:
                    report = invoke()
                    self.assertEqual(report["kind"], "installer-worker-dispatch-failed")
                    self.assertEqual(report["operationId"], "same-original")
                    self.assertEqual(report["installerSha256"], installer.file_hash(SOURCE))
                    self.assertEqual(report["stage"], "wmi-reply")
                    self.assertEqual(report["providerExitCode"], 0)
                    self.assertEqual(report["providerReturnValue"], 2)
                    self.assertIs(report["failureRecordSaved"], record_saved)
                    self.assertIs(type(report["callerOutsideAllJobs"]), bool)
                    self.assertIs(report["workerIdentityVerified"], False)
                    self.assertIsNone(report["workerOutsideAllJobs"])
                    self.assertIsNone(report["workerJoined"])
                    self.assertIs(report["resumeAttempted"], False)
                    if record_saved:
                        self.assertEqual(invoke(), report)
                    self.assertEqual(provider.call_count, 1)
                self.assertIsNone(installer.read_update_original(root, "same-original"))


if __name__ == "__main__":
    unittest.main()
