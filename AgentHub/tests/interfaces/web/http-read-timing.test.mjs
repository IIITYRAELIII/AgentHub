import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHttpReadTiming } from "../../../src/interfaces/web/http-read-timing.mjs";
import { MiniAppServer, createJsonResponder } from "../../../src/interfaces/web/mini-app-server.mjs";
import { createLocalWebviewSession } from "../../../src/interfaces/web/local-webview-session.mjs";

test("read diagnostics keep original identity, errors, sync CPU and aborted outcome without request content", async () => {
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false, setHeader() {} });
  const spans = []; let now = 0, cpu = 0;
  const timing = createHttpReadTiming({ commandId: "original-1", route: "snapshot", response, record: x => spans.push(x),
    now: () => now, clock: () => 1000 + now, cpu: () => ({ user: cpu, system: 0 }), loop: () => ({ active: now, idle: 0 }) });
  const answer = timing.sync("http-json-encode", () => { now += 20; cpu += 14000; return "body"; });
  assert.equal(answer, "body");
  await assert.rejects(timing.measure("http-snapshot-read", async () => { now += 10; throw new Error("private body"); }));
  response.emit("close"); response.emit("finish");
  assert.ok(spans.every(x => x.commandId === "original-1"));
  const encode = spans.find(x => x.stage === "http-json-encode" && x.outcome === "succeeded");
  assert.equal(encode.monotonicDurationMs, 20);
  assert.equal(encode.metadata.threadCpuWindowMs, 14);
  assert.equal(encode.metadata.synchronous, true);
  assert.equal(spans.at(-1).metadata.failureKind, "aborted");
  assert.equal(spans.filter(x => x.stage === "http-read" && x.outcome !== "started").length, 1);
  assert.doesNotMatch(JSON.stringify(spans), /private body/u);
  assert.equal(createHttpReadTiming({ commandId: "secret invalid id", route: "snapshot" }), null);
});

test("actual HTTP snapshot/health/static boundaries share the requested trace ID without changing payloads", async () => {
  const spans = [], contexts = [], secret = "test".repeat(11);
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0, localAccessSecret: secret,
    journalDatabase: { subscribe: () => () => {} }, recordCommandTrace: span => spans.push(span),
    controlHandler: async ({ context }) => { contexts.push(context); return { version: "same", tasks: [] }; } });
  try {
    const address = await server.start();
    const headers = { Authorization: `webview ${createLocalWebviewSession(secret).token}` };
    const response = await fetch(`${address.url}api/snapshot?clientTraceId=snapshot-original`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: "same", tasks: [] });
    assert.equal(response.headers.get("x-agent-hub-trace-id"), "snapshot-original");
    assert.equal(contexts[0].commandId, "snapshot-original");
    for (const [uri, id] of [["health", "health-original"], ["messages/read-marker.js", "asset-original"]]) {
      const result = await fetch(`${address.url}${uri}?clientTraceId=${id}`);
      assert.equal(result.status, 200);
      await result.arrayBuffer();
      assert.equal(result.headers.get("x-agent-hub-trace-id"), id);
    }
    for (const id of ["snapshot-original", "health-original", "asset-original"]) {
      assert.ok(spans.some(x => x.commandId === id && x.stage === "http-read" && x.outcome === "succeeded"));
    }
    assert.ok(spans.some(x => x.stage === "http-json-encode" && x.metadata.synchronous));
    assert.ok(spans.some(x => x.stage === "http-asset-read" && !x.metadata.synchronous));
    const before = spans.length;
    await (await fetch(`${address.url}health`)).json();
    assert.equal(spans.length, before);
  } finally { await server.close(); }
});

test("compression timing preserves async fallback and exactly one terminal record", () => {
  const spans = [];
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false,
    headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; this.writableFinished = true; this.emit("finish"); }, destroy() {} });
  const timing = createHttpReadTiming({ commandId: "gzip-1", route: "snapshot", response, record: x => spans.push(x) });
  let callback;
  const json = createJsonResponder({ compress: (body, done) => { callback = done; } });
  json(response, 200, { text: "large".repeat(10000) }, "GET", { acceptEncoding: "gzip", timing });
  assert.equal(response.body, undefined);
  callback(new Error("private compressor error")); callback(null, Buffer.from("duplicate"));
  assert.equal(JSON.parse(response.body.toString()).text.length, 50000);
  assert.equal(response.headers["Content-Encoding"], undefined);
  assert.equal(spans.filter(x => x.stage === "http-json-compress" && x.outcome === "failed").length, 1);
  assert.doesNotMatch(JSON.stringify(spans), /private compressor error/u);
});

