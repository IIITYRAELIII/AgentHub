import { isIP } from "node:net";
import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  TRANSFER_ID,
  TRANSFER_SESSION_SELECTOR,
  TRANSFER_TTLS,
  transferError,
  transferFilename,
  transferSessionSelector,
} from "../../domain/file-transfer.mjs";

const SESSION_COOKIE_PREFIX = "__Secure-agenthub_transfer_";
const REQUEST_ID = /^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;
const VSCODE_WEBVIEW_ORIGIN = /^(?:vscode-webview:\/\/[a-z0-9-]+|https:\/\/[a-z0-9-]+\.vscode-cdn\.net)$/iu;
const PUBLIC_ASSETS = new Map([
  ["/transfer", ["file-transfer.html", "text/html; charset=utf-8"]],
  ["/transfer/", ["file-transfer.html", "text/html; charset=utf-8"]],
  ["/transfer/app.js", ["file-transfer-recipient.js", "text/javascript; charset=utf-8"]],
  ["/transfer/styles.css", ["file-transfer-recipient.css", "text/css; charset=utf-8"]],
]);

function strictHeaders(contentType, extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...extra,
  };
}

function send(response, status, body = "", method = "GET", contentType = "text/plain; charset=utf-8", extra = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, strictHeaders(contentType, { "Content-Length": String(bytes.length), ...extra }));
  response.end(method === "HEAD" ? "" : bytes);
}

function json(response, status, value, method = "POST", extra = {}) {
  send(response, status, JSON.stringify(value), method, "application/json; charset=utf-8", extra);
}

function unavailable(response, method = "POST", status = 410) {
  json(response, status, { error: "unavailable" }, method);
}

async function readJson(request, maxBytes = 16 * 1024) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw transferError("transfer-unavailable", 410);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw transferError("transfer-unavailable", 410);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw transferError("transfer-unavailable", 410); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw transferError("transfer-unavailable", 410);
  return value;
}

function exactShape(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw transferError("transfer-unavailable", 410);
  }
  return value;
}

function cookieValue(request, name) {
  for (const entry of String(request.headers.cookie ?? "").split(";")) {
    const index = entry.indexOf("=");
    if (index > 0 && entry.slice(0, index).trim() === name) return entry.slice(index + 1).trim();
  }
  return "";
}

function sessionCookieName(selector) { return `${SESSION_COOKIE_PREFIX}${selector}`; }

function sessionCookie(credential, selector, expiresAt) {
  const maxAge = Math.max(1, Math.floor((Number(expiresAt) - Date.now()) / 1_000));
  return `${sessionCookieName(selector)}=${credential}; Max-Age=${maxAge}; Path=/transfer/api/session/${selector}/; HttpOnly; Secure; SameSite=Strict`;
}

