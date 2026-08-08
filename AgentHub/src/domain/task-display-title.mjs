function normalizedTitle(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function taskDisplayTitle(task, fallback = "") {
  const workspaceName = normalizedTitle(task?.workspaceName);
  const streamName = normalizedTitle(task?.streamName)
    || normalizedTitle(task?.streamDisplayName)
    || (normalizedTitle(task?.streamId)
      ? `Stream ${Math.max(1, Number(task?.streamOrdinal) || 1)}`
      : "");
  if (workspaceName && streamName) return `${workspaceName} - ${streamName}`;
  return workspaceName
    || streamName
    || normalizedTitle(task?.displayTitle)
    || normalizedTitle(fallback)
    || normalizedTitle(task?.title)
    || "Без названия";
}
