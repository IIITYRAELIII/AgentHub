import assert from "node:assert/strict";
import test from "node:test";
import { applyInferredDeviceTimelineAccounts, createLegacyTeamUsageAccountPolicy,
  inferredTeamAccountForDeviceLabel, teamUsageAccountAt } from "../../src/domain/team-usage-accounts.mjs";
import { policy, rawPolicy, FIRST_ACCOUNT_BOUNDARY, SECOND_ACCOUNT_BOUNDARY } from "../helpers/legacy-account-policy.mjs";

test("legacy attribution has no ambient roster; an explicit immutable policy retains boundary semantics", () => {
  const first = Date.parse(FIRST_ACCOUNT_BOUNDARY), second = Date.parse(SECOND_ACCOUNT_BOUNDARY);
  assert.equal(teamUsageAccountAt("alpha", second), null);
  assert.equal(inferredTeamAccountForDeviceLabel("test-three"), null);
  assert.equal(createLegacyTeamUsageAccountPolicy(policy), policy);
  assert.equal(teamUsageAccountAt("alpha", first - 1, policy).label, "one@example.invalid");
  assert.equal(teamUsageAccountAt("alpha", first, policy).label, "two@example.invalid");
  assert.equal(teamUsageAccountAt("unknown", second - 1, policy).label, "two@example.invalid");
  assert.equal(teamUsageAccountAt("unknown", second, policy).label, "one@example.invalid");
  assert.equal(teamUsageAccountAt("ALPHA", second, policy).label, "two@example.invalid");
  assert.equal(teamUsageAccountAt("charlie", second, policy).label, "three@example.invalid");
  assert.equal(inferredTeamAccountForDeviceLabel("TEST-FOUR", policy).label, "four@example.invalid");
  const copy = structuredClone(rawPolicy), normalized = createLegacyTeamUsageAccountPolicy(copy);
  copy.accounts[0].email = "changed@example.invalid";
  assert.equal(normalized.initialAccount.label, "one@example.invalid");
  assert.throws(() => { normalized.initialAccount.label = "changed@example.invalid"; }, TypeError);
  for (const mutate of [p => { p.accounts[1].id = p.accounts[0].id; }, p => { p.epochs[0].from = FIRST_ACCOUNT_BOUNDARY; },
    p => { p.epochs[2].from = p.epochs[1].from; }, p => { p.epochs[2].participants.alpha = "absent"; },
    p => { p.accounts[0].email = "private\naddress"; }, p => { p.deviceLabels["TEST-THREE"] = "one"; }]) {
    const raw = structuredClone(rawPolicy); mutate(raw);
    assert.throws(() => createLegacyTeamUsageAccountPolicy(raw), error => error.message === "Invalid private legacy account policy");
  }
});

test("generic exact-device timeline recovery survives without private label fallback", () => {
  const exact = { deviceId: "device", provider: "codex", accountAttribution: "exact", accountKey: "chatgpt:synthetic",
    accountLabel: "observed@example.invalid", accountType: "chatgpt", accountPlan: "plus", observedAt: FIRST_ACCOUNT_BOUNDARY };
  const unknown = { deviceId: "device", provider: "codex", observedAt: SECOND_ACCOUNT_BOUNDARY };
  const foreign = { deviceId: "other", deviceLabel: "test-three", provider: "codex", observedAt: SECOND_ACCOUNT_BOUNDARY };
  const claude = { ...foreign, provider: "claude" };
  const result = applyInferredDeviceTimelineAccounts([exact, unknown, foreign, claude]);
  assert.equal(result[0], exact);
  assert.equal(result[1].accountKey, exact.accountKey);
  assert.equal(result[1].accountRecovery, "device");
  assert.equal(result[1].accountAttribution, "inferred");
  assert.equal(result[2], foreign);
  assert.equal(result[3], claude);
  const configured = applyInferredDeviceTimelineAccounts([foreign, claude], policy);
  assert.equal(configured[0].accountLabel, "three@example.invalid");
  assert.equal(configured[0].accountRecovery, "team-label");
  assert.equal(configured[1], claude);
});
