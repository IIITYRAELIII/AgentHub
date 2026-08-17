"use strict";

const fs = require("node:fs");
const path = require("node:path");

const THEME_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CSS_URL_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/giu;
const PROTECTED_BRAND_REFERENCE = /(?:\.brand-mark\b|\[\s*data-app-mark\b|agent-hub-mark)/iu;
const PROTECTED_SHELL_LAYOUT_OVERRIDE = /(?:\.app-header(?:-inner)?(?![A-Za-z0-9_-])|\.workspace(?![A-Za-z0-9_-])|\.view-switch(?![A-Za-z0-9_-])|\.view-tab(?![A-Za-z0-9_-])|\.view-settings(?![A-Za-z0-9_-])|\.task-rail(?![A-Za-z0-9_-])|\.chat(?![A-Za-z0-9_-])|\.stream-tabs(?![A-Za-z0-9_-])|\.stream-tab(?:-card)?(?![A-Za-z0-9_-]))[^{]*\{[^}]*\b(?:background(?:-color|-image)?|border(?:-radius|-width|-style|-color|-top|-right|-bottom|-left)?|box-shadow|flex(?:-basis|-grow|-shrink)?|gap|height|max-height|max-width|min-height|min-width|margin(?:-block|-inline|-top|-right|-bottom|-left)?|padding(?:-block|-inline|-top|-right|-bottom|-left)?|position|top|right|bottom|left|transform|translate|width)\s*:[^;}]*!important/isu;
const PROTECTED_SHELL_STATUS_OVERRIDE = /--shell-connection-banner-display\s*:/iu;
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
]);

function fail(theme, message) {
  throw new Error(`Theme ${theme}: ${message}`);
}

function normalizeRelativeFile(theme, value, kind) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    fail(theme, `invalid ${kind} path ${JSON.stringify(value)}`);
  }
  return normalized;
}

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!SAFE_SEGMENT.test(entry.name)) {
      throw new Error(`Unsafe theme resource name: ${entry.name}`);
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function fileList(theme, value, kind, extension) {
  const values = value == null ? [] : Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const file = normalizeRelativeFile(theme, item, kind);
    if (path.extname(file).toLowerCase() !== extension) {
      fail(theme, `${kind} must use ${extension}: ${file}`);
    }
    return file;
  });
}

function validateThemeResource(theme, directory, file, { allowShellLayoutOverride = false } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (![".css", ".js", ".html"].includes(extension)) return;
  const source = fs.readFileSync(path.join(directory, ...file.split("/")), "utf8");
  if (PROTECTED_BRAND_REFERENCE.test(source)) {
    fail(theme, `${file} references the shell-owned Agent Hub mark`);
  }
  if (
    extension === ".css"
    && !allowShellLayoutOverride
    && PROTECTED_SHELL_LAYOUT_OVERRIDE.test(source)
  ) {
    fail(theme, `${file} overrides shell-owned top-panel geometry`);
  }
  if (extension === ".css" && PROTECTED_SHELL_STATUS_OVERRIDE.test(source)) {
    fail(theme, `${file} overrides shell-owned system status visibility`);
  }
  if (extension === ".css") {
    for (const match of source.matchAll(CSS_URL_REFERENCE)) {
      const reference = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (reference.startsWith("/")) {
        fail(theme, `${file} uses root-relative CSS URL ${reference}`);
      }
    }
  }
}

