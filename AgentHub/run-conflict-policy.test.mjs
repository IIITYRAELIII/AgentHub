import assert from "node:assert/strict";
import test from "node:test";

import { RunConflictPolicy } from "./src/application/run-conflict-policy.mjs";

test("run conflict policy combines managed and externally active repository users", async () => {
  let discoveries = 0;
  const conflict = { taskTitle: "Other" };
  const policy = new RunConflictPolicy({
    enabled: () => true,
    resolveRepoRoots: async () => { discoveries += 1; return ["D:/Repo"]; },
    taskCatalog: async () => [{ projectRoot: "D:/Other", running: true, gitBaseline: { repoRoot: "D:/Repo" } }],
    activeRuns: () => [{ projectRoot: "D:/Managed", gitBaseline: { repositories: [{ repoRoot: "D:/Repo" }] } }],
    findConflict: (_target, roots, candidates) => {
      assert.deepEqual(roots, ["D:/Repo"]);
      assert.equal(candidates.length, 2);
      return conflict;
    },
  });

  assert.equal(await policy.check({ projectRoot: "D:/Work" }), conflict);
  assert.equal(await policy.check({ projectRoot: "D:/Work" }), conflict);
  assert.equal(discoveries, 1);
});

test("run conflict policy skips repository work when the guard is disabled", async () => {
  const policy = new RunConflictPolicy({
    enabled: () => false,
    resolveRepoRoots: async () => { throw new Error("must not run"); },
    taskCatalog: async () => [], activeRuns: () => [], findConflict: () => null,
  });
  assert.equal(await policy.check({ projectRoot: "D:/Work" }), null);
});
