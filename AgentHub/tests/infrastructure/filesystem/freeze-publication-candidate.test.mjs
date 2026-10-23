import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { freezePreparedPublication } from "../../../publish-changed.mjs";
import { releaseOperationRuntimePublicationInput } from "../../../release-operation-publication-runner.mjs";
import { ReleaseGitWorkspaceService, assertReleaseCandidateContourSource } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => String((await execute("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout).trimEnd();
async function fixture(t, {
  releaseAutoCrlf = "false",
  attributes = "* text eol=lf\n",
  changelogContent = Buffer.from("consolidated\n"),
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-freeze-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", path.join(root, "origin.git"));
  await git(root, "clone", path.join(root, "origin.git"), primary);
  await git(primary, "config", "core.autocrlf", "false");
  await mkdir(path.join(primary, "AgentHub"));
  if (attributes !== null) await writeFile(path.join(primary, ".gitattributes"), attributes);
  await writeFile(path.join(primary, "AgentHub", "package.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23",
  }, null, 2)}\n`);
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23", packages: { "": { name: "agent-hub", version: "2026.8.23" } },
  }, null, 2)}\n`);
  await writeFile(path.join(primary, "app.txt"), "source\n");
  await writeFile(path.join(primary, "CHANGELOG.md"), "previous\n");
  await git(primary, "add", "-A");
  await git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
  await git(primary, "push", "-u", "origin", "main");
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data") });
  const candidate = await service.prepareCandidate({ projectRoot: primary, workspaceId: "workspace", planRevision: "plan", frozenTasks: [],
    approvedBaseCommit: await git(primary, "rev-parse", "main") });
  await git(candidate.releaseRoot, "config", "core.autocrlf", releaseAutoCrlf);
  const checkpointFile = path.join(candidate.releaseRoot, "..", "checkpoint.json");
  const freeze = (options = {}) => service.freezePublicationCandidate({ projectRoot: primary, workspaceId: "workspace",
    expectedPlanRevision: "plan", expectedPreparedHead: candidate.preReleaseHead,
    changelogContent, releaseDate: new Date(2026, 7, 24, 23, 59), ...options });
  return { primary, service, candidate, freeze, checkpointFile, changelogContent };
}

const freezeThroughPublicWrapper = (fixture, options = {}) => freezePreparedPublication({
  workspaceId: "workspace",
  repositoryRoot: fixture.candidate.releaseRoot,
  readPlan: async () => ({ revision: "plan" }),
  assertCleanTree: async () => {},
  assertCurrentRevision: async () => {},
  ...options,
});

test("freeze pins the artifact version separately and retry never reallocates it", async (t) => {
  const f = await fixture(t);
  const runtimeRoot = path.join(f.primary, "..", "runtime");
  const releases = path.join(runtimeRoot, "releases");
  const add = async (name, releaseVersion) => {
    const root = path.join(releases, name);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "runtime-manifest.json"), JSON.stringify({
      version: "2026.8.24", releaseVersion,
    }));
  };
  await add("prior", "2026.8.24.7");
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), f.changelogContent);
  const frozen = await f.freeze({ runtimeRoot });
  const manifest = JSON.parse(await readFile(frozen.manifestFile, "utf8"));
  assert.equal(manifest.publication.releaseVersion, "2026.8.24");
  assert.equal(manifest.publication.runtimeReleaseVersion, "2026.8.24.8");
  assert.deepEqual(releaseOperationRuntimePublicationInput({
    operation: { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe" },
    generation: { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2 },
    candidate: { commit: frozen.preReleaseHead, manifest },
  }), { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2,
    sourceCommit: frozen.preReleaseHead, version: "2026.8.24.8" });
  await add("later", "2026.8.24.9");
  const repeat = await f.freeze({ runtimeRoot });
  assert.equal(repeat.manifestHash, frozen.manifestHash);
  assert.equal(JSON.parse(await readFile(repeat.manifestFile, "utf8")).publication.runtimeReleaseVersion,
    "2026.8.24.8");
});

function assertLineEndings(bytes, expected) {
  const source = bytes.toString("utf8");
  assert.ok(source.includes(expected));
  if (expected === "\r\n") {
    assert.equal(source.replaceAll("\r\n", "").includes("\n"), false);
    assert.equal(source.replaceAll("\r\n", "").includes("\r"), false);
  } else assert.equal(source.includes("\r"), false);
}

