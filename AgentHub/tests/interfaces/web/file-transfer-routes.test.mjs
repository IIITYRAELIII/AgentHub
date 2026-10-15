import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { calculateJwkThumbprint, CompactSign, exportJWK, generateKeyPair } from "jose";

import { FileTransferRoutes } from "../../../src/interfaces/web/file-transfer-routes.mjs";
import { fileTransferPolicy, transferSessionSelector } from "../../../src/domain/file-transfer.mjs";
import { FileTransferService } from "../../../src/infrastructure/filesystem/file-transfer-service.mjs";
import { FileTransferStore } from "../../../src/infrastructure/persistence/file-transfer-store.mjs";

const assetsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/web-app");
const policy = Object.freeze({
  enabled: true,
  publicBaseUrl: "https://downloads.example.test",
  trustedProxyAddresses: [],
});

async function withRoutes(service, run, authorize = async () => ({ source: "local-mini-app" })) {
  const routes = new FileTransferRoutes({ assetsDirectory, policy, service });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (await routes.handlePublic(request, response, request.method, url)) return;
    if (await routes.handleOwner(request, response, request.method, url, authorize)) return;
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const publicHeaders = Object.freeze({
  Origin: policy.publicBaseUrl,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/json",
});
const capability = Object.freeze({
  kid: "transfer-v1",
  shareId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  secret: "s".repeat(43),
});
const credential = "v1.transfer-v1.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb." + "x".repeat(43);
const selector = transferSessionSelector(credential);
const sessionPath = `/transfer/api/session/${selector}`;
const sessionCookieName = `__Secure-agenthub_transfer_${selector}`;

test("recipient landing GET and HEAD are isolated and never claim", async () => {
  const calls = [];
  await withRoutes(new Proxy({ publicGate: async () => calls.push("gate") }, {
    get(target, property) { return target[property] ?? (() => calls.push(String(property))); },
  }), async (base) => {
    const get = await fetch(`${base}/transfer/#ignored`);
    assert.equal(get.status, 200);
    assert.match(await get.text(), /Получение файла/u);
    assert.match(get.headers.get("content-security-policy"), /default-src 'none'/u);
    assert.equal(get.headers.get("cache-control"), "no-store");
    assert.equal(get.headers.get("referrer-policy"), "no-referrer");

    const head = await fetch(`${base}/transfer/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.deepEqual(calls, []);

    const scanner = await fetch(`${base}/transfer/api/claim`, { method: "HEAD" });
    assert.equal(scanner.status, 410);
    assert.deepEqual(calls, []);
  });
});

test("public APIs rate gate before service work and keep unavailable responses neutral", async () => {
  const calls = [];
  const service = {
    publicGate: async (address, action) => { calls.push(["gate", address, action]); return "ip-hash"; },
    inspect: async (value) => { calls.push(["inspect", value]); return { name: "700 МБ — отчёт.bin", size: 734003200, expiresAt: 1_800_000_000_000 }; },
  };
  await withRoutes(service, async (base) => {
    const ok = await fetch(`${base}/transfer/api/inspect`, {
      method: "POST", headers: publicHeaders, body: JSON.stringify(capability),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: "700 МБ — отчёт.bin", size: 734003200, expiresAt: 1_800_000_000_000 });
    assert.deepEqual(calls.map((entry) => entry[0]), ["gate", "inspect"]);

    calls.length = 0;
    const badOrigin = await fetch(`${base}/transfer/api/inspect`, {
      method: "POST", headers: { ...publicHeaders, Origin: "https://attacker.test" }, body: JSON.stringify(capability),
    });
    assert.equal(badOrigin.status, 410);
    assert.deepEqual(await badOrigin.json(), { error: "unavailable" });
    assert.deepEqual(calls, []);
  });
});

test("claim sets only a secure scoped HttpOnly session cookie", async () => {
  const service = {
    publicGate: async () => "ip-hash",
    claim: async () => ({ credential, selector, expiresAt: Date.now() + 60_000 }),
  };
  await withRoutes(service, async (base) => {
    const response = await fetch(`${base}/transfer/api/claim`, {
      method: "POST", headers: publicHeaders,
      body: JSON.stringify({ ...capability, payload: "payload", proof: "proof", publicJwk: { kty: "EC" } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session, selector);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, new RegExp(`^${sessionCookieName}=`, "u"));
    assert.match(cookie, new RegExp(`Path=${sessionPath}/`, "u"));
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /Secure/u);
    assert.match(cookie, /SameSite=Strict/u);
  });
});

test("download requires the exact Range and If-Range and finalizes only on response finish", async () => {
  const delivered = [];
  let activated = 0;
  const active = {
    name: "a".repeat(179) + "🧪.bin", size: 4, start: 0, end: 3, etag: '"sha256:abc"',
  };
  const service = {
    publicGate: async () => "ip-hash",
    activatePlan: async () => { activated += 1; return active; },
    streamPlan: async (_active, output) => {
      assert.equal(output.write(Buffer.from("data")), true);
      return async (value) => { delivered.push(value); };
    },
  };
  const cookie = `${sessionCookieName}=${credential}`;
  const payload = JSON.stringify({ path: `${sessionPath}/download`, start: 0, end: 3, etag: active.etag });
  await withRoutes(service, async (base) => {
    const rejected = await fetch(`${base}${sessionPath}/download`, {
      method: "POST", headers: { ...publicHeaders, Cookie: cookie, Range: "bytes=1-3", "If-Range": active.etag },
      body: JSON.stringify({ payload, proof: "proof" }),
    });
    assert.equal(rejected.status, 410);
    assert.equal(activated, 0);

    const response = await fetch(`${base}${sessionPath}/download`, {
      method: "POST", headers: { ...publicHeaders, Cookie: cookie, Range: "bytes=0-3", "If-Range": active.etag },
      body: JSON.stringify({ payload, proof: "proof" }),
    });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "data");
    assert.equal(response.headers.get("accept-ranges"), "none");
    assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''.*%F0%9F%A7%AA/u);
    assert.ok(response.headers.get("content-disposition").length < 800);
    active.name = "before-\ud83e-after.bin";
    const malformed = await fetch(`${base}${sessionPath}/download`, {
      method: "POST", headers: { ...publicHeaders, Cookie: cookie, Range: "bytes=0-3", "If-Range": active.etag },
      body: JSON.stringify({ payload, proof: "proof" }),
    });
    assert.equal(malformed.status, 206);
    assert.equal(await malformed.text(), "data");
    assert.match(malformed.headers.get("content-disposition"), /%EF%BF%BD/u);
    assert.deepEqual(delivered, [true, true]);
  });
});

test("session-specific cookie paths preserve two concurrent recipients and reject copied selectors", async () => {
  const credentialA = credential;
  const credentialB = "v1.transfer-v1.cccccccc-cccc-4ccc-8ccc-cccccccccccc." + "y".repeat(43);
  const selectorA = transferSessionSelector(credentialA);
  const selectorB = transferSessionSelector(credentialB);
  const cookieA = `__Secure-agenthub_transfer_${selectorA}=${credentialA}`;
  const cookieB = `__Secure-agenthub_transfer_${selectorB}=${credentialB}`;
  const seen = [];
  const service = {
    publicGate: async () => "ip-hash",
    createPlan: async ({ credential: value }) => { seen.push(value); return { payload: "plan" }; },
  };
  await withRoutes(service, async (base) => {
    for (const current of [selectorA, selectorB, selectorA]) {
      const response = await fetch(`${base}/transfer/api/session/${current}/plan`, {
        method: "POST", headers: { ...publicHeaders, Cookie: `${cookieA}; ${cookieB}` },
        body: JSON.stringify({ requestId: "z".repeat(43), start: 0, end: 3 }),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(seen, [credentialA, credentialB, credentialA]);
    const copiedSelector = await fetch(`${base}/transfer/api/session/${selectorA}/plan`, {
      method: "POST", headers: { ...publicHeaders, Cookie: `__Secure-agenthub_transfer_${selectorA}=${credentialB}` },
      body: JSON.stringify({ requestId: "z".repeat(43), start: 0, end: 3 }),
    });
    assert.equal(copiedSelector.status, 410);
    assert.equal(seen.length, 3);
  });
});

test("post-admission setup failures compensate exactly once before bytes", async () => {
  const finalized = [];
  let streamed = 0;
  const service = {
    publicGate: async () => "ip-hash",
    activatePlan: async () => ({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", instanceId: "boot",
      artifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "a".repeat(179) + "\ud83e", size: 4,
      start: 0, end: 3, etag: '"sha256:test"' }),
    abortPlan: async () => finalized.push(false),
    streamPlan: async () => { streamed += 1; return async (delivered) => finalized.push(delivered); },
  };
  const routes = new FileTransferRoutes({ assetsDirectory, policy, service });
  const payload = JSON.stringify({ path: `${sessionPath}/download`, start: 0, end: 3, etag: '"sha256:test"' });
  const request = Readable.from([Buffer.from(JSON.stringify({ payload, proof: "proof" }))]);
  request.headers = { origin: policy.publicBaseUrl, "sec-fetch-site": "same-origin", "content-type": "application/json",
    cookie: `${sessionCookieName}=${credential}`,
    range: "bytes=0-3", "if-range": '"sha256:test"' };
  request.socket = { remoteAddress: "127.0.0.1" };
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = () => { throw new Error("injected writeHead failure"); };
  response.destroy = () => { response.destroyed = true; };
  response.end = () => {};
  await routes.handlePublic(request, response, "POST", new URL(`https://downloads.example.test${sessionPath}/download`));
  assert.equal(streamed, 0);
  assert.deepEqual(finalized, [false]);
});

test("client close after headers but before first byte finalizes the admitted request once", async () => {
  const finalized = [];
  let streamed = 0;
  const service = {
    publicGate: async () => "ip-hash",
    activatePlan: async () => ({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", instanceId: "boot",
      artifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "safe.bin", size: 4,
      start: 0, end: 3, etag: '"sha256:test"' }),
    abortPlan: async () => finalized.push(false),
    streamPlan: async () => { streamed += 1; return async (delivered) => finalized.push(delivered); },
  };
  const routes = new FileTransferRoutes({ assetsDirectory, policy, service });
  const payload = JSON.stringify({ path: `${sessionPath}/download`, start: 0, end: 3, etag: '"sha256:test"' });
  const request = Readable.from([Buffer.from(JSON.stringify({ payload, proof: "proof" }))]);
  request.headers = { origin: policy.publicBaseUrl, "sec-fetch-site": "same-origin", "content-type": "application/json",
    cookie: `${sessionCookieName}=${credential}`,
    range: "bytes=0-3", "if-range": '"sha256:test"' };
  request.socket = { remoteAddress: "127.0.0.1" };
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writableFinished = false;
  response.writeHead = () => { response.emit("close"); };
  response.write = () => true;
  response.end = () => {};
  response.destroy = () => { response.destroyed = true; };
  await routes.handlePublic(request, response, "POST", new URL(`https://downloads.example.test${sessionPath}/download`));
  assert.equal(streamed, 0, "a known pre-output close must not enter artifact or output authorization");
  assert.deepEqual(finalized, [false]);
});

test("real HTTP disconnect during activation aborts before output and releases the only stream slot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-transfer-route-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  const realPolicy = fileTransferPolicy({ ...policy, maxStreams: 1 });
  const key = randomBytes(32);
  const store = new FileTransferStore({ dataDir, policy: realPolicy, instanceId: "route-prebyte-instance" });
  const realService = new FileTransferService({ dataDir, roots: [workspace], store, policy: realPolicy,
    keyring: { currentKid: "route-v1", keys: { "route-v1": key } } });
  t.after(async () => {
    await realService.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const bytes = Buffer.alloc(64 * 1024, 0x52);
  const source = path.join(workspace, "pre-activation-close.bin");
  await writeFile(source, bytes);
  const artifact = await realService.prepare({ owner: "route-owner", sourcePath: source, requestId: "route-prepare" });
  await realService.waitForPreparation(artifact.id);
  const share = await realService.createShare({ owner: "route-owner", artifactId: artifact.id,
    requestId: "route-share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const claimId = randomBytes(32).toString("base64url");
  const challenge = await realService.createClaimChallenge({ kid, shareId, secret, claimId, publicJwk });
  const claimProof = await new CompactSign(Buffer.from(challenge.payload))
    .setProtectedHeader({ alg: "ES256", typ: "agenthub-transfer-claim+jws", kid: jkt })
    .sign(privateKey);
  const session = await realService.claim({ kid, shareId, secret, payload: challenge.payload,
    proof: claimProof, publicJwk });
  const plan = await realService.createPlan({ credential: session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const planProof = await new CompactSign(Buffer.from(plan.payload))
    .setProtectedHeader({ alg: "ES256", typ: "agenthub-transfer-download+jws", kid: jkt })
    .sign(privateKey);
  const parsedPlan = JSON.parse(plan.payload);

  let activationStartedResolve;
  let releaseActivationResolve;
  const activationStarted = new Promise((resolve) => { activationStartedResolve = resolve; });
  const releaseActivation = new Promise((resolve) => { releaseActivationResolve = resolve; });
  let activated = null;
  let streamCalls = 0;
  let abortCalls = 0;
  let authorizeCalls = 0;
  let writes = 0;
  const authorizeBlockOutput = store.authorizeBlockOutput.bind(store);
  store.authorizeBlockOutput = async (...args) => {
    authorizeCalls += 1;
    return authorizeBlockOutput(...args);
  };
  const service = {
    publicGate: (...args) => realService.publicGate(...args),
    activatePlan: async (...args) => {
      activationStartedResolve();
      await releaseActivation;
      activated = await realService.activatePlan(...args);
      return activated;
    },
    abortPlan: async (...args) => { abortCalls += 1; return realService.abortPlan(...args); },
    streamPlan: async (...args) => { streamCalls += 1; return realService.streamPlan(...args); },
  };
  const routes = new FileTransferRoutes({ assetsDirectory, policy: realPolicy, service });
  let handlerDoneResolve;
  let responseClosedResolve;
  const handlerDone = new Promise((resolve) => { handlerDoneResolve = resolve; });
  const responseClosed = new Promise((resolve) => { responseClosedResolve = resolve; });
  const server = createServer(async (request, response) => {
    response.once("close", responseClosedResolve);
    const write = response.write.bind(response);
    response.write = (...args) => { writes += 1; return write(...args); };
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      await routes.handlePublic(request, response, request.method, url);
    } finally { handlerDoneResolve(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const address = server.address();
  const body = JSON.stringify({ payload: plan.payload, proof: planProof });
  const client = httpRequest({ hostname: "127.0.0.1", port: address.port, method: "POST",
    path: parsedPlan.path, headers: { ...publicHeaders,
      Cookie: `__Secure-agenthub_transfer_${session.selector}=${session.credential}`,
      Range: `bytes=${parsedPlan.start}-${parsedPlan.end}`, "If-Range": parsedPlan.etag,
      "Content-Length": Buffer.byteLength(body) } });
  client.on("error", () => {});
  client.end(body);
  await activationStarted;
  client.destroy();
  await responseClosed;
  releaseActivationResolve();
  let timeout;
  try {
    await Promise.race([handlerDone, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("route handler did not settle after activation")), 5_000);
    })]);
  } finally { clearTimeout(timeout); }

  assert.ok(activated, "activation must commit after the disconnect latch is set");
  assert.equal(streamCalls, 0);
  assert.equal(authorizeCalls, 0);
  assert.equal(writes, 0);
  assert.equal(abortCalls, 1);
  const db = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  try {
    const states = db.prepare(`SELECT r.state request_state,p.state plan_state,t.state share_state
      FROM transfer_requests r JOIN transfer_plans p ON p.id=r.plan_id
      JOIN transfer_sessions s ON s.id=r.session_id JOIN transfer_shares t ON t.id=s.share_id
      WHERE r.id=?`).get(activated.id);
    assert.deepEqual({ ...states }, { request_state: "aborted", plan_state: "aborted", share_state: "claimed" });
    assert.equal(db.prepare("SELECT count(*) n FROM transfer_requests WHERE state IN ('active','output_candidate','terminal_candidate')").get().n, 0);
  } finally { db.close(); }
  const replacement = await realService.createPlan({ credential: session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const replacementProof = await new CompactSign(Buffer.from(replacement.payload))
    .setProtectedHeader({ alg: "ES256", typ: "agenthub-transfer-download+jws", kid: jkt })
    .sign(privateKey);
  const next = await realService.activatePlan({ credential: session.credential, payload: replacement.payload,
    proof: replacementProof, ipHash: "ip:replacement" });
  await realService.abortPlan(next);
});

test("owner mutations require authenticated server identity and CSRF", async () => {
  const calls = [];
  const service = {
    ownerStatus: async (owner, sourcePath) => {
      calls.push([owner, sourcePath]);
      return { file: { name: "report.bin", size: 7 }, artifact: null, share: null };
    },
  };
  await withRoutes(service, async (base) => {
    const denied = await fetch(`${base}/api/file-transfer/owner/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "D:/work/report.bin" }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(calls, []);

    const ok = await fetch(`${base}/api/file-transfer/owner/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        "Sec-Fetch-Site": "same-origin",
        "X-Agent-Hub-Transfer-CSRF": "1",
      },
      body: JSON.stringify({ path: "D:/work/report.bin" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [["local", "D:/work/report.bin"]]);
    const value = await ok.json();
    assert.equal(value.file.name, "report.bin");
    assert.equal(value.ttlOptions.length, 4);
  });
});
