// Isolated installation regression fixture. Uses the actual preparation/host
// builder with synthetic app bytes; it is not a product or provider acceptance.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareRuntime } from "../src/runtime/runtime-manager.mjs";
import { relativeModuleSpecifiers } from "../src/infrastructure/filesystem/module-import-specifiers.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const [area, releaseId, text, sourceCommit, publicVersion = "2026.10.19", updateRole = "plain", expectedReleaseVersion] = process.argv.slice(2);
if (!["plain", "legacy-update-fixture", "replacement-update-fixture"].includes(updateRole)) throw new Error("Unknown fixture role");
if (!area || !releaseId || !text || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) throw new Error("Fixture arguments required");
const actual = path.resolve(import.meta.dirname, "..");
const source = path.join(path.resolve(area), "source");
const copied = new Set();
async function copyModule(relative) {
  relative = path.posix.normalize(relative);
  if (relative.startsWith("../") || copied.has(relative)) return;
  copied.add(relative);
  const body = await readFile(path.join(actual, relative), "utf8");
  const target = path.join(source, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");
  for (const specifier of relativeModuleSpecifiers(body)) {
    await copyModule(path.posix.join(path.posix.dirname(relative), specifier));
  }
}
await copyModule("src/runtime/runtime-manager.mjs");
await copyModule("src/infrastructure/process/publication-lock.mjs");
await copyModule("src/domain/runtime-package-identity.mjs");
if (updateRole !== "plain") {
  await copyModule("src/infrastructure/process/instance-lock.mjs");
  await copyModule("src/infrastructure/process/desktop-control.mjs");
  await copyModule("src/infrastructure/persistence/maintenance-operation-store.mjs");
  if (updateRole === "replacement-update-fixture") await copyModule("src/runtime/runtime-package-handoff.mjs");
}
await cp(path.join(actual, "RuntimeHost"), path.join(source, "RuntimeHost"), { recursive: true });
if (updateRole === "legacy-update-fixture") {
  // Actual immutable old public Host code has NO package callback/bootstrap.
  // The application below is a literal local fixture, not a fake old stop API.
  const { stdout } = await promisify(execFile)("git", ["show", "aaaa09470ea1157412f5889ab5d617aa12e1b0ed:AgentHub/RuntimeHost/AgentHub.RuntimeHost.cs"],
    { cwd: actual, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  await writeFile(path.join(source, "RuntimeHost/AgentHub.RuntimeHost.cs"), stdout, "utf8");
}
await mkdir(path.join(source, "VSCodeExtension", "media"), { recursive: true });
await cp(path.join(actual, "VSCodeExtension", "media", "agent-hub-mark.png"), path.join(source, "VSCodeExtension", "media", "agent-hub-mark.png"));
await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "agent-hub", version: publicVersion, type: "module" }));
await writeFile(path.join(source, "agent-hub-main.mjs"), `console.log(${JSON.stringify(text)});\n`);
if (updateRole !== "plain") {
  await writeFile(path.join(source, "agent-hub-main.mjs"), `
    import fs from 'node:fs/promises';import path from 'node:path';
    import {SingleInstanceGuard} from './src/infrastructure/process/instance-lock.mjs';
    import {DesktopControlServer} from './src/infrastructure/process/desktop-control.mjs';
    import {MaintenanceOperationStore} from './src/infrastructure/persistence/maintenance-operation-store.mjs';
    const root=process.env.AGENT_HUB_RUNTIME_ROOT,dataDir=path.join(root,'data');
    const guard=new SingleInstanceGuard({dataDir});await guard.acquire();
    const store=new MaintenanceOperationStore({dataDir});
    store.create({operationId:'fixture-init',kind:'restart',streamId:'fixture',threadId:'fixture',status:'succeeded',phase:'completed'});
    let ready=false;
    const control=new DesktopControlServer({runtimeRoot:root,handler:async({action})=>{
      if(action!=='runtime-health')throw new Error('No future package/stop callback exists in literal legacy fixture');
      return {live:true,ready,process:{pid:process.pid,releaseId:process.env.AGENT_HUB_RELEASE_ID}};
    }});await control.start();
    const original=process.env.AGENT_HUB_RESTART_OPERATION_ID;
    if(original){const row=store.getReadonly(original);if(row?.metadata?.expectedReleaseId!==process.env.AGENT_HUB_RELEASE_ID)throw new Error('wrong replacement original');
      store.settle(original,{succeeded:true,phase:'completed'});}
    await guard.markReady();ready=true;
    await fs.writeFile(path.join(root,${JSON.stringify(`${updateRole}-ready.json`)}),JSON.stringify({pid:process.pid}));
    const timer=setInterval(async()=>{if(await fs.stat(path.join(root,${JSON.stringify(`${updateRole}-stop`)})).then(()=>true,()=>false)){
      clearInterval(timer);await control.close();await guard.release();process.exit(0);
    }},25);
  `, "utf8");
}
await writeFile(path.join(source, "codex-stop-hook-launcher.mjs"), "// Synthetic fixture; no provider hook.\n");
const prepared = await prepareRuntime({ sourceRoot: source, runtimeRoot: path.join(path.resolve(area), "build"), releaseId,
  publicationRevision: sourceCommit, ...(expectedReleaseVersion ? { expectedReleaseVersion } : {}) });
console.log(JSON.stringify({ releaseRoot: prepared.releaseRoot, fixture: true }));
