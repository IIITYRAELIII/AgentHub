import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceFileTransferTickets } from "../../src/application/workspace-file-transfer-tickets.mjs";

function file(name) {
  return {
    bytes: 42,
    name,
    target: `D:/workspace/${name}`,
    type: "application/octet-stream",
  };
}

test("workspace file transfer tickets are one-time and expire", () => {
  let sequence = 0;
  const tickets = new WorkspaceFileTransferTickets({
    randomBytesImpl: () => Buffer.alloc(32, sequence += 1),
    ttlMs: 1_000,
  });
  const issued = tickets.issue(file("result.cfe"), { deviceId: "browser-1", now: 10_000 });

  assert.equal(issued.name, "result.cfe");
  assert.equal(issued.expiresAt, 11_000);
  assert.equal(tickets.consume(issued.token, { now: 10_500 })?.deviceId, "browser-1");
  assert.equal(tickets.consume(issued.token, { now: 10_500 }), null);

  const expired = tickets.issue(file("expired.cfe"), { now: 20_000 });
  assert.equal(tickets.consume(expired.token, { now: 21_000 }), null);
});

test("workspace file transfer tickets evict the oldest capability", () => {
  let sequence = 0;
  const tickets = new WorkspaceFileTransferTickets({
    capacity: 2,
    randomBytesImpl: () => Buffer.alloc(32, sequence += 1),
  });
  const first = tickets.issue(file("one.cfe"));
  const second = tickets.issue(file("two.cfe"));
  const third = tickets.issue(file("three.cfe"));

  assert.equal(tickets.size, 2);
  assert.equal(tickets.consume(first.token), null);
  assert.equal(tickets.consume(second.token)?.name, "two.cfe");
  assert.equal(tickets.consume(third.token)?.name, "three.cfe");
});
