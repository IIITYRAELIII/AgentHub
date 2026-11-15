import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildWindowsRuntimeHost, runtimeHostCompilerCandidates } from '../../src/infrastructure/process/runtime-host-builder.mjs';

const execute = promisify(execFile);
test('real controlled Host escapes the old Job, joins its relay and retains whole-job refusal and cleanup', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub408-replacement-job-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const host = path.join(root, 'AgentHub.RuntimeHost.exe'), driver = path.join(root, 'driver.exe');
  const source = path.resolve(import.meta.dirname, '../..');
  await buildWindowsRuntimeHost({ sourceRoot: source, outputFile: host });
  await execute(runtimeHostCompilerCandidates()[0], ['/nologo', '/target:exe', `/out:${driver}`,
    '/reference:System.dll', '/reference:System.Web.Extensions.dll',
    path.join(source, 'tests/fixtures/runtime-host-replacement-job.cs')], { windowsHide: true });
  for (const mode of ['ready', 'extra', 'not-ready', 'foreign-ready', 'lost-reply']) await t.test(mode, async () => {
    const run = path.join(root, mode); await mkdir(run);
    // Actual compiled Host location owns its runtime root. Each mode is joined
    // before the next pointer change; no live Hub or provider is started.
    const release = `fixture-${mode}`, releaseRoot = path.join(root, 'releases', release);
    await mkdir(releaseRoot, { recursive: true });
    const operation = randomUUID();
    const files = {
      'package.json': JSON.stringify({ version: '2.1.4', type: 'module' }),
      'agent-hub-main.mjs': `import fs from 'node:fs';
        const root=${JSON.stringify(run)};
        fs.writeFileSync(root+'/actual-node.json',JSON.stringify({pid:process.pid,hostPid:process.ppid}));
        fs.writeFileSync(root+'/bot.lock',JSON.stringify({pid:Number(process.env.FIXTURE_READY_PID)||process.pid,
          instanceToken:'owned-fixture',ready:${mode !== 'not-ready'},releaseId:${JSON.stringify(release)},
          restartOperationId:process.env.AGENT_HUB_RESTART_OPERATION_ID}));
        while(!fs.existsSync(root+'/app-stop'))await new Promise(r=>setTimeout(r,20));`,
    };
    const manifest = { releaseId: release, version: '2.1.4', files: [] };
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(releaseRoot, name), body);
      manifest.files.push({ path: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
    }
    await writeFile(path.join(releaseRoot, 'runtime-manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(root, 'current.json'), JSON.stringify({ current: release }));
    const submit = path.join(run, 'submit.mjs');
    await writeFile(submit, `import fs from 'node:fs';import {spawn} from 'node:child_process';
      import {botReplacementInvocation,launchReplacementAndWait} from ${JSON.stringify(pathToFileURL(path.join(source,'src/runtime/runtime-restart.mjs')).href)};
      const root=${JSON.stringify(run)},mode=${JSON.stringify(mode)};
      if(process.argv[2]==='leaf'){while(!fs.existsSync(root+'/old-stop'))await new Promise(r=>setTimeout(r,20));}
      else {
        let leaf;
        if(mode==='extra'||mode==='foreign-ready'){leaf=spawn(process.execPath,[import.meta.filename,'leaf'],{stdio:'ignore',windowsHide:true,detached:true});leaf.unref();}
        const env={...process.env,AGENT_HUB_LAUNCHER:${JSON.stringify(host)},AGENT_HUB_RESTART_OPERATION_ID:${JSON.stringify(operation)}};
        if(mode==='foreign-ready')env.FIXTURE_READY_PID=String(leaf.pid);
        let launches=0;
        const start=(...args)=>{
          launches++;const child=spawn(...args);
          if(mode==='lost-reply'&&child.stdout){
            const emit=child.stdout.emit;let dropped=false;
            child.stdout.emit=function(event,...values){
              if(event==='data'&&!dropped){dropped=true;return true;}
              return emit.call(this,event,...values);
            };
          }
          return child;
        };
        try {
          const result=await launchReplacementAndWait({invocation:botReplacementInvocation({environment:env,platform:'win32'}),
            lockFile:root+'/bot.lock',expectedReleaseId:${JSON.stringify(release)},expectedOperationId:${JSON.stringify(operation)},
            ownershipTimeoutMs:mode==='lost-reply'?1500:10000,readinessTimeoutMs:700,pollMs:20,spawnImpl:start});
          fs.writeFileSync(root+'/result.json',JSON.stringify({ready:result.lock.ready,launches}));
        }catch(error){fs.writeFileSync(root+'/result.json',JSON.stringify({error:error.message,cleanup:error.replacementCleanup,launches}));}
      }`);
    const result = await execute(driver, [run, process.execPath, submit, mode], { windowsHide: true, timeout: 45000 });
    assert.equal(result.stderr, '');
    const proof = JSON.parse(result.stdout), outcome = JSON.parse(await readFile(path.join(run, 'result.json'), 'utf8'));
    t.diagnostic(JSON.stringify({ mode, ...proof, outcome }));
    assert.equal(outcome.launches, 1, 'transport uncertainty never admits another launcher');
    if (mode === 'ready') {
      assert.equal(outcome.ready, true);
      assert.equal(proof.newRuntimeAlive, true);
      assert.equal(proof.oldActive, 0, 'successor and completed relay must leave no member in the exact old Job');
    } else if (mode === 'extra') {
      assert.equal(outcome.ready, true);
      assert.equal(proof.newRuntimeAlive, true);
      assert.equal(proof.oldActive, 1, 'a real unrelated old writer still prevents whole Job zero');
    } else if (mode === 'not-ready') {
      assert.ok(outcome.error);
      assert.equal(outcome.cleanup.confirmed, true);
      assert.equal(proof.newRuntimeAlive, false);
      assert.equal(proof.oldActive, 0);
    } else if (mode === 'foreign-ready') {
      assert.match(outcome.error, /handoff remains unknown/);
      assert.equal(outcome.cleanup.confirmed, false, 'foreign ready PID supplies no commit/cleanup authority');
      assert.equal(proof.newRuntimeAlive, false);
      assert.equal(proof.oldActive, 1);
    } else {
      assert.ok(outcome.error);
      assert.equal(outcome.cleanup.confirmed, false, 'missing native identity remains unknown despite actual fixture cleanup');
      assert.equal(proof.newRuntimeAlive, false);
      assert.equal(proof.oldActive, 0);
    }
  });
});
