import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  publicationCheckpointFile,
  publicationCheckpointStore,
} from "../src/infrastructure/persistence/publication-checkpoint.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { loadThemeRegistry } = require("../theme-registry.cjs");
const root = path.resolve(import.meta.dirname, "..");
const themeRoot = path.join(root, "assets", "web-app");
const publishedRoot = path.join(root, "cloudflare-worker", "public");
export const WORKER_VERIFY_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const WORKER_VERIFICATION_CHECKPOINT_VERSION = 1;

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function fingerprint(value) {
  return sha256(JSON.stringify(value));
}

export function workerVerificationCheckpointFile(environment = process.env) {
  return path.join(
    path.dirname(publicationCheckpointFile(environment)),
    "worker-verification-checkpoint.json",
  );
}

export function workerVerificationCheckpointStore(file = workerVerificationCheckpointFile()) {
  return publicationCheckpointStore(file);
}

export async function fetchWithCurl(target, { signal } = {}) {
  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  try {
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
  } catch (error) {
    const receivedBytes = Buffer.isBuffer(error?.stdout) ? error.stdout.length : 0;
    const location = new URL(target);
    throw new Error(
      `${location.pathname}${location.search}: curl response did not complete after ${receivedBytes} bytes: ${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
}

async function readCompleteHttp1(http1Fetch, target, timeoutMs) {
  const response = await http1Fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(target).pathname}: HTTP ${response.status}`);
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      receivedBytes += chunk.length;
      chunks.push(chunk);
    }
  } catch (error) {
    const location = new URL(target);
    throw new Error(
      `${location.pathname}${location.search}: response body did not complete after ${receivedBytes} bytes: ${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
  return Buffer.concat(chunks, receivedBytes);
}

function exactIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function createVerificationCheckpointSession({ checkpoint, identity, log }) {
  const saved = checkpoint ? await checkpoint.read() : null;
  const reusable = saved?.version === WORKER_VERIFICATION_CHECKPOINT_VERSION
    && exactIdentity(saved.identity, identity)
    && saved.completed && typeof saved.completed === "object";
  const completed = reusable ? { ...saved.completed } : {};
  const write = async () => {
    if (!checkpoint) return;
    await checkpoint.write({
      version: WORKER_VERIFICATION_CHECKPOINT_VERSION,
      identity,
      completed,
      updatedAt: new Date().toISOString(),
    });
  };
  if (checkpoint && !reusable) await write();
  return {
    async complete({ key, expected, read, validate }) {
      const expectedFingerprint = fingerprint(expected);
      const savedEntry = completed[key];
      if (savedEntry?.fingerprint === expectedFingerprint) {
        try {
          const value = validate(savedEntry.evidence);
          log(`[Worker verify] ${key}: уже подтверждено, продолжаю`);
          return value;
        } catch {
          delete completed[key];
          await write();
        }
      }
      const evidence = await read();
      const value = validate(evidence);
      completed[key] = { fingerprint: expectedFingerprint, evidence };
      await write();
      return value;
    },
    clear: async () => checkpoint?.clear(),
  };
}

function directShellUrls(html) {
  return [...html.matchAll(/(?:href|src)="(https:\/\/home\.[^"]+)"/giu)]
    .map((match) => new URL(match[1]));
}

async function verifyLargeStaticHttp1({ html, http1Fetch, requestTimeoutMs, sourceRoot, checkpoint }) {
  const candidates = [];
  for (const target of directShellUrls(html)) {
    try {
      const source = await readFile(path.join(sourceRoot, ...target.pathname.slice(1).split("/")));
      candidates.push({ source, target });
    } catch {
      // Only shell files that map to the canonical local web assets are evidence.
    }
  }
  candidates.sort((left, right) => right.source.length - left.source.length);
  const candidate = candidates.find(({ source }) => source.length > 100 * 1024);
  if (!candidate) throw new Error("Published Worker shell has no direct large static HTTP/1.1 probe target");
  const expectedHash = sha256(candidate.source);
  if (candidate.target.searchParams.get("v") !== expectedHash.slice(0, 12)) {
    throw new Error("Published large static target has an invalid immutable revision");
  }
  return checkpoint.complete({
    key: "large-static",
    expected: { url: candidate.target.href, bytes: candidate.source.length, hash: expectedHash },
    read: async () => {
      const body = await readCompleteHttp1(http1Fetch, candidate.target, requestTimeoutMs);
      return { bytes: body.length, hash: sha256(body), url: candidate.target.href };
    },
    validate: (evidence) => {
      if (evidence?.bytes !== candidate.source.length || evidence?.hash !== expectedHash
        || evidence?.url !== candidate.target.href) {
        throw new Error("Published large static target is partial or damaged over HTTP/1.1");
      }
      return evidence;
    },
  });
}

function validateAttachmentProbeManifest(manifest, expectedPage) {
  const valid = manifest?.protocol === "agent-hub-attachment-chunks-v1"
    && manifest?.id === "dashboard-transport-probe-v1"
    && Number.isSafeInteger(manifest?.size) && manifest.size > 100 * 1024
    && Number.isSafeInteger(manifest?.count)
    && manifest.count === Math.ceil(manifest.size / manifest.chunkBytes)
    && Number.isSafeInteger(manifest?.chunkBytes) && manifest.chunkBytes > 0 && manifest.chunkBytes < 25 * 1024
    && Number.isSafeInteger(manifest?.pageCount) && manifest.pageCount > 0
    && manifest?.page === expectedPage
    && /^[a-f0-9]{64}$/u.test(String(manifest?.hash ?? ""))
    && Array.isArray(manifest?.chunks) && manifest.chunks.length > 0;
  if (!valid) throw new Error("Synthetic attachment transport returned an invalid manifest");
  return manifest;
}

async function verifyAttachmentProbeHttp1({ base, http1Fetch, requestTimeoutMs, checkpoint }) {
  const manifestUrl = new URL("/api/transport-probe/attachment?mode=manifest&page=0", base);
  const first = await checkpoint.complete({
    key: "attachment/manifest/0",
    expected: { url: manifestUrl.href, page: 0 },
    read: async () => {
      const body = await readCompleteHttp1(http1Fetch, manifestUrl, requestTimeoutMs);
      if (body.length > 24 * 1024) throw new Error("Synthetic attachment manifest exceeds response bound");
      return JSON.parse(body.toString("utf8"));
    },
    validate: (evidence) => validateAttachmentProbeManifest(evidence, 0),
  });
  const pages = [first];
  for (let page = 1; page < first.pageCount; page += 1) {
    const target = new URL(`/api/transport-probe/attachment?mode=manifest&page=${page}`, base);
    const manifest = await checkpoint.complete({
      key: `attachment/manifest/${page}`,
      expected: {
        url: target.href,
        page,
        id: first.id,
        size: first.size,
        hash: first.hash,
        count: first.count,
        chunkBytes: first.chunkBytes,
        pageCount: first.pageCount,
      },
      read: async () => {
        const body = await readCompleteHttp1(http1Fetch, target, requestTimeoutMs);
        if (body.length > 24 * 1024) throw new Error("Synthetic attachment manifest exceeds response bound");
        return JSON.parse(body.toString("utf8"));
      },
      validate: (evidence) => validateAttachmentProbeManifest(evidence, page),
    });
    if (["id", "size", "hash", "count", "chunkBytes", "pageCount"].some(
      (key) => manifest[key] !== first[key],
    )) {
      throw new Error("Synthetic attachment manifest pages are inconsistent");
    }
    pages.push(manifest);
  }
  const descriptors = pages.flatMap((page) => page.chunks);
  if (descriptors.length !== first.count || descriptors.some((chunk, index) => (
    chunk?.index !== index
    || !Number.isSafeInteger(chunk?.size)
    || chunk.size !== Math.min(first.chunkBytes, first.size - index * first.chunkBytes)
    || !/^[a-f0-9]{64}$/u.test(String(chunk?.hash ?? ""))
  ))) {
    throw new Error("Synthetic attachment manifest has unordered or invalid chunks");
  }
  const chunks = [];
  for (const descriptor of descriptors) {
    const target = new URL(`/api/transport-probe/attachment?mode=chunk&index=${descriptor.index}`, base);
    const body = await checkpoint.complete({
      key: `attachment/chunk/${descriptor.index}`,
      expected: { url: target.href, ...descriptor },
      read: async () => ({
        base64: (await readCompleteHttp1(http1Fetch, target, requestTimeoutMs)).toString("base64"),
      }),
      validate: (evidence) => {
        if (typeof evidence?.base64 !== "string") {
          throw new Error(`Synthetic attachment chunk ${descriptor.index} has invalid checkpoint evidence`);
        }
        const restored = Buffer.from(evidence.base64, "base64");
        if (restored.toString("base64") !== evidence.base64
          || restored.length !== descriptor.size || sha256(restored) !== descriptor.hash) {
          throw new Error(`Synthetic attachment chunk ${descriptor.index} is partial or damaged over HTTP/1.1`);
        }
        return restored;
      },
    });
    chunks.push(body);
  }
  const body = Buffer.concat(chunks, first.size);
  if (body.length !== first.size || sha256(body) !== first.hash) {
    throw new Error("Synthetic attachment assembly is partial or damaged over HTTP/1.1");
  }
  return { bytes: body.length, chunks: chunks.length, hash: first.hash };
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
  http1Fetch = fetchWithCurl,
  changedFiles = null,
  requestTimeoutMs = WORKER_VERIFY_REQUEST_TIMEOUT_MS,
  log = console.log,
  checkpoint = null,
  workerSourceFile = path.join(root, "cloudflare-worker", "src", "worker.mjs"),
} = {}) {
  const base = new URL(baseUrl);
  const index = await readFile(path.join(deployedRoot, "index.html"), "utf8");
  const indexHash = sha256(index);
  const workerSourceHash = sha256(await readFile(workerSourceFile));
  const catalog = themeCatalog(index);
  const published = new Map(catalog.map((theme) => [theme.id, theme]));
  const registry = loadThemeRegistry(sourceRoot);
  const availableBackgrounds = registry.themes.flatMap((theme) => theme.backgrounds
    .filter((background) => background.asset)
    .map((background) => ({ theme, background })));
  const backgrounds = changedBackgrounds(availableBackgrounds, changedFiles);
  const checkpointSession = await createVerificationCheckpointSession({
    checkpoint,
    identity: {
      baseUrl: base.href,
      indexHash,
      workerSourceHash,
      backgrounds: backgrounds.map(({ theme, background }) => `${theme.id}/${background.id}`).sort(),
    },
    log,
  });
  const remoteIndex = await checkpointSession.complete({
    key: "index",
    expected: { url: base.href, hash: indexHash },
    read: async () => ({
      body: await readWithRetry(
        fetchImpl,
        base,
        (response) => response.text(),
        { timeoutMs: requestTimeoutMs, log },
      ),
    }),
    validate: (evidence) => {
      if (typeof evidence?.body !== "string" || sha256(evidence.body) !== indexHash) {
        throw new Error("Published Worker index does not match the built release");
      }
      return evidence.body;
    },
  });
  const largeStatic = await verifyLargeStaticHttp1({
    html: remoteIndex,
    http1Fetch,
    requestTimeoutMs,
    sourceRoot,
    checkpoint: checkpointSession,
  });
  const attachmentProbe = await verifyAttachmentProbeHttp1({
    base,
    http1Fetch,
    requestTimeoutMs,
    checkpoint: checkpointSession,
  });
  let bytes = 0;
  let sampledChunks = 0;
  await mapConcurrent(backgrounds, 1, async ({ theme, background }) => {
    const assetUrl = published.get(theme.id)?.backgrounds?.find((item) => item.id === background.id)?.assetUrl;
    if (!/\.json(?:[?#]|$)/iu.test(String(assetUrl ?? ""))) {
      throw new Error(`Published background ${theme.id}/${background.id} does not use chunked text transport`);
    }
    const source = await readFile(path.join(theme.directory, ...background.asset.split("/")));
    const sourceHash = sha256(source);
    const manifestTarget = new URL(assetUrl, base);
    const validateManifest = (manifest) => {
      if (!Array.isArray(manifest?.parts) || !manifest.parts.length || manifest.parts.length > 512) {
        throw new Error(`Published background ${theme.id}/${background.id} has an invalid manifest`);
      }
      if (Number(manifest.bytes) !== source.length || manifest.sha256 !== sourceHash) {
        throw new Error(`Published background ${theme.id}/${background.id} manifest does not match its source`);
      }
      if (manifest.directUrl) {
        const directTarget = new URL(manifest.directUrl);
        if (directTarget.protocol !== "https:" || directTarget.searchParams.get("v") !== sourceHash.slice(0, 12)) {
          throw new Error(`Published background ${theme.id}/${background.id} has an invalid direct URL revision`);
        }
      }
      return manifest;
    };
    const manifest = await checkpointSession.complete({
      key: `background/${theme.id}/${background.id}/manifest`,
      expected: { url: manifestTarget.href, bytes: source.length, hash: sourceHash },
      read: async () => readWithRetry(
        fetchImpl,
        manifestTarget,
        (response) => response.json(),
        { timeoutMs: requestTimeoutMs, log },
      ),
      validate: validateManifest,
    });
    const encoded = source.toString("base64");
    const readPart = async (index) => {
      const target = new URL(manifest.parts[index], base);
      return checkpointSession.complete({
        key: `background/${theme.id}/${background.id}/chunk/${index}`,
        expected: { url: target.href, index, bytes: source.length, hash: sourceHash },
        read: async () => ({
          text: (await readWithRetry(
            fetchImpl,
            target,
            (response) => response.text(),
            { timeoutMs: requestTimeoutMs, log },
          )).trim(),
        }),
        validate: (evidence) => {
          if (typeof evidence?.text !== "string" || Buffer.byteLength(evidence.text) > 20 * 1024) {
            throw new Error(`Published background ${theme.id}/${background.id} has an invalid sampled chunk ${index}`);
          }
          return evidence.text;
        },
      });
    };
    const first = await readPart(0);
    if (!first || !encoded.startsWith(first)) {
      throw new Error(`Published background ${theme.id}/${background.id} has an invalid first chunk`);
    }
    const expectedPartCount = Math.ceil(encoded.length / first.length);
    if (expectedPartCount !== manifest.parts.length) {
      throw new Error(`Published background ${theme.id}/${background.id} has an invalid chunk count`);
    }
    const sampleIndexes = [...new Set([0, Math.floor((manifest.parts.length - 1) / 2), manifest.parts.length - 1])];
    for (const index of sampleIndexes.slice(1)) {
      const chunk = await readPart(index);
      if (chunk !== encoded.slice(index * first.length, (index + 1) * first.length)) {
        throw new Error(`Published background ${theme.id}/${background.id} has an invalid sampled chunk ${index}`);
      }
    }
    sampledChunks += sampleIndexes.length;
    bytes += source.length;
  });
  log(`Verified ${backgrounds.length}/${availableBackgrounds.length} changed theme manifests and ${sampledChunks} chunks (${bytes} bytes), ${largeStatic.bytes} static bytes and ${attachmentProbe.bytes} attachment bytes over HTTP/1.1.`);
  const result = {
    backgrounds: backgrounds.length,
    availableBackgrounds: availableBackgrounds.length,
    bytes,
    sampledChunks,
    largeStaticBytes: largeStatic.bytes,
    largeStaticHash: largeStatic.hash,
    attachmentProbeBytes: attachmentProbe.bytes,
    attachmentProbeChunks: attachmentProbe.chunks,
  };
  await checkpointSession.clear();
  return result;
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
  await verifyThemeDeployment({
    baseUrl: routeBaseUrl(config),
    checkpoint: workerVerificationCheckpointStore(),
  });
}
