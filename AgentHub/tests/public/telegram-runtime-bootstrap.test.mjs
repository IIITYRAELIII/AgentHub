import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const SOURCE = await readFile(
  path.resolve(import.meta.dirname, "../../assets/web-app/telegram-runtime-bootstrap.js"),
  "utf8",
);

function executeBootstrap({ hash = "", search = "", bridge = false, readyState = "loading", repeats = 1 } = {}) {
  const writes = [];
  const window = { location: { hash, search } };
  if (bridge) window.TelegramWebviewProxy = {};
  const context = vm.createContext({
    document: { readyState, write: (value) => writes.push(value) },
    Set,
    URLSearchParams,
    window,
  });
  for (let index = 0; index < repeats; index += 1) vm.runInContext(SOURCE, context);
  return { window, writes };
}

test("ordinary browser routes do not request the third-party Telegram runtime", () => {
  for (const hash of ["", "#/chat/stream/71a12aa8-45c2-456e-8d1f-2d22f4a504a4"]) {
    const result = executeBootstrap({ hash });
    assert.deepEqual(result.writes, []);
    assert.equal(result.window.AgentHubTelegramRuntimeRequested, undefined);
  }
});

test("Telegram launch evidence loads the runtime before deferred app scripts", () => {
  for (const launch of [
    { hash: "#tgWebAppData=signed&tgWebAppVersion=9.1&tgWebAppPlatform=android" },
    { search: "?tgWebAppData=signed&tgWebAppPlatform=tdesktop" },
    { bridge: true },
  ]) {
    const result = executeBootstrap(launch);
    assert.deepEqual(result.writes, [
      '<script src="https://telegram.org/js/telegram-web-app.js?63"></script>',
    ]);
    assert.equal(result.window.AgentHubTelegramRuntimeRequested, true);
  }
});

test("Telegram bootstrap is idempotent and cannot replace an already parsed document", () => {
  assert.equal(executeBootstrap({ bridge: true, repeats: 2 }).writes.length, 1);
  assert.deepEqual(executeBootstrap({ bridge: true, readyState: "complete" }).writes, []);
});
