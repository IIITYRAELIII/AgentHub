import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hubClientSource = await readFile(
  new URL("../../assets/web-app/hub-client.js", import.meta.url),
  "utf8",
);

test("dashboard waits for the new runtime instead of calling the broken legacy move", () => {
  assert.match(
    hubClientSource,
    /!lastSnapshot\?\.boardLayout && \["move-column", "update-comment"\]\.includes\(detail\.type\)/u,
  );
  assert.doesNotMatch(hubClientSource, /action = "board-workspace-move"/u);
});

test("every Task open carries the exact v4 snapshot baseline", () => {
  assert.equal([
    ...hubClientSource.matchAll(
      /control\("open-task", taskOpenParams\(/gu,
    ),
  ].length, 6);
  assert.doesNotMatch(hubClientSource, /control\("open-task", \{/u);
  assert.match(
    hubClientSource,
    /AgentHubSnapshotTransport\.openTaskRequestParams\(lastSnapshot, identity, params\)/u,
  );
  assert.match(hubClientSource, /result\?\.snapshot\?\.notModified !== true/u);
  assert.match(hubClientSource, /AgentHubSnapshotTransport\.isBaselineError\(error\)/u);
});
