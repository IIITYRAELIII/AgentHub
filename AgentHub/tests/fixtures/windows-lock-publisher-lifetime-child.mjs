// Only owned fixture directories/native helper. Real beforeExit/exit events;
// no emitted lifecycle events, keepalive, publisher substitution or effect retry.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [moduleUrl, root, mode] = process.argv.slice(2);
const api = await import(moduleUrl);
let publisher;
const report = { mode };

async function input(name) {
  const target = path.join(root, `${name}.lock`), ready = `${target}.ready-${randomUUID()}`;
  await fs.mkdir(ready);
  const token = randomUUID();
  const file = `owner-${createHash("sha256").update(token).digest("hex")}.json`;
  const bytes = JSON.stringify({ token, pid: process.pid, processInstanceId: randomUUID(),
    createdAt: Date.now(), leaseExpiresAt: Date.now() + 60_000 });
  const handle = await fs.open(path.join(ready, file), "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { target, ready, file, bytes };
}

try {
  publisher = await api.prepareWindowsLockDirectoryPublisher();
  report.nativeRoot = path.dirname(publisher.provenance.executable);
  const first = await input("first");
  await publisher.publish(first.ready, first.target);
  assert.equal(await fs.readFile(path.join(first.target, first.file), "utf8"), first.bytes);
  report.firstPublished = true;
  if (mode === "idle-then-work") {
    // Node/test libraries can enqueue more real work after event-loop quiescence.
    // Let Node emit the actual event, then continue in a newly scheduled turn.
    await new Promise((resolve, reject) => process.once("beforeExit", () => setImmediate(() => {
      (async () => {
        report.resumedAfterIdle = true;
        assert.equal(await api.prepareWindowsLockDirectoryPublisher(), publisher);
        const next = await input("after-idle");
        await publisher.publish(next.ready, next.target);
        assert.equal(await fs.readFile(path.join(next.target, next.file), "utf8"), next.bytes);
        report.secondPublished = true;
        // Explicit shutdown remains terminal and joins already-admitted work.
        const last = await input("in-flight");
        const active = publisher.publish(last.ready, last.target);
        const shutdown = publisher.shutdown();
        await assert.rejects(publisher.publish(last.ready, last.target), { code: "WINDOWS_LOCK_PUBLISHER_CLOSED" });
        await active;
        await shutdown;
        assert.equal(await fs.readFile(path.join(last.target, last.file), "utf8"), last.bytes);
        await assert.rejects(fs.lstat(report.nativeRoot), { code: "ENOENT" });
        report.explicitShutdownFencedAndDrained = true;
      })().then(resolve, reject);
    })));
  } else if (mode === "natural-exit-replaced") {
    report.retainedNativeRoot = `${report.nativeRoot}.retained`;
    await fs.rename(report.nativeRoot, report.retainedNativeRoot);
    await fs.mkdir(report.nativeRoot);
    await fs.writeFile(path.join(report.nativeRoot, "foreign"), "retained foreign bytes");
  } else if (mode !== "natural-exit") throw new Error("Unknown owned fixture mode");
} catch (error) {
  report.errorCode = error.code ?? error.name;
  process.exitCode = 1;
  await publisher?.shutdown();
} finally {
  console.log(JSON.stringify(report));
}
