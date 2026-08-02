"use strict";

const { randomBytes } = require("node:crypto");
const vscode = require("vscode");

const ASSET_ROOT = ["assets", "mini-app"];
const RUNTIME_ASSETS = {
  index: [...ASSET_ROOT, "index.html"],
  app: [...ASSET_ROOT, "app.js"],
  metropolisGlass: [...ASSET_ROOT, "metropolis-glass.js"],
  stormGlass: [...ASSET_ROOT, "storm-glass.js"],
  lifecycle: [...ASSET_ROOT, "message-lifecycle.js"],
  client: [...ASSET_ROOT, "hub-client.js"],
  styles: [...ASSET_ROOT, "styles.css"],
  backgrounds: [...ASSET_ROOT, "backgrounds.css"],
  workLogStyles: ["work-log.css"],
  pulsar: [...ASSET_ROOT, "pulsar-beams.png"],
  blackhole: [...ASSET_ROOT, "blackhole-blue.png"],
  taiga: [...ASSET_ROOT, "rainforest-night.png"],
  magma: [...ASSET_ROOT, "magma-crust.png"],
  metropolis: [...ASSET_ROOT, "metropolis-night.png"],
  stormglass: [...ASSET_ROOT, "storm-sea.png"],
  stormflash: [...ASSET_ROOT, "storm-flash.png"],
  meadow: [...ASSET_ROOT, "meadow-sun.png"],
  orbitLimb: [...ASSET_ROOT, "orbit-limb.jpg"],
  nebulaCore: [...ASSET_ROOT, "nebula-core.jpg"],
  pulsarBeam: [...ASSET_ROOT, "pulsar-beam.jpg"],
  blackholeDisk: [...ASSET_ROOT, "blackhole-disk.jpg"],
  gothicCrypt: [...ASSET_ROOT, "gothic-crypt.jpg"],
  taigaRainfall: [...ASSET_ROOT, "taiga-rainfall.jpg"],
  metropolisTowers: [...ASSET_ROOT, "metropolis-towers.jpg"],
  magmaFlow: [...ASSET_ROOT, "magma-flow.jpg"],
  meadowGoldenhour: [...ASSET_ROOT, "meadow-goldenhour.jpg"],
  gothicTower: [...ASSET_ROOT, "gothic-tower.jpg"],
  gothicHarbor: [...ASSET_ROOT, "gothic-harbor.jpg"],
  gothicChapel: [...ASSET_ROOT, "gothic-chapel.jpg"],
  gothicKeep: [...ASSET_ROOT, "gothic-keep.jpg"],
  gothicMinentalCastle: [...ASSET_ROOT, "gothic-minental-castle.jpg"],
  gothicFinkregh: [...ASSET_ROOT, "gothic-finkregh.jpg"],
  lake: [...ASSET_ROOT, "lake-summer.jpg"],
  lakeWatercolor: [...ASSET_ROOT, "lake-watercolor.jpg"],
  lakeOil: [...ASSET_ROOT, "lake-oil.jpg"],
  orbit: [...ASSET_ROOT, "orbit-earth.png"],
  nebula: [...ASSET_ROOT, "nebula-veil.png"],
  gothic: [...ASSET_ROOT, "gothic-concrete.png"],
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
    "index", "app", "metropolisGlass", "stormGlass", "lifecycle", "client", "styles", "backgrounds",
    "workLogStyles", "bootstrap",
  ]) {
    if (!assets[required]) throw new Error(`Не найден ресурс Agent Hub: ${required}`);
  }
  return assets;
}

function resource(webview, uri) {
  return uri ? String(webview.asWebviewUri(uri)) : "";
}

async function sharedWebviewHtml(webview, locations) {
  const assets = await resolveSharedAssets(locations);
  const nonce = randomBytes(16).toString("base64");
  let html = Buffer.from(await vscode.workspace.fs.readFile(assets.index)).toString("utf8");
  const assetOverrides = [
    ["--pulsar-image", assets.pulsar],
    ["--bh-image", assets.blackhole],
    ["--forest-image", assets.taiga],
    ["--magma-image", assets.magma],
    ["--metropolis-image", assets.metropolis],
    ["--stormglass-image", assets.stormglass],
    ["--stormglass-flash", assets.stormflash],
    ["--meadow-image", assets.meadow],
    ["--orbit-limb-image", assets.orbitLimb],
    ["--nebula-core-image", assets.nebulaCore],
    ["--pulsar-beam-image", assets.pulsarBeam],
    ["--blackhole-disk-image", assets.blackholeDisk],
    ["--gothic-crypt-image", assets.gothicCrypt],
    ["--taiga-rainfall-image", assets.taigaRainfall],
    ["--metropolis-towers-image", assets.metropolisTowers],
    ["--magma-flow-image", assets.magmaFlow],
    ["--meadow-goldenhour-image", assets.meadowGoldenhour],
    ["--gothic-tower-image", assets.gothicTower],
    ["--gothic-harbor-image", assets.gothicHarbor],
    ["--gothic-chapel-image", assets.gothicChapel],
    ["--gothic-keep-image", assets.gothicKeep],
    ["--gothic-minental-castle-image", assets.gothicMinentalCastle],
    ["--gothic-finkregh-image", assets.gothicFinkregh],
    ["--lake-image", assets.lake],
    ["--lake-watercolor-image", assets.lakeWatercolor],
    ["--lake-oil-image", assets.lakeOil],
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
    .replace('href="/backgrounds.css"', `href="${resource(webview, assets.backgrounds)}"`)
    .replace(/<script src="https:\/\/telegram\.org\/[^>]+><\/script>\s*/iu, "")
    .replace(
      '<script src="/app.js" defer></script>',
      `<style nonce="${nonce}">html[data-theme],html[data-background]{${assetOverrides}}</style>`
        + `<script src="${resource(webview, assets.bootstrap)}" defer></script>`
        + `<script src="${resource(webview, assets.app)}" defer></script>`
        + `<script src="${resource(webview, assets.metropolisGlass)}" defer></script>`
        + `<script src="${resource(webview, assets.stormGlass)}" defer></script>`
        + `<script src="${resource(webview, assets.lifecycle)}" defer></script>`
        + `<script src="${resource(webview, assets.client)}" defer></script>`,
    )
    .replace('<script src="/metropolis-glass.js" defer></script>', "")
    .replace('<script src="/storm-glass.js" defer></script>', "")
    .replace('<script src="/message-lifecycle.js" defer></script>', "")
    .replace('<script src="/hub-client.js" defer></script>', "");
  return { html, roots: Object.values(assets).filter(Boolean) };
}

module.exports = { sharedWebviewHtml };
