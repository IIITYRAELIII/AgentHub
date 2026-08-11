import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { localAssetPathname, localAssetReferences, replaceLocalAssetReference } = require("../client-assets.cjs");
const { loadThemeRegistry, renderThemeHtml } = require("../theme-registry.cjs");
const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "assets", "mini-app");
const defaultOutput = path.join(import.meta.dirname, "public");

function shellAssetSource(pathname) {
  if (pathname === "/work-log.css") return path.join(root, "work-log.css");
  if (pathname === "/remote-command-idempotency.js") {
    return path.join(import.meta.dirname, "remote-command-idempotency.js");
  }
  return path.join(source, ...pathname.slice(1).split("/"));
}

async function copyShellAsset(output, reference) {
  const pathname = localAssetPathname(reference);
  const target = path.join(output, ...pathname.slice(1).split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(shellAssetSource(pathname), target);
}

export async function buildWorkerAssets({
  output = defaultOutput,
  includeMobile = true,
} = {}) {
  const themeRegistry = loadThemeRegistry(source);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  let index = await readFile(path.join(source, "index.html"), "utf8");
  const hubClientScript = '  <script src="/hub-client.js" defer></script>';
  if (!index.includes(hubClientScript)) {
    throw new Error("Agent Hub Worker build could not find the hub-client script anchor");
  }
  index = index.replace(
    hubClientScript,
    `  <script src="/remote-command-idempotency.js" defer></script>\n${hubClientScript}`,
  );
  const shellReferences = localAssetReferences(index);
  await Promise.all(shellReferences.map((reference) => copyShellAsset(output, reference)));

  for (const resource of themeRegistry.resources.values()) {
    const target = path.join(output, ...resource.pathname.slice(1).split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(resource.file, target);
  }
  await copyFile(path.join(import.meta.dirname, "_headers"), path.join(output, "_headers"));

  if (includeMobile) {
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
    }
  }

  const themeRevisions = new Map(await Promise.all([...themeRegistry.resources].map(async ([pathname, resource]) => (
    [pathname, createHash("sha256").update(await readFile(resource.file)).digest("hex").slice(0, 12)]
  ))));
  index = renderThemeHtml(index, themeRegistry, {
    revision: (pathname) => themeRevisions.get(pathname) ?? "",
  });

  for (const reference of shellReferences) {
    const pathname = localAssetPathname(reference);
    const file = pathname.slice(1);
    const revision = createHash("sha256")
      .update(await readFile(path.join(output, ...file.split("/"))))
      .digest("hex")
      .slice(0, 12);
    const extension = path.extname(file);
    const versionedFile = `${file.slice(0, -extension.length)}.${revision}${extension}`;
    const versionedReference = `/${versionedFile.split(path.sep).join("/")}`;
    await mkdir(path.dirname(path.join(output, versionedFile)), { recursive: true });
    await copyFile(path.join(output, file), path.join(output, versionedFile));
    const updated = replaceLocalAssetReference(index, reference, versionedReference);
    if (updated === index) throw new Error(`Agent Hub Worker build could not find the ${reference} asset anchor`);
    index = updated;
  }

  await writeFile(path.join(output, "index.html"), index, "utf8");
  return { output, shellReferences, themeRegistry };
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedFile === import.meta.url) await buildWorkerAssets();
