import { once } from "node:events";

import { FileTransferService } from "../../src/infrastructure/filesystem/file-transfer-service.mjs";
import { FileTransferStore } from "../../src/infrastructure/persistence/file-transfer-store.mjs";
import { fileTransferPolicy } from "../../src/domain/file-transfer.mjs";

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
await once(process.stdin, "end");

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const policy = fileTransferPolicy(input.policy);
  const keyring = { currentKid: input.kid, keys: { [input.kid]: Buffer.from(input.key, "base64") } };
  const store = new FileTransferStore({ dataDir: input.dataDir, policy });
  const service = new FileTransferService({ dataDir: input.dataDir, roots: [], store, policy, keyring });
  const result = await service.claim(input.claim);
  process.stdout.write(`${JSON.stringify({ ok: true, id: result.id })}\n`);
  await service.close();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: String(error?.code ?? "failed") })}\n`);
}
