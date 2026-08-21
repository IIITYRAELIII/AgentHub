import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadThemeRegistry } = require("../theme-registry.cjs");
const root = path.resolve(import.meta.dirname, "..");
const themeRoot = path.join(root, "assets", "web-app");

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function themeCatalog(html) {
  const source = html.match(/<script type="application\/json" data-theme-catalog>([^<]+)<\/script>/u)?.[1];
  if (!source) throw new Error("Published theme catalog is missing");
  return JSON.parse(source);
}

async function mapConcurrent(values, limit, action) {
  const pending = [...values].map((value, index) => ({ index, value }));
  const results = new Array(pending.length);
  const workers = Array.from({ length: Math.min(limit, pending.length) }, async () => {
    while (pending.length) {
      const { index, value } = pending.shift();
      results[index] = await action(value);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readWithRetry(fetchImpl, target, read, { attempts = 4, timeoutMs = 30_000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(target, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
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
  let sampledChunks = 0;
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
    const sourceHash = sha256(source);
    if (Number(manifest.bytes) !== source.length || manifest.sha256 !== sourceHash) {
      throw new Error(`Published background ${theme.id}/${background.id} manifest does not match its source`);
    }
    if (manifest.directUrl) {
      const directTarget = new URL(manifest.directUrl);
      if (directTarget.protocol !== "https:" || directTarget.searchParams.get("v") !== sourceHash.slice(0, 12)) {
        throw new Error(`Published background ${theme.id}/${background.id} has an invalid direct URL revision`);
      }
    }
    const encoded = source.toString("base64");
    const first = (await readWithRetry(fetchImpl, new URL(manifest.parts[0], base), (response) => response.text())).trim();
    if (!first || Buffer.byteLength(first) > 20 * 1024 || !encoded.startsWith(first)) {
      throw new Error(`Published background ${theme.id}/${background.id} has an invalid first chunk`);
    }
    const expectedPartCount = Math.ceil(encoded.length / first.length);
    if (expectedPartCount !== manifest.parts.length) {
      throw new Error(`Published background ${theme.id}/${background.id} has an invalid chunk count`);
    }
    const sampleIndexes = [...new Set([0, Math.floor((manifest.parts.length - 1) / 2), manifest.parts.length - 1])];
    for (const index of sampleIndexes.slice(1)) {
      const part = manifest.parts[index];
      const chunk = (await readWithRetry(fetchImpl, new URL(part, base), (response) => response.text())).trim();
      if (Buffer.byteLength(chunk) > 20 * 1024
        || chunk !== encoded.slice(index * first.length, (index + 1) * first.length)) {
        throw new Error(`Published background ${theme.id}/${background.id} has an invalid sampled chunk ${index}`);
      }
    }
    sampledChunks += sampleIndexes.length;
    bytes += source.length;
  });
  console.log(`Verified ${backgrounds.length} published theme manifests and ${sampledChunks} chunks (${bytes} bytes).`);
  return { backgrounds: backgrounds.length, bytes, sampledChunks };
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
