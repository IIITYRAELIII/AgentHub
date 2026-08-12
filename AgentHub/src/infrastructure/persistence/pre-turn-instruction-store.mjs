import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";

export const AGENT_HUB_GUIDE_MAXIMUM_BYTES = 64 * 1024;
export const GLOBAL_PRE_TURN_MAXIMUM_BYTES = 32 * 1024;

function byteLength(content) {
  return Buffer.byteLength(String(content ?? ""), "utf8");
}

function documentSnapshot(content, maximumBytes, exists = true) {
  return {
    content,
    bytes: byteLength(content),
    maximumBytes,
    exists,
  };
}

async function readOptionalText(file) {
  try {
    return { content: await readFile(file, "utf8"), exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { content: "", exists: false };
    throw error;
  }
}

export class PreTurnInstructionStore {
  constructor({ guideFile, globalFile } = {}) {
    if (!String(guideFile ?? "").trim()) throw new TypeError("guideFile is required");
    if (!String(globalFile ?? "").trim()) throw new TypeError("globalFile is required");
    this.guideFile = path.resolve(guideFile);
    this.globalFile = path.resolve(globalFile);
  }

  async guide() {
    const content = await readFile(this.guideFile, "utf8");
    const bytes = byteLength(content);
    if (!content.trim()) throw new Error("Agent Hub Guide is empty");
    if (bytes > AGENT_HUB_GUIDE_MAXIMUM_BYTES) throw new Error("Agent Hub Guide exceeds its size limit");
    return documentSnapshot(content, AGENT_HUB_GUIDE_MAXIMUM_BYTES);
  }

  async global() {
    const document = await readOptionalText(this.globalFile);
    const snapshot = documentSnapshot(
      document.content,
      GLOBAL_PRE_TURN_MAXIMUM_BYTES,
      document.exists,
    );
    if (snapshot.bytes > GLOBAL_PRE_TURN_MAXIMUM_BYTES) {
      throw new Error("Global pre-turn instructions exceed their size limit");
    }
    return snapshot;
  }

  async snapshot() {
    const [guide, global] = await Promise.all([this.guide(), this.global()]);
    return { guide, global };
  }

  async updateGlobal(content) {
    const value = String(content ?? "");
    if (byteLength(value) > GLOBAL_PRE_TURN_MAXIMUM_BYTES) {
      throw new Error("Global pre-turn instructions exceed their size limit");
    }
    await mkdir(path.dirname(this.globalFile), { recursive: true });
    await writeTextAtomic(this.globalFile, value);
    return documentSnapshot(value, GLOBAL_PRE_TURN_MAXIMUM_BYTES);
  }
}
