const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export function codexVisualizationIdentity(value) {
  const { threadId, turnId, itemId, markerHash } = value ?? {};
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)
    || typeof turnId !== "string" || !turnId.trim() || turnId.length > 200
    || typeof itemId !== "string" || !itemId.trim() || itemId.length > 300
    || typeof markerHash !== "string" || !/^[0-9a-f]{64}$/u.test(markerHash)) return null;
  return { threadId, turnId, itemId, markerHash };
}
