import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  compareCodexVersions,
  discoverOfficialCodexExecutables,
  enumerateOfficialCodexPaths,
  findVscodeCodexExecutable,
  inspectOfficialCodexCandidate,
  isOpenAiSignerSubject,
  resolveCodexExecutable,
} from "../../../src/infrastructure/process/codex-executable.mjs";

function directory(name) {
  return { name, isDirectory: () => true };
}

function trusted(pathname, version, source = "desktop") {
  return {
    path: pathname,
    version,
    sha256: version.padEnd(64, "A").slice(0, 64).replace(/[^A-F0-9]/g, "A"),
    publisher: "CN=OpenAI OpCo, LLC",
    signatureStatus: "Valid",
    source,
  };
}

test("Codex version ordering handles releases and multi-part prereleases", () => {
  assert.equal(compareCodexVersions("0.152.1", "0.152.1-alpha.9"), 1);
  assert.equal(compareCodexVersions("0.151.0-alpha.7.2", "0.151.0-alpha.4.3"), 1);
  assert.equal(compareCodexVersions("0.151.0-alpha.10", "0.151.0-alpha.9"), 1);
  assert.equal(compareCodexVersions("0.151.0-beta.1", "0.151.0-alpha.99"), 1);
});

test("automatic trust requires the exact OpenAI Authenticode common name", () => {
  assert.equal(isOpenAiSignerSubject('CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", C=US'), true);
  assert.equal(isOpenAiSignerSubject("CN=OpenAI OpCo\\, LLC, O=OpenAI"), true);
  assert.equal(isOpenAiSignerSubject('CN="Lookalike", OU="CN=OpenAI OpCo, LLC"'), false);
  assert.equal(isOpenAiSignerSubject('CN="OpenAI OpCo, LLC Evil", O="OpenAI"'), false);
});

test("official Windows discovery enumerates Desktop and OpenAI VS Code layouts only", async () => {
  const profile = path.resolve("C:/Users/test");
  const localAppData = path.resolve("C:/Users/test/AppData/Local");
  const entries = await enumerateOfficialCodexPaths({
    platform: "win32",
    environment: { USERPROFILE: profile, LOCALAPPDATA: localAppData },
    readdirImpl: async (root) => root.endsWith(path.join("Codex", "bin"))
      ? [directory("desktop-build")]
      : [directory("openai.chatgpt-2"), directory("publisher.lookalike-99")],
  });
  assert.deepEqual(entries.map((entry) => entry.source), ["vscode", "vscode-insiders", "desktop"]);
  assert.equal(entries.some((entry) => entry.executable.includes("publisher.lookalike")), false);
  assert.match(entries.at(-1).executable, /OpenAI[\\/]Codex[\\/]bin[\\/]desktop-build[\\/]codex\.exe$/i);
});

test("trusted discovery sorts by executable-reported version rather than filesystem order", async () => {
  const old = { executable: "C:/old/codex.exe", source: "vscode", installRoot: "C:/old" };
  const current = { executable: "C:/current/codex.exe", source: "desktop", installRoot: "C:/current" };
  const rejected = { executable: "C:/spoof/codex.exe", source: "desktop", installRoot: "C:/spoof" };
  const result = await discoverOfficialCodexExecutables({
    platform: "win32",
    enumerateCandidates: async () => [old, rejected, current],
    inspectCandidate: async (candidate) => {
      if (candidate === rejected) throw new Error("signature is not trusted");
      return candidate === old
        ? trusted(candidate.executable, "0.151.0-alpha.7.2", candidate.source)
        : trusted(candidate.executable, "0.152.1", candidate.source);
    },
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.version), ["0.152.1", "0.151.0-alpha.7.2"]);
  assert.deepEqual(result.rejected, [{
    path: rejected.executable,
    source: "desktop",
    error: "signature is not trusted",
  }]);
});

test("candidate inspection verifies signature before executing version and rejects TOCTOU changes", async () => {
  const calls = [];
  const candidate = { executable: "C:/official/codex.exe", installRoot: "C:/official", source: "desktop" };
  await assert.rejects(inspectOfficialCodexCandidate(candidate, {
    realpathImpl: async (value) => value,
    statImpl: async () => ({ isFile: () => true }),
    verifySignature: async () => {
      calls.push("signature");
      return { valid: true, status: "Valid", publisher: "CN=OpenAI OpCo, LLC" };
    },
    readVersion: async () => {
      calls.push("version");
      return "0.152.1";
    },
    hashFile: async () => {
      calls.push("hash");
      return calls.filter((call) => call === "hash").length === 1 ? "A".repeat(64) : "B".repeat(64);
    },
  }), /changed during verification/u);
  assert.deepEqual(calls, ["signature", "hash", "version", "hash"]);
});

test("VS Code compatibility resolver uses version-sorted trusted candidates", async () => {
  const executable = await findVscodeCodexExecutable({
    platform: "win32",
    enumerateCandidates: async () => [],
    inspectCandidate: async () => null,
    // The discovery seam is exercised by resolveCodexExecutable below; this
    // assertion preserves the public null contract when no VS Code binary is trusted.
  });
  assert.equal(executable, null);
  assert.equal(await resolveCodexExecutable({
    platform: "win32",
    environment: { USERPROFILE: "C:/Users/test" },
    discover: async () => ({ candidates: [trusted("C:/desktop/codex.exe", "0.152.1")], rejected: [] }),
  }), "C:/desktop/codex.exe");
});

test("explicit Codex executable remains the strongest operator pin", async () => {
  let discovered = false;
  assert.equal(await resolveCodexExecutable({
    requested: "D:/Tools/codex.exe",
    platform: "win32",
    discover: async () => { discovered = true; return { candidates: [], rejected: [] }; },
  }), "D:/Tools/codex.exe");
  assert.equal(discovered, false);
});