function loadThemeRegistry(assetsDirectory) {
  const root = path.resolve(assetsDirectory, "themes");
  const themes = [];
  const resources = new Map();
  const backgroundIds = new Set();

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!THEME_ID.test(entry.name)) {
      throw new Error(`Invalid theme directory id: ${entry.name}`);
    }
    const directory = path.join(root, entry.name);
    const manifestFile = path.join(directory, "theme.json");
    if (!fs.existsSync(manifestFile)) fail(entry.name, "theme.json is missing");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    } catch (error) {
      fail(entry.name, `cannot read theme.json: ${error.message}`);
    }
    const id = String(manifest.id ?? "");
    if (id !== entry.name) fail(entry.name, `manifest id must equal directory name`);
    const name = String(manifest.name ?? "").trim();
    if (!name) fail(id, "name is required");
    const color = String(manifest.color ?? "");
    if (!/^#[0-9a-f]{6}$/iu.test(color)) fail(id, "color must be a six-digit hex value");
    const order = Number(manifest.order);
    if (!Number.isSafeInteger(order)) fail(id, "order must be an integer");
    const shellLayout = String(manifest.shellLayout ?? "shared");
    if (!["shared", "custom"].includes(shellLayout)) {
      fail(id, "shellLayout must be shared or custom");
    }
    const styles = fileList(id, manifest.styles ?? "theme.css", "style", ".css");
    const scripts = fileList(id, manifest.scripts, "script", ".js");
    const markup = fileList(id, manifest.markup, "markup", ".html");
    const assets = Object.entries(manifest.assets ?? {}).map(([assetId, value]) => {
      if (!THEME_ID.test(assetId)) fail(id, `asset id ${JSON.stringify(assetId)} is invalid`);
      return {
        id: assetId,
        file: normalizeRelativeFile(id, value, `asset ${assetId}`),
      };
    });
    const aliases = (manifest.aliases ?? []).map((value) => String(value));
    if (aliases.some((alias) => !THEME_ID.test(alias))) fail(id, "aliases must be theme ids");
    const backgrounds = (manifest.backgrounds ?? []).map((background, index) => {
      const backgroundId = String(background?.id ?? "");
      if (!THEME_ID.test(backgroundId)) fail(id, `background ${index + 1} has an invalid id`);
      if (backgroundIds.has(backgroundId)) fail(id, `duplicate background id ${backgroundId}`);
      backgroundIds.add(backgroundId);
      const backgroundName = String(background?.name ?? "").trim();
      if (!backgroundName) fail(id, `background ${backgroundId} needs a name`);
      const asset = background.asset == null
        ? null
        : normalizeRelativeFile(id, background.asset, "background asset");
      const particles = background.particles == null ? null : String(background.particles);
      if (particles != null && !["rain", "downpour", "motes"].includes(particles)) {
        fail(id, `background ${backgroundId} uses unknown particles ${particles}`);
      }
      return {
        id: backgroundId,
        name: backgroundName,
        asset,
        preload: background.preload === true,
        particles,
      };
    });
    if (!backgrounds.length || backgrounds[0].id !== id) {
      fail(id, "the first background must have the same id as the theme");
    }

    const available = new Set(listFiles(directory));
    for (const file of [...styles, ...scripts, ...markup, ...assets.map((item) => item.file), ...backgrounds.map((item) => item.asset).filter(Boolean)]) {
      if (!available.has(file)) fail(id, `declared file is missing: ${file}`);
    }
    for (const file of available) {
      validateThemeResource(id, directory, file, {
        allowShellLayoutOverride: shellLayout === "custom",
      });
    }
    const themeResources = [];
    for (const file of available) {
      if (file === "theme.json" || file.toLowerCase() === "readme.md") continue;
      const extension = path.extname(file).toLowerCase();
      const contentType = CONTENT_TYPES.get(extension);
      if (!contentType) fail(id, `unsupported resource type: ${file}`);
      const pathname = `/themes/${id}/${file}`;
      const resource = {
        pathname,
        file: path.join(directory, ...file.split("/")),
        contentType,
        immutable: ![".css", ".js", ".html"].includes(extension),
      };
      resources.set(pathname, resource);
      themeResources.push(resource);
    }
    themes.push({ id, name, color: color.toLowerCase(), order, shellLayout, aliases, assets, backgrounds, styles, scripts, markup, directory, resources: themeResources });
  }

  themes.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (!themes.length) throw new Error(`No themes found in ${root}`);
  if (new Set(themes.map((theme) => theme.order)).size !== themes.length) {
    throw new Error("Theme order values must be unique");
  }
  const ids = new Set(themes.map((theme) => theme.id));
  for (const theme of themes) {
    for (const alias of theme.aliases) {
      if (ids.has(alias)) fail(theme.id, `alias conflicts with theme id ${alias}`);
      ids.add(alias);
    }
  }
  return { root, themes, resources };
}

function publicThemeCatalog(registry, resourceUrl = (pathname) => pathname) {
  return registry.themes.map((theme) => ({
    id: theme.id,
    name: theme.name,
    color: theme.color,
    aliases: [...theme.aliases],
    assets: Object.fromEntries(theme.assets.map((asset) => [
      asset.id,
      resourceUrl(`/themes/${theme.id}/${asset.file}`),
    ])),
    backgrounds: theme.backgrounds.map((background) => ({
      id: background.id,
      name: background.name,
      particles: background.particles,
      preload: background.preload,
      assetUrl: background.asset
        ? resourceUrl(`/themes/${theme.id}/${background.asset}`)
        : null,
    })),
  }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderThemeHtml(html, registry, {
  resourceUrl = (pathname) => pathname,
  styleContent = null,
  nonce = "",
  revision = () => "",
} = {}) {
  const link = (pathname) => {
    const suffix = revision(pathname);
    return resourceUrl(suffix ? `${pathname}?v=${suffix}` : pathname);
  };
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  const styles = registry.themes.flatMap((theme) => theme.styles.map((file) => {
    const pathname = `/themes/${theme.id}/${file}`;
    const content = typeof styleContent === "function" ? styleContent(pathname) : null;
    if (content != null) {
      const safeContent = String(content).replaceAll("</style", "<\\/style");
      return `  <style data-agent-hub-theme="${escapeHtml(theme.id)}"${nonceAttribute}>${safeContent}</style>`;
    }
    return `  <link rel="stylesheet" href="${escapeHtml(link(pathname))}">`;
  })).join("\n");
  const scripts = registry.themes.flatMap((theme) => theme.scripts.map((file) => {
    const pathname = `/themes/${theme.id}/${file}`;
    return `  <script src="${escapeHtml(link(pathname))}" defer></script>`;
  })).join("\n");
  const markup = registry.themes.flatMap((theme) => theme.markup.map((file) => (
    fs.readFileSync(path.join(theme.directory, ...file.split("/")), "utf8").trim()
  ))).filter(Boolean).join("\n");
  const catalog = JSON.stringify(publicThemeCatalog(registry, link)).replaceAll("<", "\\u003c");
  const options = registry.themes.map((theme) => (
    `<option value="${escapeHtml(theme.id)}">${escapeHtml(theme.name)}</option>`
  )).join("\n              ");
  return html
    .replace(/^[ \t]*<!-- agent-hub-theme-styles -->/mu, styles)
    .replace(/^[ \t]*<!-- agent-hub-theme-markup -->/mu, markup)
    .replace(/^[ \t]*<!-- agent-hub-theme-catalog -->/mu, `  <script type="application/json" data-theme-catalog${nonceAttribute}>${catalog}</script>`)
    .replace(/^[ \t]*<!-- agent-hub-theme-scripts -->/mu, scripts)
    .replace(/(<select data-theme-select[^>]*>)[\s\S]*?(<\/select>)/u, `$1\n              ${options}\n            $2`);
}

module.exports = {
  loadThemeRegistry,
  publicThemeCatalog,
  renderThemeHtml,
};
