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

test("вкладка потока показывает его состояние, а не просто самую свежую задачу", () => {
  // У потока обычно несколько задач по числу Thread. Идущий ход часто не самый
  // свежий по lastActivity, поэтому выбор только по времени приводил к вкладке
  // без признака работы при работающем потоке. Правая панель в это же время
  // показывала поток активным, потому что сортирует сначала по состоянию.
  assert.match(
    appSource,
    /function representativeStreamTask\(stream\) \{[\s\S]*?const attention = \(task\) => \(task\?\.unread && !task\?\.running \? 0 : task\?\.running \? 1 : 2\);/u,
  );
  assert.match(
    appSource,
    /function representativeStreamTask\(stream\) \{[\s\S]*?attention\(left\) - attention\(right\)\s*\|\| Date\.parse\(right\.lastActivity \|\| 0\) - Date\.parse\(left\.lastActivity \|\| 0\)/u,
  );
});
