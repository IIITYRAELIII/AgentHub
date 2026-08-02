import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "assets", "mini-app");
const output = path.join(import.meta.dirname, "public");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  "index.html",
  "app.js",
  "metropolis-glass.js",
  "storm-glass.js",
  "message-lifecycle.js",
  "hub-client.js",
  "styles.css",
  "backgrounds.css",
  "blackhole-blue.png",
  "gothic-concrete.png",
  "nebula-veil.png",
  "orbit-earth.png",
  "magma-crust.png",
  "meadow-sun.png",
  "orbit-limb.jpg",
  "nebula-core.jpg",
  "pulsar-beam.jpg",
  "blackhole-disk.jpg",
  "gothic-crypt.jpg",
  "taiga-rainfall.jpg",
  "metropolis-towers.jpg",
  "magma-flow.jpg",
  "meadow-goldenhour.jpg",
  "gothic-tower.jpg",
  "gothic-harbor.jpg",
  "gothic-chapel.jpg",
  "gothic-keep.jpg",
  "gothic-minental-castle.jpg",
  "gothic-finkregh.jpg",
  "lake-summer.jpg",
  "lake-watercolor.jpg",
  "lake-oil.jpg",
  "metropolis-night.png",
  "storm-sea.png",
  "storm-flash.png",
  "pulsar-beams.png",
  "rainforest-night.png",
]) {
  await copyFile(path.join(source, file), path.join(output, file));
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
const index = await readFile(indexFile, "utf8");
const hubClientScript = '  <script src="/hub-client.js" defer></script>';
if (!index.includes(hubClientScript)) {
  throw new Error("Agent Hub Worker build could not find the hub-client script anchor");
}
await writeFile(
  indexFile,
  index.replace(
    hubClientScript,
    `  <script src="/remote-command-idempotency.js" defer></script>\n${hubClientScript}`,
  ),
  "utf8",
);
