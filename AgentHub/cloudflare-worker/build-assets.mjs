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
  "blackhole-blue.png",
  "gothic-concrete.png",
  "nebula-veil.png",
  "orbit-earth.png",
  "magma-crust.png",
  "meadow-sun.png",
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

const androidApk = path.join(
  root,
  "AndroidApp",
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
);
try {
  await access(androidApk);
  await copyFile(androidApk, path.join(output, "AgentHub-Mobile.apk"));
} catch {
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
