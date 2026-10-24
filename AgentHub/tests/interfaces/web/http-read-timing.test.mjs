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
