import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { loadThemeRegistry } = require("../theme-registry.cjs");
const root = path.resolve(import.meta.dirname, "..");
const themeRoot = path.join(root, "assets", "web-app");
const publishedRoot = path.join(root, "cloudflare-worker", "public");
export const WORKER_VERIFY_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function fetchWithCurl(target, { signal } = {}) {
  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  const { stdout } = await execFileAsync(executable, [
    "--silent",
    "--show-error",
    "--location",
    "--fail",
    "--http1.1",
    String(target),
  ], {
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024,
    signal,
    windowsHide: true,
  });
  return new Response(stdout, { status: 200 });
}

async function fetchBuffered(fetchImpl, target, signal) {
  const response = await fetchImpl(target, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function fetchWithTransportRace(target, {
  signal,
  nativeFetch = fetch,
  curlFetch = fetchWithCurl,
} = {}) {
  const nativeController = new AbortController();
  const curlController = new AbortController();
  const abortTransports = () => {
    nativeController.abort(signal?.reason);
    curlController.abort(signal?.reason);
  };
  if (signal?.aborted) abortTransports();
  else signal?.addEventListener("abort", abortTransports, { once: true });
  try {
    return await Promise.any([
      fetchBuffered(nativeFetch, target, nativeController.signal),
      fetchBuffered(curlFetch, target, curlController.signal),
    ]);
  } catch (error) {
    if (signal?.aborted && signal.reason) throw signal.reason;
    const failures = error instanceof AggregateError ? error.errors : [error];
    throw new Error(`All Worker verification transports failed: ${failures
      .map((failure) => failure?.message ?? String(failure))
      .join("; ")}`);
  } finally {
    abortTransports();
    signal?.removeEventListener("abort", abortTransports);
  }
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

async function readWithRetry(fetchImpl, target, read, {
  attempts = 5,
  timeoutMs = WORKER_VERIFY_REQUEST_TIMEOUT_MS,
  log = console.log,
} = {}) {
  let lastError = null;
  const pathname = new URL(target).pathname;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const startedAt = Date.now();
    log(`[Worker verify] ${pathname}: запрос ${attempt + 1}/${attempts}`);
    try {
      const response = await fetchImpl(target, {
        signal: AbortSignal.timeout(remainingMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await read(response);
      log(`[Worker verify] ${pathname}: готово за ${Date.now() - startedAt} мс`);
      return result;
    } catch (error) {
      lastError = error;
      log(`[Worker verify] ${pathname}: ошибка ${attempt + 1}/${attempts} за ${Date.now() - startedAt} мс — ${error.message}`);
      if (attempt < attempts - 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(200 * (2 ** attempt), deadline - Date.now())));
      }
    }
  }
  throw new Error(`${pathname}: ${lastError?.message ?? `request timed out after ${timeoutMs} ms`}`);
}

function normalizedChangedFiles(changedFiles) {
  return new Set((Array.isArray(changedFiles) ? changedFiles : [])
    .map((file) => String(file).replaceAll("\\", "/").replace(/^\.\//u, "")));
}

export function changedBackgrounds(backgrounds, changedFiles) {
  if (!Array.isArray(changedFiles)) return backgrounds;
  const changed = normalizedChangedFiles(changedFiles);
  const verifyAll = changed.has("AgentHub/cloudflare-worker/build-assets.mjs")
    || changed.has("AgentHub/theme-registry.cjs");
  if (verifyAll) return backgrounds;
  return backgrounds.filter(({ theme, background }) => {
    const prefix = `AgentHub/assets/web-app/themes/${theme.id}/`;
    return changed.has(`${prefix}theme.json`)
      || changed.has(`${prefix}${background.asset}`)
      || changed.has(`themes/${theme.id}/theme.json`)
      || changed.has(`themes/${theme.id}/${background.asset}`);
  });
}

export async function verifyThemeDeployment({
  baseUrl,
  sourceRoot = themeRoot,
  deployedRoot = publishedRoot,
  fetchImpl = fetchWithTransportRace,
  changedFiles = null,
  requestTimeoutMs = WORKER_VERIFY_REQUEST_TIMEOUT_MS,
  log = console.log,
} = {}) {
  const base = new URL(baseUrl);
  const index = await readFile(path.join(deployedRoot, "index.html"), "utf8");
  const remoteIndex = await readWithRetry(
    fetchImpl,
    base,
    (response) => response.text(),
    { timeoutMs: requestTimeoutMs, log },
  );
  if (sha256(remoteIndex) !== sha256(index)) {
    throw new Error("Published Worker index does not match the built release");
  }
  const catalog = themeCatalog(remoteIndex);
  const published = new Map(catalog.map((theme) => [theme.id, theme]));
  const registry = loadThemeRegistry(sourceRoot);
  const availableBackgrounds = registry.themes.flatMap((theme) => theme.backgrounds
    .filter((background) => background.asset)
    .map((background) => ({ theme, background })));
  const backgrounds = changedBackgrounds(availableBackgrounds, changedFiles);
  let bytes = 0;
  let sampledChunks = 0;
  await mapConcurrent(backgrounds, 1, async ({ theme, background }) => {
    const assetUrl = published.get(theme.id)?.backgrounds?.find((item) => item.id === background.id)?.assetUrl;
    if (!/\.json(?:[?#]|$)/iu.test(String(assetUrl ?? ""))) {
      throw new Error(`Published background ${theme.id}/${background.id} does not use chunked text transport`);
    }
    const manifest = await readWithRetry(
      fetchImpl,
      new URL(assetUrl, base),
      (response) => response.json(),
      { timeoutMs: requestTimeoutMs, log },
    );
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
    const first = (await readWithRetry(
      fetchImpl,
      new URL(manifest.parts[0], base),
      (response) => response.text(),
      { timeoutMs: requestTimeoutMs, log },
    )).trim();
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
      const chunk = (await readWithRetry(
        fetchImpl,
        new URL(part, base),
        (response) => response.text(),
        { timeoutMs: requestTimeoutMs, log },
      )).trim();
      if (Buffer.byteLength(chunk) > 20 * 1024
        || chunk !== encoded.slice(index * first.length, (index + 1) * first.length)) {
        throw new Error(`Published background ${theme.id}/${background.id} has an invalid sampled chunk ${index}`);
      }
    }
    sampledChunks += sampleIndexes.length;
    bytes += source.length;
  });
  log(`Verified ${backgrounds.length}/${availableBackgrounds.length} changed theme manifests and ${sampledChunks} chunks (${bytes} bytes).`);
  return {
    backgrounds: backgrounds.length,
    availableBackgrounds: availableBackgrounds.length,
    bytes,
    sampledChunks,
  };
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
