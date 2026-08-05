import assert from "node:assert/strict";
import test from "node:test";

import { relativeModuleSpecifiers } from "./src/infrastructure/filesystem/module-import-specifiers.mjs";

test("relativeModuleSpecifiers finds static, exported and dynamic module edges", () => {
  assert.deepEqual(relativeModuleSpecifiers(`
    import value from "./static.mjs";
    import "./side-effect.mjs";
    export { other } from "../exported.mjs";
    const lazy = import("./dynamic.mjs");
    import packageValue from "external-package";
    import builtIn from "node:path";
  `), [
    "./static.mjs",
    "./side-effect.mjs",
    "../exported.mjs",
    "./dynamic.mjs",
  ]);
});

test("relativeModuleSpecifiers deduplicates repeated edges", () => {
  assert.deepEqual(relativeModuleSpecifiers(`
    import "./same.mjs";
    export { value } from "./same.mjs";
    await import("./same.mjs");
  `), ["./same.mjs"]);
});
