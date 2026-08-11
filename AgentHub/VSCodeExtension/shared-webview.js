"use strict";

const { randomBytes } = require("node:crypto");
const path = require("node:path");
const vscode = require("vscode");

const ASSET_ROOT = ["assets", "mini-app"];
const LOCAL_ASSET_REFERENCE = /\b(?:src|href)="(\/[^"?#]+(?:[?#][^"]*)?)"/giu;
const LOCAL_ASSET_PATH = /\.(?:avif|css|gif|ico|jpe?g|js|mjs|png|svg|ttf|webp|woff2?)(?:[?#]|$)/iu;

async function existingFile(uri, label) {
  try {
    const info = await vscode.workspace.fs.stat(uri);
    if (info.type & vscode.FileType.File) return uri;
  } catch {
    // The caller reports one stable diagnostic for missing runtime resources.
  }
  throw new Error(`Не найден ресурс Agent Hub: ${label}`);
}

function runtimeAssetUri(runtimeUri, reference) {
  const pathname = String(reference).split(/[?#]/u, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error(`Некорректный путь ресурса Agent Hub: ${pathname}`);
  }
  const segments = decoded.replace(/^\/+/, "").split("/");
  if (
    !segments.length
    || segments.some((segment) => (
      !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes(":")))
  ) {
    throw new Error(`Некорректный путь ресурса Agent Hub: ${pathname}`);
  }
  return decoded === "/work-log.css"
    ? vscode.Uri.joinPath(runtimeUri, "work-log.css")
    : vscode.Uri.joinPath(runtimeUri, ...ASSET_ROOT, ...segments);
}

function localAssetReferences(html) {
  return [...new Set([...String(html).matchAll(LOCAL_ASSET_REFERENCE)]
    .map((match) => match[1])
    .filter((reference) => LOCAL_ASSET_PATH.test(reference)))];
}

async function resolveSharedAssets({ runtimeUri, extensionUri }) {
  if (!runtimeUri) throw new Error("Активный runtime Agent Hub не найден");
  if (!extensionUri) throw new Error("Не найден мост VS Code Agent Hub");
  const index = await existingFile(vscode.Uri.joinPath(runtimeUri, ...ASSET_ROOT, "index.html"), "index.html");
  const bootstrap = await existingFile(vscode.Uri.joinPath(extensionUri, "vscode-bootstrap.js"), "bootstrap");
  const registryTools = require(path.join(runtimeUri.fsPath, "theme-registry.cjs"));
  const themeRegistry = registryTools.loadThemeRegistry(path.join(runtimeUri.fsPath, ...ASSET_ROOT));
  return { index, bootstrap, themeRegistry, renderThemeHtml: registryTools.renderThemeHtml };
}

function resource(webview, uri) {
  return uri ? String(webview.asWebviewUri(uri)) : "";
}

async function rewriteRuntimeAssetReferences(html, webview, runtimeUri) {
  const references = localAssetReferences(html);
  const entries = await Promise.all(references.map(async (reference) => {
    const uri = runtimeAssetUri(runtimeUri, reference);
    await existingFile(uri, reference);
    return [reference, uri];
  }));
  for (const [reference, uri] of entries) {
    html = html.replaceAll(`="${reference}"`, `="${resource(webview, uri)}"`);
  }
  return { html, uris: entries.map(([, uri]) => uri) };
}

async function sharedWebviewHtml(webview, locations) {
  const { runtimeUri } = locations;
  const { index, bootstrap, themeRegistry, renderThemeHtml } = await resolveSharedAssets(locations);
  const nonce = randomBytes(16).toString("base64");
  let html = Buffer.from(await vscode.workspace.fs.readFile(index)).toString("utf8");
  const themeResourceUrls = new Map([...themeRegistry.resources].map(([pathname, item]) => (
    [pathname, resource(webview, vscode.Uri.file(item.file))]
  )));
  html = renderThemeHtml(html, themeRegistry, {
    nonce,
    resourceUrl: (pathname) => themeResourceUrls.get(pathname) ?? pathname,
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
  const rewritten = await rewriteRuntimeAssetReferences(html, webview, runtimeUri);
  html = rewritten.html;
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
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
