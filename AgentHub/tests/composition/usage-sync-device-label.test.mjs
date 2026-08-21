import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { usageSyncDeviceLabel } from "../../src/composition/infrastructure-composition.mjs";

async function tempUtilities() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthub-usage-sync-label-"));
  const utilities = path.join(root, "Utilities");
  const agentHub = path.join(utilities, "AgentHub");
  await mkdir(agentHub, { recursive: true });
  return { agentHub, utilities };
}

test("usage sync device label prefers explicit participant login from local git config", async () => {
  const { agentHub, utilities } = await tempUtilities();
  await mkdir(path.join(utilities, ".git"), { recursive: true });
  await writeFile(
    path.join(utilities, ".git", "config"),
    "[utilities]\n  participantLogin = KateK888\n",
    "utf8",
  );

  assert.equal(await usageSyncDeviceLabel(agentHub), "KateK888");
});

test("usage sync device label falls back to team profile GitHub login", async () => {
  const previousPython = process.env.PYTHON;
  const { agentHub, utilities } = await tempUtilities();
  const setupDir = path.join(utilities, "AI_INFRA_SETUP");
  await mkdir(setupDir, { recursive: true });
  await writeFile(
    path.join(setupDir, "team_profile.py"),
    "console.log('D:/fake/.team/95281881.json');\n"
      + "console.log(JSON.stringify({ github_login: 'IIITYRAELIII', github_user_id: 95281881 }));\n",
    "utf8",
  );

  process.env.PYTHON = process.execPath;
  try {
    assert.equal(await usageSyncDeviceLabel(agentHub), "IIITYRAELIII");
  } finally {
    if (previousPython === undefined) delete process.env.PYTHON;
    else process.env.PYTHON = previousPython;
  }
});

