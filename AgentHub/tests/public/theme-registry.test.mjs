import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    writeFile(path.join(theme, "texture.webp"), Buffer.from([4, 5, 6])),
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
  assets: { texture: "texture.webp" },
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
        "/themes/aurora/texture.webp",
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
    assert.match(html, /"assets":\{"texture":"\/themes\/aurora\/texture\.webp"\}/u);
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

test("Diablo exposes every scene and stable WebView asset token", () => {
  const root = path.resolve(import.meta.dirname, "../..", "assets", "mini-app");
  const theme = loadThemeRegistry(root).themes.find((item) => item.id === "reliquary");

  assert.equal(theme.name, "Diablo");
  assert.deepEqual(
    theme.backgrounds.map(({ id, name, asset }) => [id, name, asset]),
    [
      ["reliquary", "Забытый портал", "forgotten-waypoint.webp"],
      ["reliquary-reliquary", "Чёрный реликварий", "cinder-reliquary.webp"],
      ["reliquary-cathedral", "Кровавый собор", "blood-cathedral.webp"],
      ["reliquary-archive", "Пепельный архив", "ashen-reliquary.jpg"],
      ["reliquary-seal", "Ледяная печать", "frozen-seal.webp"],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(theme.assets.map(({ id, file }) => [id, file])),
    {
      "basalt-texture": "basalt-texture.webp",
      "iron-texture": "forged-iron-texture.webp",
      "panel-frame": "waypoint-panel-frame.webp",
      "panel-frame-2k": "waypoint-panel-frame-2k-v2.webp",
      "card-frame": "waypoint-card-frame.webp",
      "message-flourish": "message-flourish.webp",
      "stream-divider": "stream-divider.webp",
      "panel-corner-tl": "panel-corner-tl.webp",
      "panel-corner-tr": "panel-corner-tr.webp",
      "panel-corner-bl": "panel-corner-bl.webp",
      "panel-corner-br": "panel-corner-br.webp",
    },
  );
});

test("theme registry rejects root-relative stylesheet assets", async () => {
  const directory = await fixture(manifest);
  try {
    const stylesheet = path.join(directory, "themes", "aurora", "theme.css");
    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] { background: url("/themes/aurora/texture.webp"); }',
      "utf8",
    );
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.css uses root-relative CSS URL \/themes\/aurora\/texture\.webp/iu,
    );
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

    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] .view-tab { border-radius: 999px !important; }',
      "utf8",
    );
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.css overrides shell-owned top-panel geometry/iu,
    );

    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] .stream-tab-card { border: 0 !important; }',
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

test("theme registry keeps system status visibility under shell ownership", async () => {
  const directory = await fixture(manifest);
  try {
    const stylesheet = path.join(directory, "themes", "aurora", "theme.css");
    await writeFile(
      stylesheet,
      'html[data-theme="aurora"] { --shell-connection-banner-display: none; }',
      "utf8",
    );
    assert.throws(
      () => loadThemeRegistry(directory),
      /theme aurora: theme\.css overrides shell-owned system status visibility/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop shell owns and tokenizes the shared header and Stream control shapes", async () => {
  const styles = await readFile(
    new URL("../../assets/mini-app/styles.css", import.meta.url),
    "utf8",
  );
  const gothic = await readFile(
    new URL("../../assets/mini-app/themes/gothic/theme.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /html:not\(\[data-surface="mobile"\]\) \.app-header-inner\s*\{[^}]*max-width:\s*none\s*!important;[^}]*padding-left:\s*var\(--shell-header-padding-left, clamp\(1rem, 4vw, 4\.25rem\)\)\s*!important;[^}]*padding-right:\s*var\(--shell-header-padding-right, clamp\(1rem, 4vw, 4\.25rem\)\)\s*!important;[^}]*width:\s*100%\s*!important;/su,
  );
  assert.match(
    styles,
    /html:not\(\[data-surface="mobile"\]\) \.view-tab\s*\{[^}]*border-radius:\s*var\(--shell-tab-radius, 3px\)\s*!important;/su,
  );
  assert.match(
    styles,
    /html\[data-view="chat"\]:not\(\[data-surface="mobile"\]\) \.stream-tab-card\s*\{[^}]*border-radius:\s*var\(--shell-stream-card-radius, 3px\)\s*!important;/su,
  );
  assert.match(
    styles,
    /html\[data-view="chat"\]:not\(\[data-surface="mobile"\]\) \.task-rail,[\s\S]*?\.chat\s*\{[^}]*border:\s*var\(--shell-panel-border, 1px solid var\(--line\)\)\s*!important;[^}]*border-radius:\s*var\(--shell-panel-radius, 4px\)\s*!important;/u,
  );
  assert.doesNotMatch(
    gothic,
    /html\[data-theme="gothic"\]\s*\{[^}]*--shell-header-padding:\s*0;/su,
  );
  assert.match(
    gothic,
    /@media \(min-width: 860px\)\s*\{[\s\S]*?html\[data-theme="gothic"\]:not\(\[data-surface="mobile"\]\)\s*\{[^}]*--shell-header-padding:\s*0;/u,
  );
  assert.match(gothic, /--shell-header-rule-left:\s*0;/u);
  assert.match(gothic, /--shell-header-rule-right:\s*0;/u);
  assert.match(gothic, /--shell-header-gap:\s*0;/u);
  assert.match(gothic, /--shell-toolbar-align-self:\s*center;/u);
  assert.match(gothic, /--shell-toolbar-margin-top:\s*0;/u);
  assert.match(gothic, /--shell-view-switch-transform:\s*none;/u);
  assert.match(gothic, /body > \.workspace\s*\{[^}]*column-gap:\s*0;/u);
  assert.match(
    gothic,
    /@media \(min-width: 1120px\) \{[\s\S]*?body > \.workspace\s*\{[^}]*padding:\s*0;/u,
  );
  assert.match(gothic, /--shell-tab-active-border:\s*1px solid rgb\(105 100 90 \/ 62%\);/u);
});
