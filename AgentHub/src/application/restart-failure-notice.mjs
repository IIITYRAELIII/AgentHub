import {
  restartFailureProjection,
} from "../domain/maintenance-operation.mjs";

/* Single owner of the visible restart failure reason. The same projection is
   both the snapshot content and part of the snapshot source revision, so a
   failed restart and a later successful restart each change the revision and a cached notModified reply cannot hide it. */
export function createRecentRestartFailure({
  operations,
}) {
  return function recentRestartFailure() {
    // The terminal failure must remain available to a reconnecting client.
    // Only a later successful restart supersedes it; elapsed time is not delivery.
    return restartFailureProjection(operations?.latestSettledRestart?.() ?? null);
  };
}
