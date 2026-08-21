import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";

const REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;
const CURSOR_VERSION = 2;

export class BugReportCaptureCursorStore {
  constructor({ filePath } = {}) {
    this.filePath = path.resolve(String(filePath ?? "bug-report-capture.json"));
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8"));
      if (state?.version !== CURSOR_VERSION) return "";
      const revision = String(state?.revision ?? "").trim().toLowerCase();
      return REVISION_PATTERN.test(revision) ? revision : "";
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return "";
      throw error;
    }
  }

  async save(revision) {
    const normalized = String(revision ?? "").trim().toLowerCase();
    if (!REVISION_PATTERN.test(normalized)) throw new Error("Invalid bug report capture revision");
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeTextAtomic(this.filePath, `${JSON.stringify({ version: CURSOR_VERSION, revision: normalized }, null, 2)}\n`);
  }
}
