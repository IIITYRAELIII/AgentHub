import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverOfficialCodexExecutables,
  inspectOfficialCodexCandidate,
  officialCodexInstallRoots,
  readCodexExecutableVersion,
  verifyOpenAiAuthenticode,
  verifyRecordedCodexExecutable,
} from "../../../src/infrastructure/process/codex-executable.mjs";

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("Authenticode JSON waits for stdout after exit and before close", async () => {
  const child = childProcess();
  const signature = { Status: "Valid", Subject: 'CN="OpenAI OpCo, LLC", C=US' };
  const output = JSON.stringify(signature);
  const verification = verifyOpenAiAuthenticode("synthetic.exe", { spawnImpl: () => child });
  child.stdout.emit("data", output.slice(0, 18));
  child.emit("exit", 0, null);
  child.stdout.emit("data", output.slice(18));
  child.emit("close", 0, null);
  assert.deepEqual(await verification, { valid: true, status: "Valid", publisher: signature.Subject });
});

test("version inspection waits for the complete prerelease after exit", async () => {
  const child = childProcess();
  const version = readCodexExecutableVersion("synthetic.exe", { spawnImpl: () => child });
  child.stdout.emit("data", "codex-cli 0.152.1");
  child.emit("exit", 0, null);
  child.stdout.emit("data", "-alpha.7.2\n");
  child.emit("close", 0, null);
  assert.equal(await version, "0.152.1-alpha.7.2");
});

