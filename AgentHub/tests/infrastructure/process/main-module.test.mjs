import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../../../src/infrastructure/process/main-module.mjs";

test("main module detection accepts the directly invoked module", () => {
  const modulePath = path.resolve("src/infrastructure/process/main-module.mjs");
  assert.equal(isMainModule(pathToFileURL(modulePath), modulePath), true);
});

test("main module detection resolves a Windows junction before comparing paths", () => {
  const physical = "D:\\VSC_Tyrael\\Utilities\\AgentHub\\runtime-manager.mjs";
  const junction = "C:\\Users\\test\\Documents\\VSC_Tyrael\\Utilities\\AgentHub\\runtime-manager.mjs";
  const realpathImpl = (value) => (
    String(value).toLowerCase() === junction.toLowerCase() ? physical : value
  );
  assert.equal(isMainModule(pathToFileURL(physical), junction, {
    platform: "win32",
    realpathImpl,
  }), true);
});

test("main module detection rejects a different entry point", () => {
  const modulePath = path.resolve("src/infrastructure/process/main-module.mjs");
  assert.equal(isMainModule(pathToFileURL(modulePath), path.resolve("other.mjs")), false);
});
