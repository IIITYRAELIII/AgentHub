import { stdin, stdout } from "node:process";

import { fileTransferPolicy } from "../../src/domain/file-transfer.mjs";
import { FileTransferStore } from "../../src/infrastructure/persistence/file-transfer-store.mjs";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test",
  ...(input.policyOverrides ?? {}) });
const store = new FileTransferStore({ dataDir: input.dataDir, policy, instanceId: input.instanceId });
try {
  const artifact = await store.reserve({ owner: input.owner, sourceKey: input.sourceKey,
    requestId: input.requestId, name: input.name, size: input.size, availableBytes: input.availableBytes });
  stdout.write(JSON.stringify({ ok: true, id: artifact.id }));
} catch (error) {
  stdout.write(JSON.stringify({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }));
} finally {
  await store.close();
}
