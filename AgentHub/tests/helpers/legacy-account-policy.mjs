import { createLegacyTeamUsageAccountPolicy } from "../../src/domain/team-usage-accounts.mjs";

export const FIRST_ACCOUNT_BOUNDARY = "2026-07-10T00:00:00.000Z";
export const SECOND_ACCOUNT_BOUNDARY = "2026-08-01T00:00:00.000Z";
export const rawPolicy = {
  version: 1,
  accounts: [
    { id: "one", email: "one@example.invalid", planType: "plus" },
    { id: "two", email: "two@example.invalid", planType: "pro" },
    { id: "three", email: "three@example.invalid", planType: "pro" },
    { id: "four", email: "four@example.invalid", planType: "pro" },
  ],
  epochs: [
    { from: null, defaultAccount: "one" },
    { from: FIRST_ACCOUNT_BOUNDARY, defaultAccount: "two" },
    { from: SECOND_ACCOUNT_BOUNDARY, defaultAccount: "one",
      participants: { alpha: "two", bravo: "two", charlie: "three", delta: "four", echo: "four" } },
  ],
  deviceLabels: { "test-three": "three", "test-four": "four" },
};
export const policy = createLegacyTeamUsageAccountPolicy(rawPolicy);
export const THIRD_ACCOUNT = policy.deviceAccount("test-three");
export const FOURTH_ACCOUNT = policy.deviceAccount("test-four");
