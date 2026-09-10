import { callDesktopControl, readDesktopControlEndpoint } from "../infrastructure/process/desktop-control.mjs";
import { defaultRuntimeRoot } from "../infrastructure/filesystem/runtime-layout.mjs";
import { publicationRuntimeStatus } from "./runtime-publication-start.mjs";

export async function waitForRuntimeReplacement({
  previousEndpointId = null,
  runtimeRoot = defaultRuntimeRoot(),
  expectedReleaseId,
  timeoutMs = 90_000,
  readEndpoint = readDesktopControlEndpoint,
  readStatus = publicationRuntimeStatus,
  probe = callDesktopControl,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
} = {}) {
  if (!expectedReleaseId) throw new Error("Expected publication release is required for readiness verification");
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      const endpoint = await readEndpoint(runtimeRoot);
      if (!previousEndpointId || endpoint.endpointId !== previousEndpointId) {
        const snapshot = await probe("snapshot", {}, { runtimeRoot, timeoutMs: Math.min(10_000, timeoutMs) });
        const status = await readStatus({ runtimeRoot });
        if (status.current !== expectedReleaseId || status.runningRelease !== expectedReleaseId
          || status.running !== true || status.ready !== true
          || snapshot?.server?.process?.releaseId !== expectedReleaseId
          || snapshot?.server?.process?.pid !== status.pid) {
          throw new Error(`Expected ready runtime ${expectedReleaseId}; current=${status.current}, running=${status.runningRelease}`);
        }
        return endpoint;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Agent Hub Runtime не подтвердил готовность после перезапуска: ${lastError?.message ?? "timeout"}`);
}