function normalizedAddress(value) {
  const raw = String(value ?? "").trim();
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

function clientAddress(request, trustedProxies) {
  const remote = normalizedAddress(request.socket?.remoteAddress);
  if (!trustedProxies.has(remote)) return isIP(remote) ? remote : "unknown";
  const cf = String(request.headers["cf-connecting-ip"] ?? "").trim();
  if (isIP(cf)) return cf;
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return isIP(forwarded) ? forwarded : "unknown";
}

function ownerIdentity(authorization) {
  if (["local-mini-app", "local-vscode-webview"].includes(authorization?.source)) return "local";
  if (authorization?.source === "trusted-device" && authorization.deviceId) return `device:${authorization.deviceId}`;
  if (authorization?.source === "telegram-mini-app" && authorization.userId) return `telegram:${authorization.userId}`;
  throw transferError("transfer-owner-unavailable", 403);
}

function ownerCsrfAllowed(request, authorization) {
  if (String(request.headers["x-agent-hub-transfer-csrf"] ?? "") !== "1") return false;
  const origin = String(request.headers.origin ?? "").trim();
  if (!origin) return false;
  if (authorization?.source === "local-vscode-webview") return VSCODE_WEBVIEW_ORIGIN.test(origin);
  try {
    const parsed = new URL(origin);
    return parsed.host === String(request.headers.host ?? "").trim()
      && ["http:", "https:"].includes(parsed.protocol)
      && ["same-origin", "none", ""].includes(String(request.headers["sec-fetch-site"] ?? ""));
  } catch {
    return false;
  }
}

function publicOriginAllowed(request, publicBaseUrl) {
  const origin = String(request.headers.origin ?? "").trim();
  return origin === publicBaseUrl
    && ["same-origin", "none", ""].includes(String(request.headers["sec-fetch-site"] ?? ""));
}

function safeDisposition(name) {
  const filename = transferFilename(name ?? "file.bin");
  const ascii = [...filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_")].slice(0, 120).join("") || "file.bin";
  let encoded = "";
  for (const character of filename) {
    const part = encodeURIComponent(character).replace(/[!'()*]/gu,
      (value) => `%${value.codePointAt(0).toString(16).toUpperCase()}`);
    if (encoded.length + part.length > 512) break;
    encoded += part;
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded || "file.bin"}`;
}

function drain(response) {
  return new Promise((resolve, reject) => {
    if (response.destroyed || response.writableEnded) {
      reject(transferError("transfer-output-closed", 410));
      return;
    }
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(transferError("transfer-output-closed", 410)); };
    const onError = () => { cleanup(); reject(transferError("transfer-output-closed", 410)); };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function responseAbortLatch(response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  response.once("error", abort);
  if (response.destroyed || response.writableEnded) controller.abort();
  return {
    controller,
    cleanup() {
      response.off("close", abort);
      response.off("error", abort);
    },
  };
}

export class FileTransferRoutes {
  #assets = new Map();
  #assetsDirectory;
  #assetBundleProvider;
  #policy;
  #service;
  #trustedProxies;

  constructor({ assetsDirectory, assetBundleProvider = null, policy, service }) {
    this.#assetsDirectory = path.resolve(assetsDirectory);
    this.#assetBundleProvider = typeof assetBundleProvider === "function" ? assetBundleProvider : null;
    this.#policy = policy;
    this.#service = service;
    this.#trustedProxies = new Set((policy?.trustedProxyAddresses ?? []).map(normalizedAddress));
  }

  get enabled() { return this.#policy?.enabled === true && Boolean(this.#service); }

  async #asset(name) {
    const bundle = await this.#assetBundleProvider?.();
    const directory = path.resolve(bundle?.assetsDirectory ?? this.#assetsDirectory);
    const key = `${String(bundle?.id ?? directory)}\0${name}`;
    if (!this.#assets.has(key) && this.#assets.size >= 12) this.#assets.clear();
    if (!this.#assets.has(key)) this.#assets.set(key, await readFile(path.join(directory, name)));
    return this.#assets.get(key);
  }

  async handlePublic(request, response, method, url) {
    if (!url.pathname.startsWith("/transfer")) return false;
    if (!this.enabled) {
      send(response, 404, "Not Found\n", method);
      return true;
    }
    const descriptor = PUBLIC_ASSETS.get(url.pathname);
    if (descriptor) {
      if (!["GET", "HEAD"].includes(method)) {
        send(response, 405, "Method Not Allowed\n", method, "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
        return true;
      }
      try { send(response, 200, await this.#asset(descriptor[0]), method, descriptor[1]); }
      catch { send(response, 500, "Unavailable\n", method); }
      return true;
    }
    if (!url.pathname.startsWith("/transfer/api/")) {
      send(response, 404, "Not Found\n", method);
      return true;
    }
    if (method !== "POST" || !publicOriginAllowed(request, this.#policy.publicBaseUrl)) {
      unavailable(response, method);
      return true;
    }
    try {
      const body = await readJson(request);
      const address = clientAddress(request, this.#trustedProxies);
      const relativeAction = url.pathname.slice("/transfer/api/".length);
      const sessionMatch = /^session\/([A-Za-z0-9_-]{43})\/(plan|download)$/u.exec(relativeAction);
      const selector = sessionMatch?.[1] ?? "";
      const action = sessionMatch?.[2] ?? relativeAction;
      const ipHash = await this.#service.publicGate(address, action);
      if (action === "inspect") {
        exactShape(body, ["kid", "shareId", "secret"]);
        const value = await this.#service.inspect(body);
        json(response, 200, { name: value.name, size: value.size, expiresAt: value.expiresAt });
        return true;
      }
      if (action === "challenge") {
        exactShape(body, ["kid", "shareId", "secret", "claimId", "publicJwk"]);
        json(response, 200, await this.#service.createClaimChallenge(body));
        return true;
      }
      if (action === "claim") {
        exactShape(body, ["kid", "shareId", "secret", "payload", "proof", "publicJwk"]);
        const session = await this.#service.claim(body);
        const sessionSelector = session.selector || transferSessionSelector(session.credential);
        json(response, 200, { ok: true, expiresAt: session.expiresAt, session: sessionSelector }, method, {
          "Set-Cookie": sessionCookie(session.credential, sessionSelector, session.expiresAt),
        });
        return true;
      }
      if (!TRANSFER_SESSION_SELECTOR.test(selector)) throw transferError("transfer-unavailable", 410);
      const credential = cookieValue(request, sessionCookieName(selector));
      if (!credential || transferSessionSelector(credential) !== selector) throw transferError("transfer-unavailable", 410);
      if (action === "plan") {
        exactShape(body, ["requestId", "start", "end"]);
        if (!REQUEST_ID.test(String(body.requestId))) throw transferError("transfer-unavailable", 410);
        json(response, 200, await this.#service.createPlan({ credential, ...body }));
        return true;
      }
      if (action === "download") {
        exactShape(body, ["payload", "proof"]);
        let plan;
        try { plan = JSON.parse(String(body.payload)); } catch { throw transferError("transfer-unavailable", 410); }
        const range = `bytes=${plan.start}-${plan.end}`;
        if (plan.path !== url.pathname || String(request.headers.range ?? "") !== range
          || String(request.headers["if-range"] ?? "") !== String(plan.etag ?? "")) {
          throw transferError("transfer-unavailable", 410);
        }
        const responseLifecycle = responseAbortLatch(response);
        try {
          const active = await this.#service.activatePlan({ credential, payload: body.payload, proof: body.proof, ipHash });
          await this.#stream(response, active, responseLifecycle);
        } finally {
          responseLifecycle.cleanup();
        }
        return true;
      }
      unavailable(response, method);
    } catch (error) {
      unavailable(response, method, error?.code === "transfer-rate-limit" ? 429 : 410);
    }
    return true;
  }

  async #stream(response, active, responseLifecycle = null) {
    let finalizer = null;
    let serviceOwnsSettlement = false;
    let abortPromise = null;
    let outcome = null;
    let resolveCompletion;
    const abortController = responseLifecycle?.controller ?? new AbortController();
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const abortBeforeOutput = () => {
      abortPromise ??= this.#service.abortPlan(active);
      return abortPromise;
    };
    const settle = (delivered) => {
      if (outcome !== null) return;
      outcome = delivered;
      if (!delivered) abortController.abort();
      if (finalizer) void finalizer(delivered).catch(() => {}).finally(resolveCompletion);
    };
    response.once("finish", () => settle(true));
    response.once("close", () => { if (!response.writableFinished) settle(false); });
    response.once("error", () => settle(false));
    responseLifecycle?.cleanup();
    if (response.destroyed || response.writableEnded) abortController.abort();
    try {
      if (abortController.signal.aborted) {
        await abortBeforeOutput();
        serviceOwnsSettlement = true;
        resolveCompletion();
        return;
      }
      const headers = strictHeaders("application/octet-stream", {
        "Accept-Ranges": "none",
        "Content-Disposition": safeDisposition(active.name),
        "Content-Length": String(active.end - active.start + 1),
        "Content-Range": `bytes ${active.start}-${active.end}/${active.size}`,
        ETag: active.etag,
      });
      response.writeHead(206, headers);
      if (abortController.signal.aborted) {
        await abortBeforeOutput();
        serviceOwnsSettlement = true;
        resolveCompletion();
        return;
      }
      serviceOwnsSettlement = true;
      finalizer = await this.#service.streamPlan(active, {
        write: (chunk) => response.write(chunk),
        waitForDrain: () => drain(response),
        signal: abortController.signal,
      });
      if (outcome !== null) void finalizer(outcome).catch(() => {}).finally(resolveCompletion);
      else response.end();
      await completion;
    } catch (error) {
      if (!serviceOwnsSettlement) await abortBeforeOutput().catch(() => {});
      resolveCompletion();
      if (!response.destroyed) response.destroy(error);
    }
  }

  async handleOwner(request, response, method, url, authorize) {
    if (!url.pathname.startsWith("/api/file-transfer/owner/")) return false;
    if (!this.enabled || method !== "POST") {
      json(response, this.enabled ? 405 : 404, { ok: false, error: "Недоступно" }, method);
      return true;
    }
    const authorization = await authorize();
    if (!authorization) return true;
    if (!ownerCsrfAllowed(request, authorization)) {
      json(response, 403, { ok: false, error: "Запрос отклонён" }, method);
      return true;
    }
    try {
      const owner = ownerIdentity(authorization);
      const body = await readJson(request);
      const action = url.pathname.slice("/api/file-transfer/owner/".length);
      if (action === "status") {
        exactShape(body, ["path"]);
        json(response, 200, { ok: true, ttlOptions: TRANSFER_TTLS, ...(await this.#service.ownerStatus(owner, body.path)) });
        return true;
      }
      if (action === "prepare") {
        exactShape(body, ["path", "requestId"]);
        if (!REQUEST_ID.test(String(body.requestId))) throw transferError("transfer-invalid-request", 400);
        json(response, 202, { ok: true, artifact: await this.#service.prepare({ owner, sourcePath: body.path, requestId: body.requestId }) });
        return true;
      }
      if (action === "create") {
        exactShape(body, ["artifactId", "requestId", "ttlMs"]);
        if (!TRANSFER_ID.test(String(body.artifactId)) || !REQUEST_ID.test(String(body.requestId))
          || !TRANSFER_TTLS.includes(body.ttlMs)) throw transferError("transfer-invalid-request", 400);
        json(response, 201, { ok: true, share: await this.#service.createShare({ owner, ...body }) });
        return true;
      }
      if (action === "revoke") {
        exactShape(body, ["shareId"]);
        if (!TRANSFER_ID.test(String(body.shareId))) throw transferError("transfer-invalid-request", 400);
        json(response, 200, { ok: true, share: await this.#service.revoke(owner, body.shareId) });
        return true;
      }
      json(response, 404, { ok: false, error: "Недоступно" }, method);
    } catch (error) {
      json(response, Number(error?.statusCode) || 400, { ok: false, code: String(error?.code ?? ""), error: String(error?.message ?? "Ошибка") }, method);
    }
    return true;
  }
}
