import test from "node:test";
import assert from "node:assert/strict";

import {
  clientCommandAckTraceSpan,
  clientCommandBoundaryTraceSpans,
} from "../../src/application/client-command-trace.mjs";

test("client command trace preserves submit, transport, Hub and ACK boundaries", () => {
  const timing = {
    submittedAtMs: 1_000,
    submittedMonotonicMs: 100,
    controlStartedAtMs: 1_250,
    controlStartedMonotonicMs: 350,
    transportStartedAtMs: 3_000,
    transportStartedMonotonicMs: 2_100,
    transport: "direct-http",
    surface: "vscode-webview",
  };
  const spans = clientCommandBoundaryTraceSpans({
    commandId: "message-1",
    timing,
    receivedAtMs: 3_040,
    transport: "local-mini-app",
  });

  assert.deepEqual(spans.map((span) => span.stage), [
    "client-submit",
    "transport-start",
    "hub-receive",
  ]);
  assert.equal(spans[1].monotonicDurationMs, 1_750);
  assert.equal(spans[1].metadata.submitToControlMs, 250);
  assert.equal(spans[2].metadata.clientToHubMs, 2_040);
  assert.equal(spans[2].metadata.transportToHubMs, 40);

  const ack = clientCommandAckTraceSpan({
    commandId: "message-1",
    timing: {
      ...timing,
      clientAckAtMs: 3_090,
      clientAckMonotonicMs: 2_190,
    },
    reportedAtMs: 3_120,
    transport: "vscode-webview",
  });
  assert.equal(ack.stage, "client-ack");
  assert.equal(ack.monotonicDurationMs, 2_090);
  assert.equal(ack.metadata.submittedToAckMs, 2_090);
  assert.equal(ack.metadata.reportDelayMs, 30);
});

test("client command trace rejects stale or future client clock values", () => {
  const spans = clientCommandBoundaryTraceSpans({
    commandId: "message-2",
    timing: {
      submittedAtMs: 1,
      transportStartedAtMs: 999_999_999,
      transport: "invalid transport",
    },
    receivedAtMs: 100_000_000,
    transport: "desktop-control",
  });

  assert.deepEqual(spans.map((span) => span.stage), ["hub-receive"]);
  assert.equal(spans[0].transport, "desktop-control");
  assert.equal(spans[0].metadata.clientToHubMs, null);
});
