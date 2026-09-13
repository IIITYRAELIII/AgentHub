import {
  RESTART_FAILURE_NOTICE_WINDOW_MS,
  restartFailureProjection,
} from "../domain/maintenance-operation.mjs";

/* Single owner of the visible restart failure reason. The same projection is
   both the snapshot content and part of the snapshot source revision, so a
   failed restart, a later successful restart and the end of the notice window
   each change the revision and a cached notModified reply cannot hide it. */
export function createRecentRestartFailure({
  operations,
  now = Date.now,
  windowMs = RESTART_FAILURE_NOTICE_WINDOW_MS,
}) {
  return function recentRestartFailure() {
    const since = new Date(Number(now()) - windowMs).toISOString();
    return restartFailureProjection(operations?.latestSettledRestart?.({ since }) ?? null);
  };
}
