import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCatalogProjectionService } from "./src/providers/provider-catalog-services.mjs";

test("Claude catalog projection keeps provider identity separate from hub task identity", async () => {
  const service = new ClaudeCatalogProjectionService({
    audit: async () => {},
    findProject: () => ({ path: "D:/Work" }),
    applyManagedCancellation: (snapshot) => snapshot,
    catalogEntry: (snapshot, project) => ({
      provider: "claude", threadId: snapshot.sessionId, hubTaskId: snapshot.hubTaskId, projectRoot: project.path,
    }),
  });
  const entries = await service.project([{ sessionId: "session-1", hubTaskId: "hub-1", cwd: "D:/Work" }]);
  assert.equal(entries[0].hubTaskId, "hub-1");
  assert.equal(entries[0].threadId, "session-1");
  assert.equal(entries[0].titleAuthoritative, true);
});
