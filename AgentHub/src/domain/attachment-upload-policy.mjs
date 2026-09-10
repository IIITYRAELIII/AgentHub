const MIB = 1024 * 1024;

export function attachmentUploadLimits(env = process.env) {
  const bounded = (value, fallback, ceiling) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? Math.min(number, ceiling) : fallback;
  };
  return {
    protocol: "agent-hub-attachment-upload-v1",
    chunkBytes: MIB,
    maxBytes: bounded(env.AGENT_HUB_ATTACHMENT_MAX_BYTES, 128 * MIB, 256 * MIB),
    maxTotalBytes: bounded(env.AGENT_HUB_ATTACHMENT_USER_MAX_BYTES, 256 * MIB, 512 * MIB),
    maxUploads: 32,
    ttlMs: 30 * 60 * 1000,
  };
}
