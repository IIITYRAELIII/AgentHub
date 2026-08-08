import test from "node:test";
import assert from "node:assert/strict";

import { taskDisplayTitle } from "../../src/domain/task-display-title.mjs";

test("task display title uses Workspace and named Stream", () => {
  assert.equal(taskDisplayTitle({
    workspaceName: "Agent HUB",
    streamName: "Themes",
    title: "Internal Thread title",
  }), "Agent HUB - Themes");
});

test("task display title derives an unnamed Stream label", () => {
  assert.equal(taskDisplayTitle({
    workspaceName: "FB Цемикс",
    streamId: "stream-2",
    streamOrdinal: 2,
    title: "Internal Thread title",
  }), "FB Цемикс - Stream 2");
});

test("task display title keeps a legacy fallback without Workspace binding", () => {
  assert.equal(taskDisplayTitle({ title: "Legacy Thread" }), "Legacy Thread");
});
