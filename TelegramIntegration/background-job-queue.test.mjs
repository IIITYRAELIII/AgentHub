import assert from "node:assert/strict";
import test from "node:test";
import {
  BackgroundJobQueue,
  BackgroundJobQueueFullError,
} from "./background-job-queue.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("background jobs respect concurrency and preserve FIFO start order", async () => {
  const first = deferred();
  const second = deferred();
  const started = [];
  const queue = new BackgroundJobQueue({ concurrency: 1, maxJobs: 3 });

  const firstResult = queue.enqueue(async () => {
    started.push("first");
    await first.promise;
    return 1;
  });
  const secondResult = queue.enqueue(async () => {
    started.push("second");
    await second.promise;
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  assert.equal(queue.active, 1);
  assert.equal(queue.pending, 1);

  first.resolve();
  assert.equal(await firstResult, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  second.resolve();
  assert.equal(await secondResult, 2);
  assert.equal(queue.size, 0);
});

test("background queue rejects overflow without starting extra work", async () => {
  const hold = deferred();
  const queue = new BackgroundJobQueue({ concurrency: 1, maxJobs: 2 });
  const first = queue.enqueue(() => hold.promise);
  const second = queue.enqueue(() => "second");

  assert.throws(
    () => queue.enqueue(() => "third"),
    (error) => error instanceof BackgroundJobQueueFullError
      && error.code === "QUEUE_FULL"
      && error.limit === 2,
  );
  hold.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
});

test("a failed job does not stop the following job", async () => {
  const queue = new BackgroundJobQueue({ concurrency: 1, maxJobs: 2 });
  const failed = queue.enqueue(() => { throw new Error("boom"); });
  const next = queue.enqueue(() => "ok");

  await assert.rejects(failed, /boom/);
  assert.equal(await next, "ok");
  assert.equal(queue.size, 0);
});
