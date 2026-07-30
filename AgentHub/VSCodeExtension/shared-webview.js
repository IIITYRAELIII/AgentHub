"use strict";

const { randomBytes } = require("node:crypto");
const vscode = require("vscode");

const ASSET_ROOT = ["Utilities", "AgentHub", "assets", "mini-app"];
const ASSETS = {
  index: [...ASSET_ROOT, "index.html"],
  app: [...ASSET_ROOT, "app.js"],
  lifecycle: [...ASSET_ROOT, "message-lifecycle.js"],
  client: [...ASSET_ROOT, "hub-client.js"],
  styles: [...ASSET_ROOT, "styles.css"],
  workLogStyles: ["Utilities", "AgentHub", "work-log.css"],
  bootstrap: ["Utilities", "AgentHub", "VSCodeExtension", "vscode-bootstrap.js"],
  pulsar: [...ASSET_ROOT, "pulsar-beams.png"],
  blackhole: [...ASSET_ROOT, "blackhole-blue.png"],
  taiga: [...ASSET_ROOT, "rainforest-night.png"],
  magma: [...ASSET_ROOT, "magma-crust.png"],
  storm: [...ASSET_ROOT, "storm-rain.png"],
  meadow: [...ASSET_ROOT, "meadow-sun.png"],
  orbit: [...ASSET_ROOT, "orbit-earth.png"],
  nebula: [...ASSET_ROOT, "nebula-veil.png"],
  gothic: [...ASSET_ROOT, "gothic-concrete.png"],
};

function candidates(segments) {
  return (vscode.workspace.workspaceFolders ?? []).map(
    (folder) => vscode.Uri.joinPath(folder.uri, ...segments),
  );
}

async function firstExisting(segments) {
  for (const candidate of candidates(segments)) {
    try {
      const info = await vscode.workspace.fs.stat(candidate);
      if (info.type & vscode.FileType.File) return candidate;
    } catch {
      // Проверяется следующая папка workspace.
    }
  }
  return null;
}

async function resolveSharedAssets() {
  const entries = await Promise.all(
    Object.entries(ASSETS).map(async ([name, segments]) => [name, await firstExisting(segments)]),
  );
  const assets = Object.fromEntries(entries);
  for (const required of ["index", "app", "lifecycle", "client", "styles", "workLogStyles", "bootstrap"]) {
    if (!assets[required]) throw new Error(`Не найден ресурс Agent Hub: ${required}`);
  }
  return assets;
}

function resource(webview, uri) {
  return uri ? String(webview.asWebviewUri(uri)) : "";
}

async function sharedWebviewHtml(webview) {
  const assets = await resolveSharedAssets();
  const nonce = randomBytes(16).toString("base64");
  let html = Buffer.from(await vscode.workspace.fs.readFile(assets.index)).toString("utf8");
  const assetOverrides = [
    ["--pulsar-image", assets.pulsar],
    ["--bh-image", assets.blackhole],
    ["--forest-image", assets.taiga],
    ["--magma-image", assets.magma],
    ["--storm-image", assets.storm],
    ["--meadow-image", assets.meadow],
    ["--orbit-image", assets.orbit],
    ["--nebula-image", assets.nebula],
    ["--gothic-image", assets.gothic],
  ].filter(([, uri]) => uri).map(([name, uri]) => (
    `${name}: url("${resource(webview, uri)}");`
  )).join("");
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src ${webview.cspSource}`,
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
    .replace(/<script src="https:\/\/telegram\.org\/[^>]+><\/script>\s*/iu, "")
    .replace(
      '<script src="/app.js" defer></script>',
      `<style nonce="${nonce}">html[data-theme]{${assetOverrides}}</style>`
        + `<script src="${resource(webview, assets.bootstrap)}" defer></script>`
        + `<script src="${resource(webview, assets.app)}" defer></script>`
        + `<script src="${resource(webview, assets.lifecycle)}" defer></script>`
        + `<script src="${resource(webview, assets.client)}" defer></script>`,
    )
    .replace('<script src="/message-lifecycle.js" defer></script>', "")
    .replace('<script src="/hub-client.js" defer></script>', "");
  return { html, roots: Object.values(assets).filter(Boolean) };
}

module.exports = { sharedWebviewHtml };