test("a child that exits without closing its pipes still reaches the deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const child = childProcess();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const version = readCodexExecutableVersion("synthetic.exe", { spawnImpl: () => child, timeoutMs: 500 });
  const rejected = assert.rejects(version, /Process timed out after 500 ms/);
  child.stdout.emit("data", "codex-cli 0.152.1");
  child.emit("exit", 0, null);
  context.mock.timers.tick(500);
  await rejected;
  child.emit("close", 0, null);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("failed subprocess and malformed signature output do not expose child content", async () => {
  for (const exitCode of [0, 1]) {
    const child = childProcess();
    const verification = verifyOpenAiAuthenticode("synthetic.exe", { spawnImpl: () => child });
    const rejected = assert.rejects(verification, (error) => {
      assert.equal(error.message, exitCode === 0
        ? "Authenticode inspection returned invalid JSON"
        : "Process exited with code=1 signal=none");
      assert.equal(error.message.includes("synthetic-secret"), false);
      return true;
    });
    child.stdout.emit("data", "synthetic-secret: invalid JSON");
    child.stderr.emit("data", "synthetic-secret: failed command");
    child.emit("exit", exitCode, null);
    child.emit("close", exitCode, null);
    await rejected;
  }
});

function installedCandidate(source, name) {
  const installRoot = path.resolve("official", source);
  return { source, installRoot, executable: path.join(installRoot, name, "codex.exe") };
}

function inspectionOptions(calls) {
  return {
    inspectBundle: async () => null, // These cases isolate main-executable trust; bundle has its own native cases.
    realpathImpl: async (value) => value,
    statImpl: async () => ({ isFile: () => true }),
    hashFile: async (file) => { calls.push(["hash", file]); return "A".repeat(64); },
    verifySignature: async (file) => {
      calls.push(["signature", file]);
      return { valid: true, status: "Valid", publisher: 'CN="OpenAI OpCo, LLC"' };
    },
    readVersion: async (file) => { calls.push(["version", file]); return "0.152.1"; },
  };
}

test("selected canonical path inspects only its freshly enumerated installed candidate", async () => {
  const selected = installedCandidate("desktop", "selected");
  const unrelated = installedCandidate("vscode", "other");
  const canonicalPath = path.join(selected.installRoot, "canonical", "codex.exe");
  const calls = [];
  let enumerations = 0;
  const result = await discoverOfficialCodexExecutables({
    ...inspectionOptions(calls),
    platform: "win32",
    selectedPath: canonicalPath.toUpperCase(),
    enumerateCandidates: async () => { enumerations += 1; return [unrelated, selected]; },
    realpathImpl: async (value) => value === selected.executable ? canonicalPath : value,
  });
  assert.equal(enumerations, 1);
  assert.deepEqual(result.candidates.map((entry) => entry.path), [canonicalPath]);
  assert.deepEqual(calls, ["hash", "signature", "hash", "version", "hash"].map((step) => [step, canonicalPath]));
});

test("selected paths absent from installed enumeration are never inspected", async () => {
  const unrelated = installedCandidate("desktop", "other");
  const calls = [];
  const result = await discoverOfficialCodexExecutables({
    ...inspectionOptions(calls),
    platform: "win32",
    selectedPath: path.resolve("unregistered", "codex.exe"),
    enumerateCandidates: async () => [unrelated],
  });
  assert.deepEqual(result, { candidates: [], rejected: [] });
  assert.deepEqual(calls, []);
});

test("selected canonical path still must remain inside its enumerated install root", async () => {
  const selected = installedCandidate("desktop", "selected");
  const escapedPath = path.resolve("outside", "codex.exe");
  const calls = [];
  const result = await discoverOfficialCodexExecutables({
    ...inspectionOptions(calls),
    platform: "win32",
    selectedPath: escapedPath,
    enumerateCandidates: async () => [selected],
    realpathImpl: async (value) => value === selected.executable ? escapedPath : value,
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.rejected[0].error, "Codex executable escapes its official install root");
  assert.deepEqual(calls, []);
});

test("selected candidate rejections retain bounded reasons without inspecting alternatives", async () => {
  const selected = installedCandidate("desktop", "selected");
  const unrelated = installedCandidate("vscode", "other");
  const inspected = [];
  const result = await discoverOfficialCodexExecutables({
    platform: "win32",
    selectedPath: selected.executable,
    enumerateCandidates: async () => [selected, unrelated],
    realpathImpl: async (value) => value,
    inspectCandidate: async (entry) => {
      inspected.push(entry);
      throw new Error("Process timed out after 5000 ms");
    },
  });
  assert.deepEqual(inspected, [selected]);
  assert.deepEqual(result, {
    candidates: [],
    rejected: [{ path: selected.executable, source: "desktop", error: "Process timed out after 5000 ms" }],
  });
});

test("an escaping alias cannot shadow the selected allowed installed layout", async () => {
  const selected = installedCandidate("desktop", "selected");
  const alias = installedCandidate("vscode", "alias");
  const calls = [];
  const result = await discoverOfficialCodexExecutables({
    ...inspectionOptions(calls),
    platform: "win32",
    selectedPath: selected.executable,
    enumerateCandidates: async () => [alias, selected],
    realpathImpl: async (value) => value === alias.executable ? selected.executable : value,
  });
  assert.deepEqual(result.candidates.map((entry) => entry.source), ["desktop"]);
  assert.equal(result.rejected[0].error, "Codex executable escapes its official install root");
  assert.deepEqual(calls, ["hash", "signature", "hash", "version", "hash"].map((step) => [step, selected.executable]));
});

test("a removed selected executable reports its filesystem error without inspecting alternatives", async () => {
  const selected = installedCandidate("desktop", "selected");
  const unrelated = installedCandidate("vscode", "other");
  const calls = [];
  const result = await discoverOfficialCodexExecutables({
    ...inspectionOptions(calls),
    platform: "win32",
    selectedPath: selected.executable,
    enumerateCandidates: async () => [selected, unrelated],
    realpathImpl: async (value) => {
      if (value === selected.executable) throw Object.assign(new Error("synthetic-secret"), { code: "ENOENT" });
      return value;
    },
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.rejected[0].error, "Codex executable inspection failed (ENOENT)");
  assert.deepEqual(calls, []);
});

function recordedFixture(source = "desktop") {
  const environment = {
    USERPROFILE: path.resolve("recorded-official", "profile"),
    LOCALAPPDATA: path.resolve("recorded-official", "local"),
  };
  const installRoot = officialCodexInstallRoots({ environment }).find((entry) => entry.source === source).root;
  const executable = source === "desktop"
    ? path.join(installRoot, "build", "codex.exe")
    : path.join(installRoot, "openai.chatgpt-2", "bin", "windows-x86_64", "codex.exe");
  return {
    environment,
    descriptor: { executable, installRoot, source },
    recorded: {
      path: executable,
      source,
      sha256: "A".repeat(64),
      publisher: 'CN="OpenAI OpCo, LLC", C=US',
      version: "0.152.1",
    },
  };
}

test("recorded official Desktop and VS Code identities need one hash and no process or enumeration", async () => {
  for (const source of ["desktop", "vscode", "vscode-insiders"]) {
    const { recorded, environment } = recordedFixture(source);
    const calls = [];
    assert.equal(await verifyRecordedCodexExecutable(recorded, {
      ...inspectionOptions(calls),
      environment,
      platform: "win32",
      enumerateCandidates: () => assert.fail("must not enumerate"),
      readdirImpl: () => assert.fail("must not list directories"),
    }), recorded);
    assert.deepEqual(calls, [["hash", recorded.path]]);
  }
});

test("recorded verification fails closed on changed bytes without refreshing trust", async () => {
  const { recorded, environment } = recordedFixture();
  const calls = [];
  await assert.rejects(verifyRecordedCodexExecutable(recorded, {
    ...inspectionOptions(calls), environment, platform: "win32",
    hashFile: async (file) => { calls.push(["hash", file]); return "B".repeat(64); },
  }), /Recorded Codex executable SHA-256 changed/);
  assert.deepEqual(calls, [["hash", recorded.path]]);
});

test("recorded verification detects actual replacement of the same installed file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-recorded-codex-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "OpenAI", "Codex", "bin", "build", "codex.exe");
  const contents = "synthetic trusted bytes; never executed";
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, contents, "utf8");
  const { recorded } = recordedFixture();
  const identity = { ...recorded, path: executable, sha256: createHash("sha256").update(contents).digest("hex").toUpperCase() };
  const options = { environment: { LOCALAPPDATA: root }, platform: "win32", inspectBundle: async () => null };
  assert.equal(await verifyRecordedCodexExecutable(identity, options), identity);
  await writeFile(executable, "replacement bytes; never executed", "utf8");
  await assert.rejects(verifyRecordedCodexExecutable(identity, options), /Recorded Codex executable SHA-256 changed/);
});

test("recorded verification rejects redirected paths even with identical bytes", async () => {
  const { recorded, descriptor, environment } = recordedFixture();
  for (const destination of [path.join(descriptor.installRoot, "other", "codex.exe"), path.resolve("outside", "codex.exe")]) {
    const calls = [];
    await assert.rejects(verifyRecordedCodexExecutable(recorded, {
      ...inspectionOptions(calls), environment, platform: "win32",
      realpathImpl: async (file) => file === recorded.path ? destination : file,
    }), /canonical path changed|escapes its official install root/);
    assert.deepEqual(calls, []);
  }
});

test("recorded verification checks source, official filename and full layout", async () => {
  for (const source of ["desktop", "vscode", "vscode-insiders"]) {
    const { recorded, descriptor, environment } = recordedFixture(source);
    const invalidPaths = [
      path.join(path.dirname(recorded.path), "other.exe"),
      path.join(path.dirname(recorded.path), "nested", "codex.exe"),
      path.join(descriptor.installRoot, "codex.exe"),
      path.resolve("outside", "build", "codex.exe"),
      ...(source === "desktop" ? [] : [
        path.join(descriptor.installRoot, "lookalike-2", "bin", "windows-x86_64", "codex.exe"),
        path.join(descriptor.installRoot, "openai.chatgpt-2", "bin", "windows-arm64", "codex.exe"),
      ]),
    ];
    for (const pathname of invalidPaths) {
      const calls = [];
      await assert.rejects(verifyRecordedCodexExecutable({ ...recorded, path: pathname }, {
        ...inspectionOptions(calls), environment, platform: "win32",
      }), /official install (?:layout|root)/);
      assert.deepEqual(calls, []);
    }
    await assert.rejects(verifyRecordedCodexExecutable({ ...recorded, source: source === "desktop" ? "vscode" : "desktop" }, {
      ...inspectionOptions([]), environment, platform: "win32",
    }), /official install (?:root|layout)/);
  }
});

test("recorded verification uses the canonical official root and rejects its replacement", async () => {
  const { recorded, descriptor, environment } = recordedFixture();
  const canonicalRoot = path.resolve("canonical-official");
  const calls = [];
  const options = {
    ...inspectionOptions(calls), environment, platform: "win32",
    realpathImpl: async (file) => file === descriptor.installRoot ? canonicalRoot : file,
  };
  await assert.rejects(verifyRecordedCodexExecutable(recorded, options), /escapes its official install root/);
  assert.deepEqual(calls, []);
  const canonicalRecorded = { ...recorded, path: path.join(canonicalRoot, "build", "codex.exe") };
  assert.equal(await verifyRecordedCodexExecutable(canonicalRecorded, options), canonicalRecorded);
  assert.deepEqual(calls, [["hash", canonicalRecorded.path]]);
});

test("recorded verification rejects malformed trust records, non-files and non-Windows use", async () => {
  const { recorded, environment } = recordedFixture();
  const calls = [];
  const options = { ...inspectionOptions(calls), environment, platform: "win32" };
  for (const changes of [
    { publisher: 'CN="Lookalike"' }, { publisher: "" }, { version: "invalid" },
    { sha256: "invalid" }, { source: "manual-override" }, { path: "relative/codex.exe" },
    { signatureStatus: "NotTrusted" },
  ]) {
    await assert.rejects(verifyRecordedCodexExecutable({ ...recorded, ...changes }, options), /identity is invalid/);
  }
  await assert.rejects(verifyRecordedCodexExecutable(recorded, { ...options, platform: "linux" }), /Windows-only/);
  await assert.rejects(verifyRecordedCodexExecutable(recorded, {
    ...options, statImpl: async () => ({ isFile: () => false }),
  }), /candidate is not a file/);
  assert.deepEqual(calls, []);
});

test("discovery reuses trusted canonical path, source and bytes without signature or version processes", async () => {
  const { recorded, descriptor } = recordedFixture();
  const calls = [];
  const result = await discoverOfficialCodexExecutables({
    ...inspectionOptions(calls), platform: "win32", trustedCandidates: [recorded],
    enumerateCandidates: async () => [descriptor],
  });
  assert.deepEqual(result, { candidates: [recorded], rejected: [] });
  assert.deepEqual(calls, [["hash", recorded.path]]);
});

test("changed cached bytes take the full signature and version inspection path", async () => {
  const { recorded, descriptor } = recordedFixture();
  const calls = [];
  const result = await inspectOfficialCodexCandidate(descriptor, {
    ...inspectionOptions(calls), trustedCandidates: [recorded],
    hashFile: async (file) => { calls.push(["hash", file]); return "B".repeat(64); },
  });
  assert.equal(result.sha256, "B".repeat(64));
  assert.deepEqual(calls, ["hash", "signature", "hash", "version", "hash"].map((step) => [step, recorded.path]));
});

test("unmatched or invalid cached identities never bypass full inspection", async () => {
  const { recorded, descriptor } = recordedFixture();
  for (const changes of [
    { publisher: 'CN="Lookalike"' }, { version: "invalid" }, { signatureStatus: "NotTrusted" },
    { source: "vscode" }, { path: path.join(descriptor.installRoot, "other", "codex.exe") },
  ]) {
    const calls = [];
    await inspectOfficialCodexCandidate(descriptor, {
      ...inspectionOptions(calls), trustedCandidates: [{ ...recorded, ...changes }],
    });
    assert.deepEqual(calls, ["hash", "signature", "hash", "version", "hash"].map((step) => [step, recorded.path]));
  }
});

test("cached identities do not bypass canonical root or file checks", async () => {
  const { recorded, descriptor } = recordedFixture();
  const calls = [];
  const options = { ...inspectionOptions(calls), trustedCandidates: [recorded] };
  await assert.rejects(inspectOfficialCodexCandidate({ ...descriptor, installRoot: path.resolve("other-root") }, options), /escapes its official install root/);
  await assert.rejects(inspectOfficialCodexCandidate(descriptor, {
    ...options, statImpl: async () => ({ isFile: () => false }),
  }), /candidate is not a file/);
  assert.deepEqual(calls, []);
});
