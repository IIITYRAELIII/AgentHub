import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function resolver() {
  const source = await readFile(
    new URL("../../assets/web-app/background-image-resolver.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubBackgroundImageResolver;
}

test("selected theme scene keeps overlays and receives its canonical image URL", async () => {
  const { resolve } = await resolver();
  const background = [
    "linear-gradient(rgb(255 255 255 / 14%), transparent)",
    "radial-gradient(transparent, rgb(132 147 166 / 15%))",
    'url("./bespin-skybridge.jpg")',
  ].join(", ");

  assert.equal(
    resolve(background, 'url("/themes/bespin/bespin-skybridge.jpg")'),
    [
      "linear-gradient(rgb(255 255 255 / 14%), transparent)",
      "radial-gradient(transparent, rgb(132 147 166 / 15%))",
      'url("/themes/bespin/bespin-skybridge.jpg")',
    ].join(", "),
  );
});

test("decoded Worker background uses its Blob URL and invalid input stays unchanged", async () => {
  const { resolve } = await resolver();
  assert.equal(
    resolve('linear-gradient(#0000, #000), url("./scene.jpg")', 'url("blob:https://hub.example/scene")'),
    'linear-gradient(#0000, #000), url("blob:https://hub.example/scene")',
  );
  assert.equal(resolve("linear-gradient(#fff, #000)", 'url("/scene.jpg")'), "linear-gradient(#fff, #000)");
});
