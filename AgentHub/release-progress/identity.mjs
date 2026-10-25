import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function monitorIdentity(runtimeRoot, operationId) {
  const physical = await realpath(path.resolve(runtimeRoot));
  const root = process.platform === 'win32' ? physical.toLowerCase() : physical;
  return { protocol: 'agent-hub-release-progress-v1', operationId,
    binding: createHash('sha256').update(JSON.stringify([root, operationId])).digest('hex') };
}
