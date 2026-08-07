import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = require("../../theme-registry.cjs");

async function fixture(manifest) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-themes-"));
  const theme = path.join(directory, "themes", "aurora");
  await mkdir(theme, { recursive: true });
  await Promise.all([
    writeFile(path.join(theme, "theme.json"), JSON.stringify(manifest), "utf8"),
    writeFile(path.join(theme, "theme.css"), 'html[data-theme="aurora"]{}', "utf8"),
    writeFile(path.join(theme, "effect.js"), 'document.documentElement.dataset.effect = "aurora";', "utf8"),
    writeFile(path.join(theme, "theme.html"), "<canvas data-aurora></canvas>", "utf8"),
    writeFile(path.join(theme, "sky.webp"), Buffer.from([1, 2, 3])),
  ]);
  return directory;
}

const manifest = {
  id: "aurora",
  name: "Аврора",
  color: "#112233",
  order: 10,
  styles: "theme.css",
  scripts: "effect.js",
  markup: "theme.html",
  backgrounds: [{ id: "aurora", name: "Сияние", asset: "sky.webp" }],
};

test("theme registry discovers a complete theme package without core registration", async () => {
  const directory = await fixture(manifest);
  try {
    const registry = loadThemeRegistry(directory);
    assert.deepEqual(registry.themes.map((theme) => theme.id), ["aurora"]);
    assert.deepEqual(
      [...registry.resources.keys()].sort(),
      [
        "/themes/aurora/effect.js",
        "/themes/aurora/sky.webp",
        "/themes/aurora/theme.css",
        "/themes/aurora/theme.html",
      ],
    );
    assert.equal(registry.resources.get("/themes/aurora/sky.webp").contentType, "image/webp");
    assert.equal(registry.resources.get("/themes/aurora/sky.webp").immutable, true);
    const html = renderThemeHtml(`
      <!-- agent-hub-theme-styles -->
      <select data-theme-select></select>
      <div>
        <!-- agent-hub-theme-markup -->
      </div>
      <!-- agent-hub-theme-catalog -->
      <!-- agent-hub-theme-scripts -->
    `, registry);
    assert.match(html, /href="\/themes\/aurora\/theme\.css"/u);
    assert.match(html, /<option value="aurora">Аврора<\/option>/u);
    assert.match(html, /<canvas data-aurora><\/canvas>/u);
    assert.match(html, /src="\/themes\/aurora\/effect\.js"/u);
    assert.match(html, /"assetUrl":"\/themes\/aurora\/sky\.webp"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("theme registry rejects a manifest that escapes its package", async () => {
  const directory = await fixture({ ...manifest, styles: "../styles.css" });
  try {
    assert.throws(() => loadThemeRegistry(directory), /invalid style path/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("theme registry rejects attempts to replace the shell-owned brand mark", async () => {
  const directory = await fixture(manifest);
  try {
    const theme = path.join(directory, "themes", "aurora");
    const stylesheet = path.join(theme, "theme.css");
    const script = path.join(theme, "effect.js");
    const markup = path.join(theme, "theme.html");
    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] .brand-mark { filter: hue-rotate(90deg); }',
      "utf8",
    );
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.css references the shell-owned Agent Hub mark/iu,
    );

    await writeFile(stylesheet, 'html[data-theme="aurora"]{}', "utf8");
    await writeFile(script, 'document.querySelector("[data-app-mark]")?.remove();', "utf8");
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: effect\.js references the shell-owned Agent Hub mark/iu,
    );

    await writeFile(script, 'document.documentElement.dataset.effect = "aurora";', "utf8");
    await writeFile(markup, '<img src="agent-hub-mark.png">', "utf8");
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.html references the shell-owned Agent Hub mark/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("theme registry keeps top-panel geometry under shell ownership", async () => {
  const directory = await fixture(manifest);
  try {
    const stylesheet = path.join(directory, "themes", "aurora", "theme.css");
    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] .app-header { padding-block: 1rem !important; }',
      "utf8",
    );
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.css overrides shell-owned top-panel geometry/iu,
    );

    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] .workspace { padding-top: 2rem !important; }',
      "utf8",
    );
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.css overrides shell-owned top-panel geometry/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
