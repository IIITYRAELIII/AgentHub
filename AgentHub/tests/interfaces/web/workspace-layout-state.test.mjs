import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
