import assert from "node:assert/strict";
import test from "node:test";
import { ProviderTaskCatalogBuilder } from "../../../src/providers/provider-task-catalog-builder.mjs";

test("provider catalog discovers sources in parallel and projects them in stable order", async () => {
  const events = [];
  let releaseFirst;
  const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
  const builder = new ProviderTaskCatalogBuilder({
    durableEntries: () => [{ id: "durable" }],
    sources: [
      {
        name: "Codex",
        discover: async () => {
          events.push("codex:discover");
          await firstReady;
          return [{ id: "codex" }];
        },
        toEntries: (entries) => {
          events.push("codex:project");
          return entries;
        },
      },
      {
        name: "Claude",
        discover: async () => {
          events.push("claude:discover");
          releaseFirst();
          return [{ id: "claude" }];
        },
        toEntries: (entries) => {
          events.push("claude:project");
          return entries;
        },
      },
    ],
    managedRuns: () => [{ id: "run" }],
    merge: (entries, runs) => [...entries, ...runs],
  });
  assert.deepEqual((await builder.build()).map((entry) => entry.id), [
    "durable", "codex", "claude", "run",
  ]);
  assert.deepEqual(events, [
    "codex:discover", "claude:discover", "codex:project", "claude:project",
  ]);
});

test("provider catalog preserves durable entries when one source fails", async () => {
  const errors = [];
  const builder = new ProviderTaskCatalogBuilder({
    durableEntries: () => [{ id: "durable" }],
    sources: [
      { name: "Codex", discover: async () => { throw new Error("offline"); } },
      { name: "Claude", discover: () => [{ id: "claude" }] },
    ],
    merge: (entries) => entries,
    onSourceError: (result) => errors.push(`${result.name}:${result.reason.message}`),
  });
  assert.deepEqual(await builder.build(), [{ id: "durable" }, { id: "claude" }]);
  assert.deepEqual(errors, ["Codex:offline"]);
});

test("provider catalog isolates projection failure and finalizes the merged view", async () => {
  const sourceResults = [];
  const builder = new ProviderTaskCatalogBuilder({
    durableEntries: () => [],
    sources: [
      {
        name: "Codex",
        discover: () => [1],
        toEntries: () => { throw new Error("bad projection"); },
      },
      { name: "Claude", discover: () => [{ id: "claude" }] },
    ],
    managedRuns: () => [{ id: "run" }],
    merge: (entries, runs) => [...entries, ...runs],
    finalize: (entries, context) => {
      sourceResults.push(...context.sourceResults);
      return entries.map((entry) => ({ ...entry, finalized: true }));
    },
  });
  assert.deepEqual(await builder.build(), [
    { id: "claude", finalized: true },
    { id: "run", finalized: true },
  ]);
  assert.deepEqual(sourceResults.map(({ name, status }) => ({ name, status })), [
    { name: "Codex", status: "rejected" },
    { name: "Claude", status: "fulfilled" },
  ]);
});

test("provider catalog rejects malformed dependency results", async () => {
  await assert.rejects(new ProviderTaskCatalogBuilder({
    durableEntries: () => null,
    merge: (entries) => entries,
  }).build(), /durableEntries must return an array/u);
  assert.throws(() => new ProviderTaskCatalogBuilder({
    durableEntries: () => [],
    sources: [{ name: "Codex" }],
    merge: (entries) => entries,
  }), /Codex\.discover is required/u);
});
