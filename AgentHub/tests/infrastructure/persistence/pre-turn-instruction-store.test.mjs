import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GLOBAL_PRE_TURN_MAXIMUM_BYTES,
  PreTurnInstructionStore,
} from "../../../src/infrastructure/persistence/pre-turn-instruction-store.mjs";

test("pre-turn instruction store keeps the release Guide read-only and Global durable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pre-turn-"));
  const guideFile = path.join(directory, "AGENT_HUB_GUIDE.md");
  const globalFile = path.join(directory, "data", "global-pre-turn-instructions.md");
  await writeFile(guideFile, "Release guide\n", "utf8");
  const store = new PreTurnInstructionStore({ guideFile, globalFile });

  assert.deepEqual(await store.snapshot(), {
    guide: {
      content: "Release guide\n",
      bytes: 14,
      maximumBytes: 65_536,
      exists: true,
    },
    global: {
      content: "",
      bytes: 0,
      maximumBytes: GLOBAL_PRE_TURN_MAXIMUM_BYTES,
      exists: false,
    },
  });

  const updated = await store.updateGlobal("Общие правила\n");
  assert.equal(updated.content, "Общие правила\n");
  assert.equal(await readFile(globalFile, "utf8"), "Общие правила\n");
  assert.equal((await store.snapshot()).global.exists, true);
  assert.equal((await store.guide()).content, "Release guide\n");
});

test("pre-turn instruction store requires Guide and bounds Global by UTF-8 bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pre-turn-"));
  const guideFile = path.join(directory, "AGENT_HUB_GUIDE.md");
  const store = new PreTurnInstructionStore({
    guideFile,
    globalFile: path.join(directory, "global.md"),
  });
  await assert.rejects(() => store.guide(), /ENOENT/u);
  await writeFile(guideFile, "Guide", "utf8");
  await assert.rejects(
    () => store.updateGlobal("я".repeat((GLOBAL_PRE_TURN_MAXIMUM_BYTES / 2) + 1)),
    /size limit/u,
  );
});
