import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCatalogProjectionService } from "../../../src/providers/provider-catalog-services.mjs";

test("Claude catalog projection keeps provider identity separate from stream identity", async () => {
  const service = new ClaudeCatalogProjectionService({
    audit: async () => {},
    findProject: () => ({ path: "D:/Work" }),
    applyManagedCancellation: (snapshot) => snapshot,
    catalogEntry: (snapshot, project) => ({
      provider: "claude", threadId: snapshot.sessionId, streamId: snapshot.streamId, projectRoot: project.path,
    }),
  });
  const entries = await service.project([{ sessionId: "session-1", streamId: "stream-1", cwd: "D:/Work" }]);
  assert.equal(entries[0].streamId, "stream-1");
  assert.equal(entries[0].threadId, "session-1");
  assert.equal(entries[0].titleAuthoritative, true);
});
