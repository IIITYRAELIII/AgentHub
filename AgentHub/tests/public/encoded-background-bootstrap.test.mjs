import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("encoded backgrounds suppress relative CSS fallback until decoded while direct assets remain canonical", async () => {
  const source = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
  const properties = new Map();
  const catalog = [{
    id: "orbit", color: "#000", assets: { texture: "/themes/orbit/texture.png" },
    backgrounds: [
      { id: "nexus", name: "Encoded", assetUrl: "/themes/nexus/interweave.png.json" },
      { id: "encoded-query", name: "Encoded query", assetUrl: "https://hub.example/image.json?v=1" },
      { id: "direct", name: "Direct", assetUrl: "/themes/orbit/direct.png" },
    ],
  }];
  const context = {
    document: { querySelector: () => ({ textContent: JSON.stringify(catalog) }) },
    root: { style: { setProperty: (name, value) => properties.set(name, value) } },
  };
  // Execute the shipped catalog/bootstrap boundary, without starting chat or network owners.
  vm.runInNewContext(source.slice(source.indexOf("function readThemeCatalog()"),
    source.indexOf("const deferredBackgroundAssets")), context);
  assert.equal(properties.get("--nexus-image"), "none");
  assert.equal(properties.get("--encoded-query-image"), "none");
  assert.equal(properties.get("--direct-image"), 'url("/themes/orbit/direct.png")');
  assert.equal(properties.get("--orbit-texture-asset"), 'url("/themes/orbit/texture.png")');
});
