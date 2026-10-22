import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createUploadGatewayObserver, observeAuthorizedUpload, uploadTransportAction } from "../../../src/interfaces/web/upload-transport-trace.mjs";

function headers(canonical = false) {
  const values = { "x-agent-hub-upload-request-id": randomUUID(), "x-agent-hub-upload-id": randomUUID(),
    "x-agent-hub-upload-attempt-id": randomUUID(), "x-agent-hub-message-request-id": randomUUID() };
  return canonical ? Object.fromEntries(Object.entries(values).map(([k,v]) => [k.replace(/(^|-)[a-z]/gu, p => p.toUpperCase()), [v]])) : values;
}

test("origin records an authenticated paired upload receipt with bounded timings and no private request data", () => {
  const events = [], response = new EventEmitter();
  response.statusCode = 200; response.writableFinished = false; response.setHeader = () => {};
  const h = { ...headers(), authorization: "private-auth", cookie: "private-cookie", "x-agent-hub-file-name": "private-name" };
  const timings = { auth: 1, body: 2, owner: 3, ownerQueue: 4, storageRead: 5, storageSync: 6,
    ownerLoopMax: 7, storageWrite: -1, storageClose: Infinity, storagePublish: 86_400_001,
    privatePath: "private-diagnostic" };
  observeAuthorizedUpload({ request: { method: "PUT", url: "/api/attachment-upload?id=irrelevant&index=0&secret=private-query", headers: h },
    response, record: value => events.push(value), timings });
  response.writableFinished = true; response.emit("finish"); response.emit("close");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.outcome), ["started", "succeeded"]);
  assert.equal(events[0].metadata.httpRequestId, h["x-agent-hub-upload-request-id"]);
  assert.equal(events[1].metadata.operationSpanId, events[0].metadata.operationSpanId);
  assert.equal(events[1].metadata.serverOwnerMs, 3);
  assert.equal(events[1].metadata.serverOwnerQueueMs, 4);
  assert.equal(events[1].metadata.serverStorageReadMs, 5);
  assert.equal(events[1].metadata.serverStorageSyncMs, 6);
  assert.equal(events[1].metadata.serverOwnerLoopMaxMs, 7);
  for (const name of ["serverStorageWriteMs", "serverStorageCloseMs", "serverStoragePublishMs", "serverPrivatePathMs"]) {
    assert.equal(events[1].metadata[name], undefined);
  }
  assert.equal(events[1].metadata.action, "origin-chunk");
  assert.equal(JSON.stringify(events).includes("private-"), false);
});

test("origin close is not success, invalid identity is ignored and diagnostic failure does not alter response", () => {
  const events = [], response = new EventEmitter();
  response.statusCode = 200; response.writableFinished = false; response.setHeader = () => {};
  observeAuthorizedUpload({ request: { method: "POST", url: "/api/attachment-upload", headers: headers() },
    response, record: value => events.push(value), timings: {} });
  response.emit("close");
  assert.equal(events.at(-1).outcome, "failed");
  assert.equal(events.at(-1).metadata.failureKind, "aborted");
  observeAuthorizedUpload({ request: { method: "GET", url: "/api/attachment-upload", headers: {} },
    response, record: () => assert.fail("invalid headers"), timings: {} });
  observeAuthorizedUpload({ request: { method: "GET", url: "/api/attachment-upload", headers: headers() },
    response, record: () => { throw new Error("trace unavailable"); }, timings: {} });
  response.emit("finish");
  assert.equal(response.statusCode, 200);
});

test("gateway sanitizes real error framing, buffers split lines and rejects oversized/foreign/unbound records", () => {
  const events = [], observe = createUploadGatewayObserver(value => events.push(value));
  const record = { logger: "http.log.error", status: 502, duration: 0.125,
    msg: "read: connection reset by peer: private-address", request: { method: "PUT",
      uri: "/api/attachment-upload?id=private-query&index=0", headers: { ...headers(true), Authorization: ["private-auth"], Cookie: ["private-cookie"] } } };
  const text = JSON.stringify(record) + "\n";
  observe(text.slice(0, 7)); observe(text.slice(7));
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.upstreamError, "connection-reset");
  assert.equal(events[0].metadata.action, "gateway-chunk");
  assert.equal(events[0].metadata.statusCode, 502);
  assert.equal(events[0].monotonicDurationMs, 125);
  assert.equal(JSON.stringify(events).includes("private-"), false);
  observe(JSON.stringify({ ...record, logger: "foreign" }) + "\n");
  observe(JSON.stringify({ ...record, request: { ...record.request, uri: "/api/control" } }) + "\n");
  observe(JSON.stringify({ ...record, request: { ...record.request, headers: {} } }) + "\n");
  observe(JSON.stringify({ ...record, request: { ...record.request, headers: null } }) + "\n");
  for (const duration of [null, undefined, "0", -1, 86_401]) observe(JSON.stringify({ ...record, duration }) + "\n");
  observe('null\n1\n[]\ntrue\n"string"\nnot-json\n');
  observe("x".repeat(65537)); observe("discarded\n"); observe("x".repeat(16385) + "\n");
  assert.equal(events.length, 1);
  observe(text);
  assert.equal(events.length, 2);
});

test("upload operations have a finite content-free stage vocabulary", () => {
  assert.equal(uploadTransportAction("GET", "/api/attachment-upload"), "capabilities");
  assert.equal(uploadTransportAction("GET", "/api/attachment-upload?id=1"), "status");
  assert.equal(uploadTransportAction("POST", "/api/attachment-upload?id=1&complete=1"), "complete");
  assert.equal(uploadTransportAction("PATCH", "/api/attachment-upload?id=1"), null);
  assert.equal(uploadTransportAction("POST", "/api/control"), null);
});
