"use strict";

const { randomBytes } = require("node:crypto");
const path = require("node:path");
const vscode = require("vscode");

const ASSET_ROOT = ["assets", "mini-app"];
const RUNTIME_ASSETS = {
  index: [...ASSET_ROOT, "index.html"],
  disclosure: [...ASSET_ROOT, "message-disclosure.js"],
  app: [...ASSET_ROOT, "app.js"],
  lifecycle: [...ASSET_ROOT, "message-lifecycle.js"],
  client: [...ASSET_ROOT, "hub-client.js"],
  styles: [...ASSET_ROOT, "styles.css"],
  backgrounds: [...ASSET_ROOT, "backgrounds.css"],
  streamStatus: [...ASSET_ROOT, "stream-status.css"],
  streamStatusVisibility: [...ASSET_ROOT, "stream-status-visibility.mjs"],
  mark: [...ASSET_ROOT, "agent-hub-mark.png"],
  workLogStyles: ["work-log.css"],
};

async function resolveSharedAssets({ runtimeUri, extensionUri }) {
  if (!runtimeUri) throw new Error("Активный runtime Agent Hub не найден");
  if (!extensionUri) throw new Error("Не найден мост VS Code Agent Hub");
  const entries = await Promise.all(
    Object.entries(RUNTIME_ASSETS).map(async ([name, segments]) => {
      const asset = vscode.Uri.joinPath(runtimeUri, ...segments);
      try {
        const info = await vscode.workspace.fs.stat(asset);
        return [name, info.type & vscode.FileType.File ? asset : null];
      } catch {
        return [name, null];
      }
    }),
  );
  const assets = Object.fromEntries(entries);
  const bootstrap = vscode.Uri.joinPath(extensionUri, "vscode-bootstrap.js");
  try {
    const info = await vscode.workspace.fs.stat(bootstrap);
    assets.bootstrap = info.type & vscode.FileType.File ? bootstrap : null;
  } catch {
    assets.bootstrap = null;
  }
  for (const required of [
    "index", "disclosure", "app", "lifecycle", "client", "styles", "backgrounds", "streamStatus", "streamStatusVisibility",
    "mark", "workLogStyles", "bootstrap",
  ]) {
    if (!assets[required]) throw new Error(`Не найден ресурс Agent Hub: ${required}`);
  }
  const registryTools = require(path.join(runtimeUri.fsPath, "theme-registry.cjs"));
  const themeRegistry = registryTools.loadThemeRegistry(path.join(runtimeUri.fsPath, ...ASSET_ROOT));
  return { assets, themeRegistry, renderThemeHtml: registryTools.renderThemeHtml };
}

function resource(webview, uri) {
  return uri ? String(webview.asWebviewUri(uri)) : "";
}

async function sharedWebviewHtml(webview, locations) {
  const { assets, themeRegistry, renderThemeHtml } = await resolveSharedAssets(locations);
  const nonce = randomBytes(16).toString("base64");
  let html = Buffer.from(await vscode.workspace.fs.readFile(assets.index)).toString("utf8");
  const themeResourceUrls = new Map([...themeRegistry.resources].map(([pathname, item]) => (
    [pathname, resource(webview, vscode.Uri.file(item.file))]
  )));
  html = renderThemeHtml(html, themeRegistry, {
    nonce,
    resourceUrl: (pathname) => themeResourceUrls.get(pathname) ?? pathname,
  });
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    "connect-src 'none'",
    "font-src 'none'",
  ].join("; ");
  html = html
    .replace(
      /<meta charset="utf-8">/iu,
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )
    .replace('href="/work-log.css"', `href="${resource(webview, assets.workLogStyles)}"`)
    .replace('href="/styles.css"', `href="${resource(webview, assets.styles)}"`)
    .replace('href="/backgrounds.css"', `href="${resource(webview, assets.backgrounds)}"`)
    .replace('href="/stream-status.css"', `href="${resource(webview, assets.streamStatus)}"`)
    .replace(
      '<script src="/stream-status-visibility.mjs" type="module"></script>',
      `<script src="${resource(webview, assets.streamStatusVisibility)}" type="module"></script>`,
    )
    .replaceAll('href="/agent-hub-mark.png"', `href="${resource(webview, assets.mark)}"`)
    .replaceAll('src="/agent-hub-mark.png"', `src="${resource(webview, assets.mark)}"`)
    .replace(/<script src="https:\/\/telegram\.org\/[^>]+><\/script>\s*/iu, "")
    .replace('<script src="/browser-device-auth.js" defer></script>', "")
    .replace('<script src="/message-disclosure.js" defer></script>', "")
    .replace(
      '<script src="/app.js" defer></script>',
      `<script src="${resource(webview, assets.bootstrap)}" defer></script>`
        + `<script src="${resource(webview, assets.disclosure)}" defer></script>`
        + `<script src="${resource(webview, assets.app)}" defer></script>`,
    )
    .replace('<script src="/message-lifecycle.js" defer></script>', `<script src="${resource(webview, assets.lifecycle)}" defer></script>`)
    .replace('<script src="/hub-client.js" defer></script>', `<script src="${resource(webview, assets.client)}" defer></script>`);
  return {
    html,
    roots: [...Object.values(assets).filter(Boolean), ...[...themeRegistry.resources.values()].map((item) => vscode.Uri.file(item.file))],
    themeIds: themeRegistry.themes.map((theme) => theme.id),
  };
}

module.exports = { sharedWebviewHtml };
