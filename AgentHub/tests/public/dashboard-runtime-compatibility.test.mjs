import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hubClientSource = await readFile(
  new URL("../../assets/mini-app/hub-client.js", import.meta.url),
  "utf8",
);

test("dashboard waits for the new runtime instead of calling the broken legacy move", () => {
  assert.match(
    hubClientSource,
    /!lastSnapshot\?\.boardLayout && \["move-column", "update-comment"\]\.includes\(detail\.type\)/u,
  );
  assert.doesNotMatch(hubClientSource, /action = "board-workspace-move"/u);
});
