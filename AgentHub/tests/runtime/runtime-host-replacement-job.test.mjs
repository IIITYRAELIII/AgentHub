import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildWindowsRuntimeHost, runtimeHostCompilerCandidates } from '../helpers/external-runtime-builder.fixture.mjs';

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
  for (const mode of ['ready', 'extra', 'not-ready', 'foreign-ready', 'lost-reply', 'entry-inherited', 'entry-foreign', 'entry-forged-job', 'ready-acceptance', 'acceptance-unowned', 'acceptance-closed']) await t.test(mode, async () => {
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
    if (mode.includes('acceptance')) await writeFile(path.join(root, '.agent-hub-release-acceptance.json'),
      JSON.stringify({ schemaVersion: 1, id: randomUUID(), root }));
    if (mode === 'acceptance-closed') await writeFile(path.join(root, '.agent-hub-release-acceptance.closed'), '1');
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
    const launcherLog = path.join(root, 'launcher-error.log');
    const priorFailure = await readFile(launcherLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const result = await execute(driver, [run, process.execPath, submit, mode], { windowsHide: true, timeout: 45000,
      ...(mode.startsWith('entry-') ? { env: { ...process.env, AGENT_HUB_RESTART_OPERATION_ID: operation,
        AGENT_HUB_PACKAGE_REPLACEMENT_OUTSIDE_JOBS: '1' } } : {}),
    });
    assert.equal(result.stderr, '');
    const proof = JSON.parse(result.stdout);
    const nodeIdentity = await readFile(path.join(run, 'actual-node.json'), 'utf8').then(JSON.parse,
      error => { if (error.code === 'ENOENT') return null; throw error; });
    const failure = (await readFile(launcherLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).slice(priorFailure.length);
    if (mode.startsWith('entry-')) {
      assert.ok(proof.targetPid > 0);
      assert.equal(proof.targetExitCode, 1);
      assert.equal(nodeIdentity, null, 'foreign/inherited/forged Job never reaches Node');
      assert.match(failure, /Replacement Host (must enter outside|is not in its exact new owned Job|owned launcher identity changed)/);
      t.diagnostic(JSON.stringify({ mode, ...proof, failure }));
      return;
    }
    const outcome = JSON.parse(await readFile(path.join(run, 'result.json'), 'utf8'));
    t.diagnostic(JSON.stringify({ mode, ...proof, outcome, nodeIdentityCreated: Boolean(nodeIdentity), launcherFailure: failure.slice(-4096),
      readyObservationCreated: await readFile(path.join(run, 'bot.lock'), 'utf8').then(() => true, error => {
        if (error.code === 'ENOENT') return false; throw error;
      }),
    }));
    if (mode === 'acceptance-unowned' || mode === 'acceptance-closed') {
      assert.equal(outcome.launches, 1);
      assert.ok(outcome.error);
      assert.equal(nodeIdentity, null, 'unowned or closed acceptance cannot admit a new Node');
      assert.match(failure, mode === 'acceptance-closed' ? /Release acceptance is closed/
        : /no exact live acceptance cohort owner/);
      return;
    }
    assert.ok(nodeIdentity?.pid > 0 && nodeIdentity?.hostPid > 0, 'every Ready/cleanup/lost-reply oracle reaches the actual replacement Node');
    assert.equal(outcome.launches, 1, 'transport uncertainty never admits another launcher');
    if (mode === 'ready-acceptance') {
      assert.equal(outcome.ready, true);
      assert.equal(proof.newRuntimeAlive, true);
      assert.equal(proof.acceptanceOwnsReplacement, true, 'both actual Host and Node belong to the exact retained acceptance cohort');
      assert.ok(proof.oldActive >= 2, 'cohort accounting includes the replacement, not a zero-old-Job assertion');
    } else if (mode === 'ready') {
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

test('manifest validation joins late I/O, preserves first member failure and verifies every successful member', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub450-manifest-work-'));
  try {
    const source = path.resolve(import.meta.dirname, '../..');
    const host = path.join(root, 'AgentHub.RuntimeHost.exe'), driver = path.join(root, 'manifest-work.exe');
    await buildWindowsRuntimeHost({ sourceRoot: source, outputFile: host });
    await execute(runtimeHostCompilerCandidates()[0], ['/nologo', '/target:exe', `/out:${driver}`,
      '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll',
      path.join(source, 'tests/fixtures/runtime-host-manifest-work.cs')], { windowsHide: true });
    const result = await execute(driver, [host, root], { windowsHide: true, timeout: 25000 });
    assert.equal(result.stderr, '');
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.failureJoined, true);
    assert.equal(proof.lowerFailureWins, true);
    assert.equal(proof.handlesClosed, true);
    assert.equal(proof.successfulMembers, 17);
    assert.equal(proof.maxIoConcurrency, 2);
    t.diagnostic(JSON.stringify(proof));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('actual Host verifies every valid manifest member and reports the first corrupted member before Node', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub450-manifest-native-'));
  try {
    const releaseId = 'manifest-native', release = path.join(root, 'releases', releaseId);
    await mkdir(release, { recursive: true });
    const marker = path.join(root, 'unexpected-node.json');
    const files = {
      'package.json': JSON.stringify({ version: '2.1.6', type: 'module' }),
      'agent-hub-main.mjs': `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'{}');`,
      'first.bin': 'valid', 'second.bin': 'valid',
    };
    const manifest = { releaseId, version: '2.1.6', files: [] };
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(release, name), body);
      manifest.files.push({ path: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
    }
    await writeFile(path.join(release, 'runtime-manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(root, 'current.json'), JSON.stringify({ current: releaseId }));
    const host = path.join(root, 'AgentHub.RuntimeHost.exe');
    await buildWindowsRuntimeHost({ sourceRoot: path.resolve(import.meta.dirname, '../..'), outputFile: host });
    await execute(host, ['--check'], { windowsHide: true, timeout: 25000 });
    const events = () => readFile(path.join(root, 'data/runtime-host-lifetime.jsonl'), 'utf8')
      .then(body => body.trim().split('\n').map(JSON.parse));
    const valid = (await events()).findLast(row => row.stage === 'manifest-io-concurrency');
    assert.equal(valid.outcome, 'succeeded');
    assert.equal(valid.counts.members, 4);
    assert.equal(valid.counts.started, 4);
    assert.equal(valid.counts.completed, 4);
    assert.equal(valid.counts.active, 0);
    assert.equal(valid.counts.openStreams, 0);
    assert.ok(valid.counts.maxValidations <= 2 && valid.counts.maxOpenStreams <= 2);
    await writeFile(path.join(release, 'first.bin'), 'wrong');
    await writeFile(path.join(release, 'second.bin'), 'wrong');
    await assert.rejects(execute(host, [], { windowsHide: true, timeout: 25000 }), error => error.code === 1);
    assert.match(await readFile(path.join(root, 'launcher-error.log'), 'utf8'), /hash mismatch: first\.bin/);
    assert.equal(await readFile(marker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
    const failed = (await events()).findLast(row => row.stage === 'manifest-io-concurrency');
    assert.equal(failed.outcome, 'incomplete');
    assert.equal(failed.counts.active, 0);
    assert.equal(failed.counts.openStreams, 0);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
