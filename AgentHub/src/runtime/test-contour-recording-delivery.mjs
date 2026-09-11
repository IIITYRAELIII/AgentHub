import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { assertContourOwnedPath, createContourExternalEffects } from "../infrastructure/filesystem/test-contour-external-effects.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

// This is the external recording transport receipt, not another retry owner.
// PersistentDeliveryOutbox still owns attempts, uncertainty and terminal ACK.
export async function createRecordingContourDelivery({ root }) {
  createContourExternalEffects({ root });
  const directory = assertContourOwnedPath(path.join(root, "delivery-receipts"), root, { optional: true });
  await mkdir(directory, { recursive: true });
  assertContourOwnedPath(directory, root);
  return async (method, body, { deliveryId, idempotencyKey, attemptId } = {}) => {
    if (!["sendMessage", "sendPhotoFile"].includes(method)) throw new Error("Unsupported recording delivery method");
    if (![deliveryId, idempotencyKey, attemptId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256)
      || deliveryId !== idempotencyKey || !body || typeof body !== "object") {
      throw new Error("Recording delivery requires durable outbox identity and attempt metadata");
    }
    const fingerprint = digest(JSON.stringify(canonical({ method, body })));
    const identity = digest(deliveryId);
    const file = path.join(directory, `${identity}.json`);
    const readReceipt = async () => {
      assertContourOwnedPath(file, root);
      const receipt = JSON.parse(await readFile(file, "utf8"));
      if (receipt.schemaVersion !== 1 || receipt.kind !== "recording-delivery"
        || receipt.deliveryId !== deliveryId || receipt.idempotencyKey !== idempotencyKey
        || receipt.fingerprint !== fingerprint || receipt.method !== method
        || !Number.isSafeInteger(receipt.result?.message_id)) throw new Error("Recording delivery identity conflict");
      return receipt.result;
    };
    try { return await readReceipt(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const result = { message_id: Number.parseInt(identity.slice(0, 12), 16), chat: { id: body.chat_id }, recorded: true };
    const receipt = { schemaVersion: 1, kind: "recording-delivery", deliveryId, idempotencyKey,
      firstAttemptId: attemptId, fingerprint, method, result };
    const temporary = assertContourOwnedPath(path.join(directory, `${identity}.${randomUUID()}.tmp`), root, { optional: true });
    let handle;
    try {
      handle = await open(temporary, "wx");
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      assertContourOwnedPath(file, root, { optional: true });
      try { await link(temporary, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
      return await readReceipt();
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  };
}