test("freeze commits only supplied CHANGELOG, promotes clone main and preserves dirty primary", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.primary, "app.txt"), "intentional primary bytes\r\n");
  const snapshot = async () => ({ head: await git(f.primary, "rev-parse", "HEAD"), branch: await git(f.primary, "symbolic-ref", "HEAD"),
    index: await git(f.primary, "write-tree"), status: await git(f.primary, "status", "--porcelain"), bytes: await readFile(path.join(f.primary, "app.txt"), "utf8") });
  const before = await snapshot();
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  const frozen = await f.freeze();
  assert.equal(frozen.phase, "frozen");
  assert.notEqual(frozen.preReleaseHead, f.candidate.preReleaseHead);
  assert.equal(await git(f.candidate.releaseRoot, "show", "-s", "--format=%P", frozen.preReleaseHead), f.candidate.preReleaseHead);
  assert.deepEqual((await git(f.candidate.releaseRoot, "diff", "--name-only", f.candidate.preReleaseHead, frozen.preReleaseHead))
    .split("\n").sort(), ["AgentHub/package-lock.json", "AgentHub/package.json", "CHANGELOG.md"]);
  assert.equal(JSON.parse(await readFile(path.join(f.candidate.releaseRoot, "AgentHub", "package.json"), "utf8")).version,
    "2026.8.24");
  assert.equal(await git(f.candidate.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
  const manifestBytes = await readFile(frozen.manifestFile);
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), frozen.manifestHash);
  assert.equal(JSON.parse(manifestBytes).workspaceId, "workspace");
  assert.equal((await assertReleaseCandidateContourSource({ sourceRoot: path.join(f.candidate.releaseRoot, "AgentHub") })).headCommit, frozen.preReleaseHead);
  const repeat = await f.freeze({ releaseDate: new Date(2026, 7, 25, 12),
    validateBeforeCommit: () => assert.fail("frozen repeat must not require a changed Await plan") });
  assert.equal(repeat.reused, true);
  assert.equal(repeat.preReleaseHead, frozen.preReleaseHead);
  assert.equal(repeat.manifestHash, frozen.manifestHash);
  assert.equal(JSON.parse(await readFile(repeat.manifestFile, "utf8")).publication.releaseVersion, "2026.8.24");
  const packageRoot = path.join(f.candidate.releaseRoot, "AgentHub");
  assert.equal(JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version, "2026.8.24");
  const lock = JSON.parse(await readFile(path.join(packageRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "2026.8.24");
  assert.equal(lock.packages[""].version, "2026.8.24");
  assert.equal(await readFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "utf8"), "consolidated\n");
  assert.deepEqual(await snapshot(), before);
});

test("freeze with unchanged CHANGELOG still commits the frozen CalVer", async (t) => {
  const f = await fixture(t);
  const frozen = await f.freeze({ changelogContent: Buffer.from("previous\n") });
  assert.notEqual(frozen.preReleaseHead, f.candidate.preReleaseHead);
  assert.equal(await git(f.candidate.releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(f.candidate.releaseRoot, "status", "--porcelain"), "");
});

test("freeze rejects source edits, changed plan and mismatched supplied bytes before moving refs", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.checkpointFile, "utf8");
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  await writeFile(path.join(f.candidate.releaseRoot, "app.txt"), "unapproved source\n");
  await assert.rejects(f.freeze(), /only frozen release metadata/u);
  await writeFile(path.join(f.candidate.releaseRoot, "app.txt"), "source\n");
  await assert.rejects(f.freeze({ expectedPlanRevision: "other" }), /plan or Workspace changed/u);
  await assert.rejects(f.freeze({ changelogContent: Buffer.from("different\n") }), /bytes changed/u);
  await assert.rejects(f.freeze({ validateBeforeCommit: () => { throw new Error("live plan changed"); } }), /live plan changed/u);
  assert.equal(await readFile(f.checkpointFile, "utf8"), before);
  assert.equal(await git(f.candidate.releaseRoot, "rev-parse", "HEAD"), f.candidate.preReleaseHead);
});

