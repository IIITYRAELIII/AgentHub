import { stat, writeFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";

import { fileTransferPolicy } from "../../src/domain/file-transfer.mjs";
import { FileTransferStore } from "../../src/infrastructure/persistence/file-transfer-store.mjs";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
stdout.write("ready\n");
while (true) {
  try { await stat(input.markerPath); break; } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test" });
const store = new FileTransferStore({ dataDir: input.dataDir, policy, instanceId: input.instanceId });
try {
  const result = await store.revoke(input.owner, input.shareId);
  await writeFile(input.resultPath, JSON.stringify(result));
} finally {
  await store.close();
}
