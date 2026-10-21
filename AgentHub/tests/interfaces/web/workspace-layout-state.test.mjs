import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const appSource = await readFile(new URL("../../../assets/web-app/app.js", import.meta.url), "utf8");

test("workspace layout persists open and active Streams per client", () => {
  assert.match(appSource, /activeStreamByWorkspace:\s*new Map\(\)/u);
  assert.match(appSource, /activeStreamId:\s*state\.activeStreamByWorkspace\.get\(workspaceId\)/u);
  assert.match(appSource, /state\.activeStreamByWorkspace\.set\(workspaceKey\(selected\), streamKey\(selected\)\)/u);
  assert.match(appSource, /const activeStreamId = state\.activeStreamByWorkspace\.get\(workspaceId\);[\s\S]*representativeStreamTask/u);
});

test("moving the active Stream cannot make its previous Workspace unclickable", () => {
  assert.match(appSource, /function representativeStreamTask\(stream\) \{\s*if \(!stream\) return null;/u);
  assert.match(appSource, /if \(!activeStream\) \{\s*state\.activeStreamByWorkspace\.delete\(workspaceId\);\s*persistOpenStreams\(\);/u);
  assert.match(appSource, /selectedTaskLocationChanged[\s\S]*ensureTaskStreamVisible\(current\)/u);
});

test("вкладка потока показывает его состояние, а не просто самую свежую задачу", () => {
  // Execute the production selector: a source regex cannot verify occupancy,
  // exact selection, timestamp ties or that sorting leaves the catalog intact.
  const start = appSource.indexOf("function representativeStreamTask(");
  const end = appSource.indexOf("\nfunction streamActivityTime", start);
  assert.ok(start >= 0 && end > start, "production selector is available");
  const state = { selectedId: "" };
  const sandbox = { state };
  vm.runInNewContext(appSource.slice(start, end), sandbox);
  const select = sandbox.representativeStreamTask;
  const recent = { id: "recent", lastActivity: "2026-10-19T02:00:00Z" };
  const running = { id: "running", running: true, lastActivity: "2026-10-19T01:00:00Z" };
  const unknown = { id: "unknown", activityUnknown: true, lastActivity: "2026-10-19T00:00:00Z" };
  const unread = { id: "unread", unread: true, lastActivity: "2026-10-18T23:00:00Z" };
  assert.equal(select(null), null);
  assert.equal(select({ tasks: [] }), null);
  assert.equal(select({ tasks: [recent, running] }), running);
  assert.equal(select({ tasks: [recent, unknown] }), unknown);
  assert.equal(select({ tasks: [unknown, running] }), running, "same attention uses latest activity");
  assert.equal(select({ tasks: [running, unread] }), unread, "unread final retains attention priority");
  const cleared = { ...unknown, activityUnknown: false };
  assert.equal(select({ tasks: [cleared, recent] }), recent, "cleared occupancy no longer wins");
  const tasks = [recent, running, unknown, unread];
  const before = [...tasks];
  state.selectedId = recent.id;
  assert.equal(select({ tasks }), recent, "explicit exact selection wins over sibling attention");
  assert.deepEqual(tasks, before, "projection must not reorder the source catalog");
});
