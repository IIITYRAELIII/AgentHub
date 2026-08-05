import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveJobService } from "./src/interfaces/telegram/interactive-job-service.mjs";

test("interactive jobs stay serialized by their bounded queue", async () => {
  const events = [];
  const jobs = [];
  const service = new InteractiveJobService({
    queue: { enqueue: (job) => { jobs.push(job); return Promise.resolve(); } },
    stopping: () => false,
    sendMessage: async () => {},
  });
  assert.equal(service.schedule("Status", 7, async () => events.push("run")), true);
  assert.deepEqual(events, []);
  await jobs[0]();
  assert.deepEqual(events, ["run"]);
});

test("queue saturation rejects only the view command and reports it", async () => {
  const messages = [];
  const service = new InteractiveJobService({
    queue: { enqueue: () => { throw new Error("full"); } },
    stopping: () => false,
    sendMessage: async (...args) => messages.push(args),
    logger: { error() {}, warn() {} },
  });
  assert.equal(service.schedule("Список задач", 7, async () => {}), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(messages[0][1], /Слишком много команд просмотра/u);
});
