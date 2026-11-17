import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runtimeLayout, runtimeReleaseDirectory } from "./runtime-layout.mjs";
import { verifyInstalledRuntime, runtimeStatus } from "../../runtime/runtime-manager.mjs";
import { isRuntimeSourceFile } from "./runtime-manifest-verifier.mjs";
import { sourceBlobs, sourceMatches } from "./local-source-baseline.mjs";
import { RUNTIME_HOST_SOURCE_INPUTS, runtimeHostSourceHash } from "../process/runtime-host-source-identity.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

// This reads actual installation and Git state. It never writes publication history.
export async function readManualTaskDelivery({ runtimeRoot, input, git, resultCommits = [],
  verifyInstalled = verifyInstalledRuntime, status = runtimeStatus } = {}) {
  if (!runtimeRoot || !input || Object.keys(input).some(k => !["revision", "releaseId", "manifestSha256"].includes(k))
      || !/^[a-f0-9]{40}$/u.test(input.revision ?? "") || !/^[a-f0-9]{64}$/u.test(input.manifestSha256 ?? "")) {
    throw Error("Exact manual delivery revision, release and manifest hash are required");
  }
  const releaseRoot = runtimeReleaseDirectory(runtimeRoot, input.releaseId);
  const manifestPath = path.join(releaseRoot, "runtime-manifest.json");
  const pointerPath = runtimeLayout(runtimeRoot).currentFile;
  const [manifestRaw, pointerRaw] = await Promise.all([readFile(manifestPath), readFile(pointerPath)]);
  const manifest = JSON.parse(manifestRaw), pointer = JSON.parse(pointerRaw);
  if (sha(manifestRaw) !== input.manifestSha256 || manifest.releaseId !== input.releaseId
      || manifest.publicationRevision !== input.revision || pointer.current !== input.releaseId
      || manifest.distributionSource?.commit && manifest.distributionSource.commit !== input.revision) {
    throw Error("Manual delivery manifest, source or installed pointer differs");
  }
  const inspect = async () => {
    const [main, origin, observed] = await Promise.all([
      git(["rev-parse", "--verify", "refs/heads/main^{commit}"]),
      git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]),
      status({ runtimeRoot, requireProcessEvidence: true }),
    ]);
    if (main !== input.revision || origin !== input.revision || !observed.running || !observed.ready
        || observed.current !== input.releaseId || observed.runningRelease !== input.releaseId || observed.restartRequired) {
      throw Error("Manual delivery requires exact main/origin and the same ready installed runtime");
    }
    return { pid: observed.pid, releaseId: observed.runningRelease };
  };
  const running = await inspect();
  if (!await verifyInstalled({ runtimeRoot, releaseId: input.releaseId, releaseRoot })) {
    throw Error("Manual delivery installed runtime verification failed");
  }
  const entries = new Map(String(await git(["ls-tree", "-r", "-z", input.revision, "--", "AgentHub"]))
    .split("\0").filter(Boolean).map(row => {
      const [meta, file] = row.split("\t"), [mode, type, oid] = meta.split(" ");
      return [file, { mode, type, oid }];
    }).filter(([file]) => isRuntimeSourceFile(file.slice(9))));
  const files = new Map((manifest.files ?? []).map(file => [file.path, file]));
  if (!Array.isArray(manifest.files) || files.size !== manifest.files.length) throw Error("Manual runtime manifest paths differ");
  const bodies = await sourceBlobs(git, entries, [...entries.keys()]);
  for (const [file, body] of bodies) {
    if (RUNTIME_HOST_SOURCE_INPUTS.includes(file.slice(9))) continue;
    const declared = files.get(file.slice(9));
    const physical = declared ? await readFile(path.join(releaseRoot, declared.path)) : null;
    if (!physical || declared.bytes !== physical.length || declared.sha256 !== sha(physical)
        || !sourceMatches(body, physical, file.slice(9))) {
      throw Error(`Manual runtime source differs from delivered Git: ${file}`);
    }
  }
  if (files.has("AgentHub.RuntimeHost.source.sha256") || RUNTIME_HOST_SOURCE_INPUTS.some(p => bodies.has(`AgentHub/${p}`))) {
    const hash = await runtimeHostSourceHash("", { readSource: file => {
      const body = bodies.get(`AgentHub/${file.replaceAll("\\", "/")}`);
      if (!body) throw Error("Manual delivery compiled Host Git inputs are missing");
      return body;
    } });
    const declared = files.get("AgentHub.RuntimeHost.source.sha256");
    const body = declared && await readFile(path.join(releaseRoot, declared.path));
    if (!body || sha(body) !== declared.sha256 || body.toString("utf8").trim() !== hash) {
      throw Error("Manual delivery compiled Host source differs from Git");
    }
  }
  for (const result of resultCommits) {
    if (!/^[a-f0-9]{40}$/u.test(result ?? "")) throw Error("Exact Task result is required");
    await git(["merge-base", "--is-ancestor", result, input.revision]);
  }
  if (!(await readFile(manifestPath)).equals(manifestRaw) || !(await readFile(pointerPath)).equals(pointerRaw)
      || JSON.stringify(await inspect()) !== JSON.stringify(running)) throw Error("Manual delivery changed during verification");
  return { kind: "verified-manual-task-delivery-v1", runtimeRoot: path.resolve(runtimeRoot),
    ...input, pointerSha256: sha(pointerRaw), running, resultCommits: [...resultCommits] };
}