test("small cold history can write while the gzip worker is occupied", () => {
  const pending = [];
  const json = createJsonResponder({ compress: (body, done) => pending.push({ body, done }) });
  const target = () => ({
    headers: {},
    getHeader(key) { return this.headers[key]; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; this.writableEnded = true; },
    destroy() {},
  });
  const body = { text: "x".repeat(32 * 1_024) };
  const background = target();
  const cold = target();
  const acceptsGzip = { acceptEncoding: "gzip" };
  json(background, 200, body, "POST", acceptsGzip);
  json(cold, 200, body, "POST", { ...acceptsGzip, coldHistory: true });
  assert.deepEqual(JSON.parse(cold.body), body);
  assert.equal(cold.headers["Content-Encoding"], undefined);
  assert.equal(background.body, undefined);
  assert.equal(pending.length, 1);
  const gzipOnly = { coldHistory: true, acceptEncoding: "gzip, identity;q=0" };
  const short = { text: "short answer" };
  const shortHeld = target();
  json(shortHeld, 200, short, "POST", gzipOnly);
  assert.equal(shortHeld.body, undefined);
  assert.equal(pending.length, 2);
  const overCapacity = target();
  json(overCapacity, 200, short, "POST", gzipOnly);
  assert.equal(overCapacity.statusCode, 503);
  assert.equal(overCapacity.body.length, 0);
  assert.equal(pending.length, 2);
  pending.pop().done(new Error("controlled required gzip failure"));
  assert.equal(shortHeld.statusCode, 503);
  assert.equal(shortHeld.body.length, 0);
  pending.shift().done(new Error("controlled compression failure"));

  const needsGzip = target();
  json(needsGzip, 200, body, "POST", { coldHistory: true, acceptEncoding: "gzip, identity;q=0" });
  assert.equal(needsGzip.body, undefined);
  assert.equal(pending.length, 1);
  pending.shift().done(null, Buffer.from("gzip fixture"));
  assert.equal(needsGzip.headers["Content-Encoding"], "gzip");

  const large = target();
  json(large, 200, { text: "x".repeat(160 * 1_024) }, "POST", { ...acceptsGzip, coldHistory: true });
  assert.equal(large.body, undefined);
  assert.equal(pending.length, 1);
  pending.shift().done(null, Buffer.from("gzip fixture"));
  assert.equal(large.headers["Content-Encoding"], "gzip");
});

test("authenticated short cold history honors required gzip and refuses unacceptable encodings", async () => {
  const secret = "cold-history".repeat(5);
  const result = { items: [{ id: "short-turn", answer: "short final".repeat(170) }], nextBefore: null };
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0, localAccessSecret: secret,
    journalDatabase: { subscribe: () => () => {} }, controlHandler: async () => result });
  try {
    const address = await server.start();
    const request = acceptEncoding => fetch(address.url + "api/control", {
      method: "POST",
      headers: { Authorization: `webview ${createLocalWebviewSession(secret).token}`,
        "Content-Type": "application/json", "Accept-Encoding": acceptEncoding },
      body: JSON.stringify({ action: "task-history", params: { limit: 2, coldHistory: true } }),
    });
    for (const [encoding, expected] of [["gzip, identity;q=0", "gzip"], ["gzip", null]]) {
      const response = await request(encoding);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-encoding"), expected);
      assert.match(response.headers.get("vary"), /(^|,\s*)Accept-Encoding(,|$)/i);
      assert.deepEqual((await response.json()).result, result);
    }
    const refused = await request("gzip;q=0, identity;q=0");
    assert.equal(refused.status, 406);
    assert.equal(await refused.text(), "");
  } finally { await server.close(); }
});
