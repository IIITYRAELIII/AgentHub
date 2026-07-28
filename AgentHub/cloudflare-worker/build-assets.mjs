import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "assets", "mini-app");
const output = path.join(import.meta.dirname, "public");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  "index.html",
  "app.js",
  "styles.css",
  "blackhole-blue.png",
  "magma-crust.png",
  "pulsar-beams.png",
  "rainforest-night.png",
]) {
  await copyFile(path.join(source, file), path.join(output, file));
}
await copyFile(path.join(root, "work-log.css"), path.join(output, "work-log.css"));