for (const phase of ["intent", "refs"]) test(`freeze resumes exact persisted commit after crash at ${phase}`, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  await assert.rejects(f.freeze({ onPhase: (value) => { if (value === phase) throw new Error("simulated interruption"); } }), /simulated interruption/u);
  const pending = JSON.parse(await readFile(f.checkpointFile, "utf8"));
  assert.equal(pending.phase, "freezing");
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "replaced\n");
  await assert.rejects(f.freeze({ changelogContent: Buffer.from("replaced\n") }), /supplied publication CHANGELOG bytes changed/u);
  await assert.rejects(f.freeze(), /publication CHANGELOG no longer matches frozen content/u);
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\r\n");
  await assert.rejects(f.freeze({ changelogContent: Buffer.from("consolidated\r\n") }), /supplied publication CHANGELOG bytes changed/u);
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  const frozen = await f.freeze({ releaseDate: new Date(2026, 7, 25, 12) });
  assert.equal(JSON.parse(await readFile(frozen.manifestFile, "utf8")).publication.releaseVersion, "2026.8.24");
  assert.equal(frozen.preReleaseHead, pending.preReleaseHead);
  assert.equal(frozen.manifestHash, pending.manifestHash);
  assert.equal(frozen.phase, "frozen");
  assert.equal(await git(f.candidate.releaseRoot, "status", "--porcelain"), "");
  assert.equal(await git(f.candidate.releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/main");
});

test("freeze accepts the exact mixed-EOL payload after autocrlf materializes canonical checkout bytes", async (t) => {
  const mixed = Buffer.from("consolidated\r\ninserted\nending\r\n");
  const canonicalCheckout = Buffer.from("consolidated\r\ninserted\r\nending\r\n");
  const f = await fixture(t, { releaseAutoCrlf: "true", attributes: null, changelogContent: mixed });
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), mixed);

  const frozen = await f.freeze();

  assert.equal(frozen.phase, "frozen");
  assert.deepEqual(await readFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md")), canonicalCheckout);
  assert.equal(await git(f.candidate.releaseRoot, "hash-object", "--path=CHANGELOG.md", "CHANGELOG.md"),
    frozen.publicationFreeze.changelogBlob);
  await assert.rejects(f.freeze({ changelogContent: canonicalCheckout }), /supplied publication CHANGELOG bytes changed/u);
  assert.equal((await f.freeze()).reused, true);
});

for (const scenario of [
  { name: "autocrlf false with eol=lf", autoCrlf: "false", attributes: "* text eol=lf\n",
    payload: Buffer.from("one\ntwo\n"), checkoutEol: "\n" },
  { name: "autocrlf true with mixed input", autoCrlf: "true", attributes: null,
    payload: Buffer.from("one\r\ntwo\n"), checkoutEol: "\r\n" },
  { name: "autocrlf input with CRLF input", autoCrlf: "input", attributes: null,
    payload: Buffer.from("one\r\ntwo\r\n"), checkoutEol: "\n" },
  { name: "autocrlf false with eol=crlf", autoCrlf: "false", attributes: "* text eol=crlf\n",
    payload: Buffer.from("one\ntwo\n"), checkoutEol: "\r\n" },
]) test(`freeze keeps raw evidence and canonical metadata across ${scenario.name}`, async (t) => {
  const f = await fixture(t, {
    releaseAutoCrlf: scenario.autoCrlf,
    attributes: scenario.attributes,
    changelogContent: scenario.payload,
  });
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), scenario.payload);

  const frozen = await f.freeze();
  const intent = frozen.publicationFreeze;
  const payloadFile = path.join(f.candidate.releaseRoot, "..", "evidence", intent.changelogPayloadFile);
  assert.deepEqual(await readFile(payloadFile), scenario.payload);
  assert.equal(createHash("sha256").update(scenario.payload).digest("hex"), intent.changelogContentHash);
  assertLineEndings(await readFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md")), scenario.checkoutEol);
  assert.equal(await git(f.candidate.releaseRoot, "hash-object", "--path=CHANGELOG.md", "CHANGELOG.md"),
    intent.changelogBlob);
  for (const name of ["package.json", "package-lock.json"]) {
    const bytes = await readFile(path.join(f.candidate.releaseRoot, "AgentHub", name));
    assertLineEndings(bytes, scenario.checkoutEol);
    assert.equal(JSON.parse(bytes).version, "2026.8.24");
  }
});

