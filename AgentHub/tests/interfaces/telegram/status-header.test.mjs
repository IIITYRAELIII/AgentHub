import assert from "node:assert/strict";
import test from "node:test";
import {
  randomStatusHeaderFileName,
  statusHeaderGroup,
} from "../../../src/interfaces/telegram/status-header.mjs";

test("status header follows the selected provider when one agent is active", () => {
  assert.equal(statusHeaderGroup("codex", ["codex"]), "codex");
  assert.equal(statusHeaderGroup("claude", ["claude"]), "claude");
  assert.equal(randomStatusHeaderFileName("codex", [], () => 0), "codex-header-01.png");
  assert.equal(randomStatusHeaderFileName("codex", [], () => 0.999), "codex-header-07.png");
  assert.equal(randomStatusHeaderFileName("claude", [], () => 0.999), "claude-header-07.png");
});

test("status header uses a shared variant while both agents have active tasks", () => {
  const activeProviders = ["claude", "codex"];
  assert.equal(statusHeaderGroup("codex", activeProviders), "both");
  assert.equal(randomStatusHeaderFileName("claude", activeProviders, () => 0), "both-header-01.png");
  assert.equal(randomStatusHeaderFileName("codex", activeProviders, () => 0.999), "both-header-03.png");
});
