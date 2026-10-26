import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function normalizeTestSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["mode", "ids"].includes(key))
      || !["all", "include", "exclude", "none"].includes(value.mode)
      || !Array.isArray(value.ids) || value.ids.some(id => typeof id !== "string" || !id.trim() || id !== id.trim())) {
    throw new TypeError("test selection requires mode all/include/exclude/none and exact ids");
  }
  const ids = [...value.ids].sort();
  if (new Set(ids).size !== ids.length) throw new TypeError("duplicate test selector");
  if (["all", "none"].includes(value.mode) && ids.length) throw new TypeError("all/none selection has no ids");
  return { mode: value.mode, ids };
}

export function resolveTestSelection(selection, inventory) {
  const normalized = normalizeTestSelection(selection);
  const ids = inventory.map(entry => typeof entry === "string" ? entry : entry.id).sort();
  if (new Set(ids).size !== ids.length) throw new Error("duplicate inventory identity");
  for (const id of normalized.ids) if (!ids.includes(id)) throw new Error(`Unknown test selector: ${id}`);
  const selectedIds = ids.filter(id => normalized.mode === "all"
    || normalized.mode === "include" && normalized.ids.includes(id)
    || normalized.mode === "exclude" && !normalized.ids.includes(id));
  const contents = { selection: normalized, inventory: ids, inventorySha256: digest(ids), selectedIds,
    notSelectedIds: ids.filter(id => !selectedIds.includes(id)) };
  return { ...contents, identitySha256: digest(contents) };
}

export function verifyTestPlan(plan, inventory = plan?.inventory) {
  const expected = resolveTestSelection(plan?.selection, inventory);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error("Frozen test plan changed");
  return expected;
}
