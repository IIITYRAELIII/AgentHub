import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  localAssetFile,
  localAssetPathname,
  localAssetReferences,
  replaceLocalAssetReference,
} = require("../../client-assets.cjs");

test("shared client asset catalog discovers and rewrites every local shell resource", () => {
  const html = `
    <link href='/styles.css?v=one' rel='stylesheet'>
    <script src="/future-module.js?revision=two"></script>
    <script src="https://example.com/external.js"></script>
    <a href="/chat/stream">chat</a>
    <script src="/future-module.js?revision=two"></script>
  `;
  assert.deepEqual(localAssetReferences(html), [
    "/styles.css?v=one",
    "/future-module.js?revision=two",
  ]);
  assert.equal(localAssetPathname("/future-module.js?revision=two"), "/future-module.js");
  const rewritten = replaceLocalAssetReference(
    html,
    "/future-module.js?revision=two",
    "vscode-resource:/future-module.js",
  );
  assert.equal((rewritten.match(/vscode-resource:\/future-module\.js/gu) ?? []).length, 2);
});

test("shared client asset catalog rejects paths outside the runtime", () => {
  assert.throws(() => localAssetPathname("/%2e%2e/secret.js"), /Некорректный путь/u);
  assert.throws(() => localAssetPathname("//host/script.js"), /Некорректный путь/u);
  assert.throws(() => localAssetFile(path.resolve("runtime"), "/../secret.js"), /Некорректный путь/u);
});
