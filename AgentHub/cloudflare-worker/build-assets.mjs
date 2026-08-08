import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = require("../theme-registry.cjs");
const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "assets", "mini-app");
const output = path.join(import.meta.dirname, "public");
const themeRegistry = loadThemeRegistry(source);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  "index.html",
  "browser-device-auth.js",
  "message-disclosure.js",
  "app.js",
  "message-lifecycle.js",
  "hub-client.js",
  "context-flash.mjs",
  "styles.css",
  "backgrounds.css",
  "agent-hub-mark.png",
]) {
  await copyFile(path.join(source, file), path.join(output, file));
}
for (const resource of themeRegistry.resources.values()) {
  const target = path.join(output, ...resource.pathname.slice(1).split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(resource.file, target);
}
await copyFile(path.join(root, "work-log.css"), path.join(output, "work-log.css"));
await copyFile(
  path.join(import.meta.dirname, "remote-command-idempotency.js"),
  path.join(output, "remote-command-idempotency.js"),
);

const mobileAssets = path.join(root, "assets", "mobile");
const androidApk = path.join(mobileAssets, "AgentHub-Mobile.apk");
const androidManifest = path.join(mobileAssets, "update.json");
try {
  await Promise.all([access(androidApk), access(androidManifest)]);
  const manifest = JSON.parse(await readFile(androidManifest, "utf8"));
  const apk = await readFile(androidApk);
  const hash = createHash("sha256").update(apk).digest("hex");
  if (Number(manifest.bytes) !== apk.length || String(manifest.sha256) !== hash) {
    throw new Error("Published Android APK does not match assets/mobile/update.json");
  }
  await copyFile(androidApk, path.join(output, "AgentHub-Mobile.apk"));
  await copyFile(androidManifest, path.join(output, "update.json"));
} catch (error) {
  if (error?.code && error.code !== "ENOENT") throw error;
  // A Worker-only build remains valid before the optional Android client is built.
}

const indexFile = path.join(output, "index.html");
let index = await readFile(indexFile, "utf8");
const hubClientScript = '  <script src="/hub-client.js" defer></script>';
if (!index.includes(hubClientScript)) {
  throw new Error("Agent Hub Worker build could not find the hub-client script anchor");
}
index = index.replace(
  hubClientScript,
  `  <script src="/remote-command-idempotency.js" defer></script>\n${hubClientScript}`,
);

const themeRevisions = new Map(await Promise.all([...themeRegistry.resources].map(async ([pathname, resource]) => (
  [pathname, createHash("sha256").update(await readFile(resource.file)).digest("hex").slice(0, 12)]
))));
index = renderThemeHtml(index, themeRegistry, {
  revision: (pathname) => themeRevisions.get(pathname) ?? "",
});

for (const file of [
  "work-log.css",
  "styles.css",
  "backgrounds.css",
  "browser-device-auth.js",
  "message-disclosure.js",
  "app.js",
  "message-lifecycle.js",
  "remote-command-idempotency.js",
  "hub-client.js",
  "agent-hub-mark.png",
]) {
  const reference = `/${file}`;
  if (!index.includes(`"${reference}"`)) {
    throw new Error(`Agent Hub Worker build could not find the ${file} asset anchor`);
  }
  const revision = createHash("sha256")
    .update(await readFile(path.join(output, file)))
    .digest("hex")
    .slice(0, 12);
  index = index.replaceAll(`"${reference}"`, `"${reference}?v=${revision}"`);
}

await writeFile(indexFile, index, "utf8");
