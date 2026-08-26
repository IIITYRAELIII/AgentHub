import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../assets/web-app/background-http-scheduler.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const schedulerApi = context.window.AgentHubBackgroundHttpScheduler;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("background HTTP scheduler reserves foreground socket capacity", async () => {
  const scheduler = schedulerApi.create({ maxConcurrent: 2 });
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started = [];

  const requests = [first, second, third].map((request, index) => scheduler.run(async () => {
    started.push(index + 1);
    await request.promise;
    return index + 1;
  }));

  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  assert.equal(scheduler.snapshot().active, 2);
  assert.equal(scheduler.snapshot().queued, 1);
  assert.equal(scheduler.snapshot().maxConcurrent, 2);

  first.resolve();
  await requests[0];
  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);

  second.resolve();
  third.resolve();
  assert.deepEqual(await Promise.all(requests), [1, 2, 3]);
  assert.equal(scheduler.snapshot().active, 0);
  assert.equal(scheduler.snapshot().queued, 0);
});

test("failed background request releases its scheduler slot", async () => {
  const scheduler = schedulerApi.create({ maxConcurrent: 1 });
  const calls = [];
  const failed = scheduler.run(async () => {
    calls.push("failed");
    throw new Error("history unavailable");
  });
  const recovered = scheduler.run(async () => {
    calls.push("recovered");
    return true;
  });

  await assert.rejects(failed, /history unavailable/u);
  assert.equal(await recovered, true);
  assert.deepEqual(calls, ["failed", "recovered"]);
});
