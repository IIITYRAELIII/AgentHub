import assert from "node:assert/strict";import test from "node:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";import {createHash} from "node:crypto";import {execFile} from "node:child_process";import {promisify} from "node:util";
import {buildWindowsRuntimeHost} from "../../src/infrastructure/process/runtime-host-builder.mjs";
const exec=promisify(execFile);
test("controlled direct invocation owns its actual Node child through exit",{skip:process.platform!=="win32"},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"hub-owned-host-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const releaseId="fixture-owned",release=path.join(root,"releases",releaseId);await mkdir(release,{recursive:true});
 const record=path.join(root,"child-result.json");
 const files={"package.json":JSON.stringify({version:"2026.10.12",type:"module"}),"agent-hub-main.mjs":'import fs from "node:fs";await new Promise(r=>setTimeout(r,200));fs.writeFileSync('+JSON.stringify(record)+',JSON.stringify({pid:process.pid,parentPid:process.ppid}));process.exit(23);'};
 const manifest={releaseId,version:"2026.10.12",files:[]};for(const [name,body] of Object.entries(files)){await writeFile(path.join(release,name),body);manifest.files.push({path:name,bytes:Buffer.byteLength(body),sha256:createHash("sha256").update(body).digest("hex")});}
 await writeFile(path.join(root,"current.json"),JSON.stringify({current:releaseId}));await writeFile(path.join(release,"runtime-manifest.json"),JSON.stringify(manifest));
 const host=path.join(root,"AgentHub.RuntimeHost.exe");await buildWindowsRuntimeHost({sourceRoot:path.resolve(import.meta.dirname,"../.."),outputFile:host});
 let exit;try{await exec(host,[],{windowsHide:true,timeout:30000});exit=0;}catch(e){exit=e.code;}
 assert.equal(exit,23,"the launcher waits for its owned child, never returns after a WMI submission");
 const child=JSON.parse(await readFile(record,"utf8"));assert.ok(child.pid>0);assert.ok(child.parentPid>0);
});
