import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadThemeRegistry } = require("../theme-registry.cjs");
const root = path.resolve(import.meta.dirname, "..");
const themeRoot = path.join(root, "assets", "mini-app");

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function themeCatalog(html) {
  const source = html.match(/<script type="application\/json" data-theme-catalog>([^<]+)<\/script>/u)?.[1];
  if (!source) throw new Error("Published theme catalog is missing");
  return JSON.parse(source);
}

async function mapConcurrent(values, limit, action) {
  const pending = [...values];
  const workers = Array.from({ length: Math.min(limit, pending.length) }, async () => {
    while (pending.length) await action(pending.shift());
  });
  await Promise.all(workers);
}

async function readWithRetry(fetchImpl, target, read, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(target, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await read(response);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
    }
  }
  throw new Error(`${new URL(target).pathname}: ${lastError?.message ?? "request failed"}`);
}

export async function verifyThemeDeployment({
  baseUrl,
  sourceRoot = themeRoot,
  fetchImpl = fetch,
} = {}) {
  const base = new URL(baseUrl);
  const index = await readWithRetry(fetchImpl, new URL(`/?verify=${Date.now()}`, base), (response) => response.text());
  const catalog = themeCatalog(index);
  const published = new Map(catalog.map((theme) => [theme.id, theme]));
  const registry = loadThemeRegistry(sourceRoot);
  const backgrounds = registry.themes.flatMap((theme) => theme.backgrounds
    .filter((background) => background.asset)
    .map((background) => ({ theme, background })));
  let bytes = 0;
  await mapConcurrent(backgrounds, 6, async ({ theme, background }) => {
    const assetUrl = published.get(theme.id)?.backgrounds?.find((item) => item.id === background.id)?.assetUrl;
    if (!/\.json(?:[?#]|$)/iu.test(String(assetUrl ?? ""))) {
      throw new Error(`Published background ${theme.id}/${background.id} does not use chunked text transport`);
    }
    const manifest = await readWithRetry(fetchImpl, new URL(assetUrl, base), (response) => response.json());
    if (!Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 512) {
      throw new Error(`Published background ${theme.id}/${background.id} has an invalid manifest`);
    }
    const source = await readFile(path.join(theme.directory, ...background.asset.split("/")));
    if (manifest.directUrl) {
      try {
        const direct = Buffer.from(await readWithRetry(
          fetchImpl,
          new URL(manifest.directUrl),
          (directResponse) => directResponse.arrayBuffer(),
        ));
        if (direct.length === source.length && sha256(direct) === sha256(source)) {
          bytes += direct.length;
          return;
        }
      } catch {
        // The Worker chunk transport remains the bounded fallback.
      }
    }
    const chunks = [];
    for (const part of manifest.parts) {
      const chunk = (await readWithRetry(fetchImpl, new URL(part, base), (response) => response.text())).trim();
      if (Buffer.byteLength(chunk) > 20 * 1024) throw new Error(`Published background part ${part} exceeds 20 KiB`);
      chunks.push(chunk);
    }
    const decoded = Buffer.from(chunks.join(""), "base64");
    if (Number(manifest.bytes) !== source.length || manifest.sha256 !== sha256(source)
      || decoded.length !== source.length || sha256(decoded) !== sha256(source)) {
      throw new Error(`Published background ${theme.id}/${background.id} does not match its source`);
    }
    bytes += decoded.length;
  });
  console.log(`Verified ${backgrounds.length} published theme backgrounds (${bytes} bytes).`);
  return { backgrounds: backgrounds.length, bytes };
}

function routeBaseUrl(config) {
  const route = config.routes?.find((item) => typeof item === "string" || item?.pattern);
  const pattern = typeof route === "string" ? route : route?.pattern;
  const host = String(pattern ?? "").replace(/^https?:\/\//iu, "").replace(/\/\*.*$/u, "").replace(/\/$/u, "");
  if (!host) throw new Error("Worker route is missing");
  return `https://${host}/`;
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedFile === import.meta.url) {
  const config = JSON.parse(await readFile(path.join(import.meta.dirname, "wrangler.jsonc"), "utf8"));
  await verifyThemeDeployment({ baseUrl: routeBaseUrl(config) });
}
