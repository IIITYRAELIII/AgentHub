import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeAccountReader } from "../../../src/providers/claude/claude-account.mjs";

test("Claude account reader returns a stable opaque account key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-claude-account-"));
  try {
    const file = path.join(root, ".claude.json");
    await writeFile(file, `${JSON.stringify({
      oauthAccount: {
        accountUuid: "acc-123",
        emailAddress: "First@Example.Test",
        seatTier: "max",
        billingType: "subscription",
      },
    })}\n`, "utf8");
    const readClaudeAccount = createClaudeAccountReader({ file });
    assert.deepEqual(await readClaudeAccount(), {
      key: "anthropic:acc-123",
      label: "first@example.test",
      type: "oauth",
      planType: "max",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude account reader falls back to the current organization subscription tier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-claude-account-"));
  try {
    const file = path.join(root, ".claude.json");
    await writeFile(file, `${JSON.stringify({
      oauthAccount: {
        accountUuid: "acc-pro",
        emailAddress: "Pro@Example.Test",
        seatTier: "",
        billingType: "apple_subscription",
        organizationType: "claude_pro",
      },
    })}\n`, "utf8");
    const readClaudeAccount = createClaudeAccountReader({ file });
    assert.deepEqual(await readClaudeAccount(), {
      key: "anthropic:acc-pro",
      label: "pro@example.test",
      type: "oauth",
      planType: "pro",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude account reader does not treat a billing channel as a subscription tier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-claude-account-"));
  try {
    const file = path.join(root, ".claude.json");
    await writeFile(file, `${JSON.stringify({
      oauthAccount: {
        accountUuid: "acc-billing-only",
        emailAddress: "Billing@Example.Test",
        billingType: "apple_subscription",
      },
    })}\n`, "utf8");
    const readClaudeAccount = createClaudeAccountReader({ file });
    assert.equal((await readClaudeAccount()).planType, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude account reader tolerates missing config", async () => {
  const readClaudeAccount = createClaudeAccountReader({
    file: path.join(os.tmpdir(), "missing-claude-account.json"),
  });
  assert.equal(await readClaudeAccount(), null);
});
