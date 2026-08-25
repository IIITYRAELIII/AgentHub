function normalizedFileIdentity(change, file) {
  const root = String(change?.projectRoot ?? "").trim().replaceAll("\\", "/").toLowerCase();
  const relative = String(file ?? "").trim().replaceAll("\\", "/").toLowerCase();
  return `${root}\0${relative}`;
}

export async function classifyLegacyReleaseChanges(changes, {
  coveredLegacyIds = new Set(),
  inspectFile = async () => ({ state: "unknown" }),
} = {}) {
  const active = Array.isArray(changes) ? changes : [];
  const ownersByFile = new Map();
  for (const change of active) {
    for (const file of change.files ?? []) {
      const identity = normalizedFileIdentity(change, file);
      const owners = ownersByFile.get(identity) ?? [];
      owners.push(change);
      ownersByFile.set(identity, owners);
    }
  }
  const entries = [];
  for (const change of active) {
    const files = [];
    for (const file of change.files ?? []) {
      let inspection;
      try {
        inspection = await inspectFile({ projectRoot: change.projectRoot, file });
      } catch (error) {
        inspection = { state: "unknown", error: String(error?.message ?? error) };
      }
      files.push({ file, ...inspection });
    }
    const categories = new Set([
      coveredLegacyIds.has(change.id) ? "covered_by_changeset" : "unobserved",
    ]);
    if (!change.diffHash) categories.add("empty_diff_hash");
    if (files.some((file) => file.state === "dirty")) categories.add("materialized");
    if (files.some((file) => file.state === "ignored")) categories.add("ignored_paths");
    if (files.some((file) => file.state === "missing")) categories.add("missing_paths");
    if (files.length && files.every((file) => ["clean", "missing"].includes(file.state))) {
      categories.add("stale_candidate");
    }
    const overlapping = (change.files ?? []).flatMap((file) => (
      ownersByFile.get(normalizedFileIdentity(change, file)) ?? []
    )).filter((owner) => owner.id !== change.id);
    if (overlapping.some((owner) => owner.streamId === change.streamId)) categories.add("same_stream_overlap");
    if (overlapping.some((owner) => owner.streamId !== change.streamId)) categories.add("cross_stream_overlap");
    entries.push({
      id: change.id,
      streamId: change.streamId,
      status: change.status,
      summary: change.summary,
      categories: [...categories].toSorted(),
      files,
    });
  }
  const counts = {};
  for (const entry of entries) {
    for (const category of entry.categories) counts[category] = (counts[category] ?? 0) + 1;
  }
  return { total: entries.length, counts, entries };
}
