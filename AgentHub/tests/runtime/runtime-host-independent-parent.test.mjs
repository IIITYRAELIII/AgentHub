import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runtimeHostCompilerCandidates } from "../../src/infrastructure/process/runtime-host-builder.mjs";

const execute = promisify(execFile);
async function compileProbe(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "hub-independent-parent-"));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = path.resolve(import.meta.dirname, "../.."), executable = path.join(temporary, "probe.exe");
  await execute(runtimeHostCompilerCandidates()[0], ["/nologo", "/target:exe", "/main:IndependentParentProbe",
    `/out:${executable}`, "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Web.Extensions.dll",
    path.join(source, "RuntimeHost/AgentHub.RuntimeHost.cs"), path.join(source, "tests/fixtures/runtime-host-independent-parent.cs")],
  { windowsHide: true, timeout: 10000 });
  return { temporary, executable };
}
test("compiled Host child survives owned nested Job and submitting App tree retirement", {
  skip: process.platform !== "win32", timeout: 45000,
}, async (t) => {
  const { temporary, executable } = await compileProbe(t);
  for (const mode of ["job", "tree"]) {
    const root = path.join(temporary, mode); await mkdir(root);
    const result = await execute(executable, [root, mode], { windowsHide: true, timeout: 15000 });
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.retired, mode);
    assert.equal(proof.survived, true);
    assert.equal(proof.childInJob, false);
    assert.notEqual(proof.actualParentPid, proof.surrogatePid);
    assert.equal(result.stderr, "");
    t.diagnostic(JSON.stringify(proof));
  }
});

test("actual native continuation waits for every old writer and refreshes original Job proof before effect", {
  skip: process.platform !== "win32", timeout: 30000,
}, async (t) => {
  const { temporary, executable } = await compileProbe(t);
  const root = path.join(temporary, "cohort"); await mkdir(root);
  await writeFile(path.join(root, "stage.mjs"), `
    import fs from 'node:fs';import path from 'node:path';import {createInterface} from 'node:readline';
    const [stage,root]=process.argv.slice(2);
    if(stage==='arm')fs.writeFileSync(path.join(root,'armed.json'),JSON.stringify({hostPid:process.ppid}));
    else {
      const lines=createInterface({input:process.stdin});
      const reply=new Promise((resolve,reject)=>{lines.once('line',resolve);lines.once('close',()=>reject(new Error('parent closed')));});
      process.stdout.write('AGENT_HUB_PACKAGE_CHECK_STOPPED\\n');
      if(await reply!=='AGENT_HUB_PACKAGE_STOPPED')throw new Error('original Job is not stopped');
      lines.close();
      fs.writeFileSync(path.join(root,'continued.json'),JSON.stringify({originalJobZero:true}));
    }
    console.log('{}');
  `);
  const result = await execute(executable, [root, "cohort"], { windowsHide: true, timeout: 15000 });
  const proof = JSON.parse(result.stdout);
  assert.deepEqual(proof, { originalHostExit: true, extraWriterDeferred: true,
    continuationAfterWholeJobZero: true, oldPidsReopened: false });
  assert.equal(result.stderr, "");
  t.diagnostic(JSON.stringify(proof));
});
