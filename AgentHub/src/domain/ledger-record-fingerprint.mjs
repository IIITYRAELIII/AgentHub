import { createHash } from "node:crypto";

export function ledgerRecordFingerprint(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url");
}