for (const phase of ["intent", "refs"]) test(`autocrlf freeze resumes exact mixed-EOL payload after crash at ${phase}`, async (t) => {
  const mixed = Buffer.from("consolidated\r\ninserted\nending\r\n");
  const canonicalCheckout = Buffer.from("consolidated\r\ninserted\r\nending\r\n");
  const f = await fixture(t, { releaseAutoCrlf: "true", attributes: null, changelogContent: mixed });
  const changelogFile = path.join(f.candidate.releaseRoot, "CHANGELOG.md");
  await writeFile(changelogFile, mixed);
  await assert.rejects(f.freeze({
    onPhase: (value) => { if (value === phase) throw new Error("simulated interruption"); },
  }), /simulated interruption/u);
  const pending = JSON.parse(await readFile(f.checkpointFile, "utf8"));
  assert.equal(pending.phase, "freezing");
  assert.equal(pending.publicationFreeze.changelogContentHash,
    createHash("sha256").update(mixed).digest("hex"));

  await assert.rejects(f.freeze({ changelogContent: canonicalCheckout }), /supplied publication CHANGELOG bytes changed/u);
  const frozen = await f.freeze();
  assert.equal(frozen.phase, "frozen");
  assert.deepEqual(await readFile(changelogFile), canonicalCheckout);
  const repeated = await f.freeze({ validateBeforeCommit: () => assert.fail("frozen repeat must reuse persisted identity") });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.preReleaseHead, frozen.preReleaseHead);
});

test("public freeze wrapper reuses the original mixed-EOL payload after frozen checkout conversion", async (t) => {
  const mixed = Buffer.from("consolidated\r\ninserted\nending\r\n");
  const f = await fixture(t, { releaseAutoCrlf: "true", attributes: null, changelogContent: mixed });
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), mixed);

  const first = await freezeThroughPublicWrapper(f);
  const second = await freezeThroughPublicWrapper(f);

  assert.equal(second, first);
});

test("public freeze wrapper resumes after refs without reconstructing original mixed-EOL bytes", async (t) => {
  const mixed = Buffer.from("consolidated\r\ninserted\nending\r\n");
  const f = await fixture(t, { releaseAutoCrlf: "true", attributes: null, changelogContent: mixed });
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), mixed);
  let interrupt = true;
  await assert.rejects(freezeThroughPublicWrapper(f, {
    createReleaseWorkspace: ({ dataDir }) => {
      const service = new ReleaseGitWorkspaceService({ dataDir });
      return {
        freezePublicationCandidate: (options) => service.freezePublicationCandidate({
          ...options,
          onPhase: (phase) => {
            if (interrupt && phase === "refs") {
              interrupt = false;
              throw new Error("simulated refs interruption");
            }
          },
        }),
      };
    },
  }), /simulated refs interruption/u);

  assert.equal(JSON.parse(await readFile(f.checkpointFile, "utf8")).phase, "freezing");
  await freezeThroughPublicWrapper(f);
});

for (const mode of ["missing", "tampered"]) test(`public freeze wrapper rejects ${mode} raw payload evidence`, async (t) => {
  const mixed = Buffer.from("consolidated\r\ninserted\nending\r\n");
  const f = await fixture(t, { releaseAutoCrlf: "true", attributes: null, changelogContent: mixed });
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), mixed);
  await assert.rejects(freezeThroughPublicWrapper(f, {
    createReleaseWorkspace: ({ dataDir }) => {
      const service = new ReleaseGitWorkspaceService({ dataDir });
      return {
        freezePublicationCandidate: (options) => service.freezePublicationCandidate({
          ...options,
          onPhase: (phase) => {
            if (phase === "intent") throw new Error("simulated intent interruption");
          },
        }),
      };
    },
  }), /simulated intent interruption/u);
  const checkpoint = JSON.parse(await readFile(f.checkpointFile, "utf8"));
  const payloadFile = path.join(f.candidate.releaseRoot, "..", "evidence",
    checkpoint.publicationFreeze.changelogPayloadFile);
  if (mode === "missing") await rm(payloadFile);
  else await writeFile(payloadFile, "tampered\n");

  await assert.rejects(freezeThroughPublicWrapper(f), mode === "missing"
    ? /payload is missing or invalid/u
    : /payload digest changed/u);
});
