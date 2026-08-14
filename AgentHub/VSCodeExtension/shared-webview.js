"use strict";

const { randomBytes } = require("node:crypto");
const path = require("node:path");
const vscode = require("vscode");

const ASSET_ROOT = ["assets", "web-app"];

async function existingFile(uri, label) {
  try {
    const info = await vscode.workspace.fs.stat(uri);
    if (info.type & vscode.FileType.File) return uri;
  } catch {
    // The caller reports one stable diagnostic for missing runtime resources.
  }
  throw new Error(`Не найден ресурс Agent Hub: ${label}`);
}

function runtimeAssetUri(runtimeUri, reference, clientAssets) {
  const pathname = clientAssets.localAssetPathname(reference);
  return pathname === "/work-log.css"
    ? vscode.Uri.joinPath(runtimeUri, "work-log.css")
    : vscode.Uri.joinPath(runtimeUri, ...ASSET_ROOT, ...pathname.slice(1).split("/"));
}

async function resolveSharedAssets({ runtimeUri, extensionUri }) {
  if (!runtimeUri) throw new Error("Активный runtime Agent Hub не найден");
  if (!extensionUri) throw new Error("Не найден мост VS Code Agent Hub");
  const index = await existingFile(vscode.Uri.joinPath(runtimeUri, ...ASSET_ROOT, "index.html"), "index.html");
  const bootstrap = await existingFile(vscode.Uri.joinPath(extensionUri, "vscode-bootstrap.js"), "bootstrap");
  const registryTools = require(path.join(runtimeUri.fsPath, "theme-registry.cjs"));
  const clientAssets = require(path.join(runtimeUri.fsPath, "client-assets.cjs"));
  const themeRegistry = registryTools.loadThemeRegistry(path.join(runtimeUri.fsPath, ...ASSET_ROOT));
  return { clientAssets, index, bootstrap, themeRegistry, renderThemeHtml: registryTools.renderThemeHtml };
}

function resource(webview, uri) {
  return uri ? String(webview.asWebviewUri(uri)) : "";
}

function rewriteThemeCssUrls(css, stylesheetPathname, themeRegistry, webview) {
  const base = path.posix.dirname(stylesheetPathname);
  return String(css).replace(/url\(\s*(["']?)([^"'()]+)\1\s*\)/giu, (match, _quote, rawValue) => {
    const value = String(rawValue).trim();
    if (!value || /^(?:data:|blob:|https?:|#)/iu.test(value)) return match;
    const [rawPathname, suffix = ""] = value.split(/(?=[?#])/u, 2);
    const pathname = rawPathname.startsWith("/")
      ? path.posix.normalize(rawPathname)
      : path.posix.resolve(base, rawPathname);
    const item = themeRegistry.resources.get(pathname);
    if (!item) throw new Error(`Не найден ресурс темы Agent Hub: ${value}`);
    return `url("${resource(webview, vscode.Uri.file(item.file))}${suffix}")`;
  });
}

async function themeStyleContent(themeRegistry, webview) {
  const entries = await Promise.all(themeRegistry.themes.flatMap((theme) => (
    theme.styles.map(async (file) => {
      const pathname = `/themes/${theme.id}/${file}`;
      const item = themeRegistry.resources.get(pathname);
      if (!item) throw new Error(`Не найден стиль темы Agent Hub: ${pathname}`);
      const css = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(item.file))).toString("utf8");
      return [pathname, rewriteThemeCssUrls(css, pathname, themeRegistry, webview)];
    })
  )));
  return new Map(entries);
}

async function rewriteRuntimeAssetReferences(html, webview, runtimeUri, clientAssets) {
  const references = clientAssets.localAssetReferences(html);
  const entries = await Promise.all(references.map(async (reference) => {
    const uri = runtimeAssetUri(runtimeUri, reference, clientAssets);
    await existingFile(uri, reference);
    return [reference, uri];
  }));
  for (const [reference, uri] of entries) {
    html = clientAssets.replaceLocalAssetReference(html, reference, resource(webview, uri));
  }
  return { html, uris: entries.map(([, uri]) => uri) };
}

async function sharedWebviewHtml(webview, locations) {
  const { runtimeUri } = locations;
  const { clientAssets, index, bootstrap, themeRegistry, renderThemeHtml } = await resolveSharedAssets(locations);
  const nonce = randomBytes(16).toString("base64");
  let html = Buffer.from(await vscode.workspace.fs.readFile(index)).toString("utf8");
  const themeResourceUrls = new Map([...themeRegistry.resources].map(([pathname, item]) => (
    [pathname, resource(webview, vscode.Uri.file(item.file))]
  )));
  const themeStyles = await themeStyleContent(themeRegistry, webview);
  html = renderThemeHtml(html, themeRegistry, {
    nonce,
    resourceUrl: (pathname) => themeResourceUrls.get(pathname) ?? pathname,
    styleContent: (pathname) => themeStyles.get(pathname),
  });
  html = html
    .replace(/<script\b[^>]*\bsrc="https:\/\/telegram\.org\/[^"]+"[^>]*><\/script>\s*/iu, "")
    .replace(/<script\b[^>]*\bsrc="\/browser-device-auth\.js"[^>]*><\/script>\s*/iu, "");
  const firstRuntimeScript = /<script\b(?=[^>]*\bsrc="\/[^"]+")[^>]*><\/script>/iu;
  if (!firstRuntimeScript.test(html)) throw new Error("Не найдена точка запуска Agent Hub");
  html = html.replace(
    firstRuntimeScript,
    `<script src="${resource(webview, bootstrap)}" defer></script>$&`,
  );
  const rewritten = await rewriteRuntimeAssetReferences(html, webview, runtimeUri, clientAssets);
  html = rewritten.html;
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    "connect-src 'none'",
    "font-src 'none'",
  ].join("; ");
  html = html.replace(
    /<meta charset="utf-8">/iu,
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
  return {
    html,
    roots: [
      index,
      bootstrap,
      ...rewritten.uris,
      ...[...themeRegistry.resources.values()].map((item) => vscode.Uri.file(item.file)),
    ],
    themeIds: themeRegistry.themes.map((theme) => theme.id),
  };
}

module.exports = { sharedWebviewHtml };
