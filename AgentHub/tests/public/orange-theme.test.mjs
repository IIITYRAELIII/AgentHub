import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { loadThemeRegistry } = require("../../theme-registry.cjs");

async function orangeFocusApi() {
  const source = await readFile(
    new URL("../../assets/mini-app/themes/orange/focus-mode.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubOrangeFocus;
}

function normalizeHex(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/u.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  if (/^#[0-9a-f]{6}$/u.test(trimmed)) return trimmed;
  throw new Error(`Ожидался hex-цвет, получено: ${value}`);
}

function relativeLuminance(hexColor) {
  const hex = normalizeHex(hexColor).slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssVariables(css, selector) {
  const normalizedCss = css.replace(/\r\n?/gu, "\n");
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = normalizedCss.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(match?.groups?.body, `CSS-блок не найден: ${selector}`);
  return Object.fromEntries(
    [...match.groups.body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/giu)].map(([, name, value]) => [
      `--${name}`,
      value.trim(),
    ]),
  );
}

function assertContrast({ foreground, background, minimum = 4.5, label }) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label}: ${normalizeHex(foreground)} on ${normalizeHex(background)} = ${ratio.toFixed(2)}:1, expected >= ${minimum}:1`,
  );
}

test("orange theme is discovered with its focus-mode resource", () => {
  const registry = loadThemeRegistry(fileURLToPath(new URL("../../assets/mini-app", import.meta.url)));
  const theme = registry.themes.find((item) => item.id === "orange");
  assert.equal(theme?.name, "Апельсин");
  assert.deepEqual(theme?.scripts, ["focus-mode.js"]);
  assert.equal(registry.resources.has("/themes/orange/theme.css"), true);
  assert.equal(registry.resources.has("/themes/orange/focus-mode.js"), true);
});

test("orange theme text roles meet the AA contrast contract", async () => {
  // The theme is shipped as CSS custom properties consumed by multiple shells.
  // There is no browser CSSOM in the current unit harness, so this test treats
  // the published theme variables as the executable accessibility contract.
  const css = await readFile(new URL("../../assets/mini-app/themes/orange/theme.css", import.meta.url), "utf8");
  const root = parseCssVariables(css, 'html[data-theme="orange"]');
  const dark = {
    ...root,
    ...parseCssVariables(css, 'html[data-theme="orange"] .app-header,\nhtml[data-theme="orange"] .task-rail'),
  };

  const rootTextRoles = [
    "--text",
    "--text-soft",
    "--text-muted",
    "--text-faint",
    "--accent",
    "--warning",
    "--ok",
    "--pending",
  ];
  const rootBackgrounds = [
    ["--bg", root["--bg"]],
    ["--surface-1", root["--surface-1"]],
    ["--surface-2", root["--surface-2"]],
    ["--surface-3", root["--surface-3"]],
    ["--sunken", root["--sunken"]],
    ["--card-bg", root["--card-bg"]],
    ["--activity-rail", "#eee4d8"],
  ];
  for (const role of rootTextRoles) {
    for (const [backgroundName, background] of rootBackgrounds) {
      assertContrast({
        foreground: root[role],
        background,
        label: `orange root ${role} on ${backgroundName}`,
      });
    }
  }

  const darkTextRoles = ["--text", "--text-soft", "--text-muted", "--text-faint", "--accent", "--ok", "--pending"];
  const darkBackgrounds = [
    ["--surface-1", dark["--surface-1"]],
    ["--surface-2", dark["--surface-2"]],
    ["--surface-3", dark["--surface-3"]],
    ["--accent-soft", dark["--accent-soft"]],
  ];
  for (const role of darkTextRoles) {
    for (const [backgroundName, background] of darkBackgrounds) {
      assertContrast({
        foreground: dark[role],
        background,
        label: `orange dark ${role} on ${backgroundName}`,
      });
    }
  }

  assertContrast({
    foreground: "#fffaf5",
    background: "#bf4822",
    label: "orange selected workspace text",
  });
  assertContrast({
    foreground: "#fff1d5",
    background: "#bf4822",
    label: "orange selected workspace activity text",
  });
  assertContrast({
    foreground: "#fff",
    background: "#bf4822",
    label: "orange primary button text",
  });

  for (const role of ["--comparison-local", "--comparison-deviation", "--comparison-cost"]) {
    for (const [backgroundName, background] of [["--bg", root["--bg"]], ["--surface-1", root["--surface-1"]]]) {
      assertContrast({
        foreground: root[role],
        background,
        label: `orange chart ${role} on ${backgroundName}`,
        minimum: 3,
      });
    }
  }
});

test("orange focus defaults on, persists, and only applies inside the orange theme", async () => {
  const { STORAGE_KEY, apply, persist, stored } = await orangeFocusApi();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };
  const attributes = new Map();
  const toggle = {
    hidden: true,
    setAttribute: (name, value) => attributes.set(name, value),
  };

  assert.equal(stored(storage), true);
  assert.equal(apply(root, toggle, "graphite", true), false);
  assert.equal(root.dataset.focusMode, undefined);
  assert.equal(toggle.hidden, true);

  assert.equal(apply(root, toggle, "orange", true), true);
  assert.equal(root.dataset.focusMode, "true");
  assert.equal(toggle.hidden, false);
  assert.equal(attributes.get("aria-pressed"), "true");

  assert.equal(persist(storage, false), false);
  assert.equal(values.get(STORAGE_KEY), "false");
  assert.equal(stored(storage), false);
  assert.equal(apply(root, toggle, "orange", false), false);
  assert.equal(root.dataset.focusMode, undefined);
  assert.equal(attributes.get("aria-pressed"), "false");
});

test("orange focus keeps the main menu and draws one selected Stream border", async () => {
  const shellCss = await readFile(new URL("../../assets/mini-app/styles.css", import.meta.url), "utf8");
  const focusBlock = shellCss.match(
    /html\[data-focus-mode="true"\][\s\S]*?\.brand-text\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/u,
  )?.[0] ?? "";
  assert.doesNotMatch(focusBlock, /\.view-switch/u);
  assert.match(
    shellCss,
    /\.stream-tab\[aria-pressed="true"\]\s+\.stream-tab-card\s*\{\s*border-color:\s*transparent\s*!important;/u,
  );
  assert.match(
    shellCss,
    /\.stream-tab\[aria-pressed="true"\]:focus-visible\s*\{\s*outline:\s*none\s*!important;/u,
  );
});
