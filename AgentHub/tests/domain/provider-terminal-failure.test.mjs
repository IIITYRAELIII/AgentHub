import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_TERMINAL_FAILURE_FALLBACK,
  mergeProviderTerminalFailure,
  normalizeProviderTerminalFailure,
} from "../../src/domain/provider-terminal-failure.mjs";
import { redactSecrets } from "../../src/infrastructure/diagnostics/secret-redaction.mjs";

const SYNTHETIC = [
  "SYNTHETIC_SECRET_TOKEN", "SYNTHETIC_API_KEY", "SYNTHETIC_TOKEN", "SYNTHETIC_PASSWORD",
];

test("a provider failure redacts credentials and private paths before it is published", () => {
  const raw = "Request failed: Authorization: Bearer SYNTHETIC_SECRET_TOKEN; "
    + "api-key=SYNTHETIC_API_KEY, token: SYNTHETIC_TOKEN, password='SYNTHETIC_PASSWORD' "
    + "reading C:\\Users\\operator\\.codex\\auth.json, /home/operator/.codex/auth.json "
    + "and \\\\share\\operator\\auth.json";
  const failure = normalizeProviderTerminalFailure({ message: raw, code: "other" }, {
    status: "failed",
  });

  for (const secret of SYNTHETIC) assert.equal(failure.message.includes(secret), false, secret);
  for (const location of ["C:\\Users\\operator", "/home/operator", "\\\\share\\operator"]) {
    assert.equal(failure.message.includes(location), false, location);
  }
  // The safe part of the reason and the provider code survive.
  assert.equal(failure.message.startsWith("Request failed:"), true, failure.message);
  assert.equal(failure.message.includes("[redacted]"), true, failure.message);
  assert.equal(failure.message.includes("[path]"), true, failure.message);
  assert.equal(failure.code, "other");
});

test("redaction keeps ordinary prose and falls back when nothing safe remains", () => {
  const plain = normalizeProviderTerminalFailure({
    message: "stream disconnected before completion: Unable to verify model access right now. "
      + "Please retry and/or continue.",
  }, { status: "failed" });
  assert.equal(
    plain.message,
    "stream disconnected before completion: Unable to verify model access right now. "
      + "Please retry and/or continue.",
  );

  assert.equal(
    normalizeProviderTerminalFailure({ message: "   " }, { status: "failed" }).message,
    PROVIDER_TERMINAL_FAILURE_FALLBACK,
  );
  assert.equal(normalizeProviderTerminalFailure({ message: "any" }, { status: "completed" }), null);
});

test("merged failures stay redacted and prefer a specific reason", () => {
  const merged = mergeProviderTerminalFailure(
    { message: PROVIDER_TERMINAL_FAILURE_FALLBACK },
    { message: "Authorization: Bearer SYNTHETIC_SECRET_TOKEN denied", code: "other" },
    { status: "failed" },
  );
  assert.equal(merged.message.includes("SYNTHETIC_SECRET_TOKEN"), false, merged.message);
  assert.equal(merged.message.includes("[redacted]"), true, merged.message);

  const retained = mergeProviderTerminalFailure(
    merged,
    { message: "" },
    { status: "failed" },
  );
  assert.deepEqual(retained, merged);
});

test("diagnostics keeps its redaction entry point on the shared pure policy", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer SYNTHETIC_SECRET_TOKEN"),
    "Authorization: Bearer [redacted]",
  );
});
