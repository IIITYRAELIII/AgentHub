import { randomUUID } from "node:crypto";

// Restart has one runtime-wide identity. Only synchronous persistence enters
// this lane; draining turns, notifications and process launch remain outside.
export function mutateRestartOperation(store, operation, requestId = null) {
  if (typeof store?.runRestartMutation !== "function") {
    throw new TypeError("Restart operation mutation capability is required");
  }
  return store.runRestartMutation(operation, { requestId });
}

export function restartOperationId(store) {
  return typeof store.idFactory === "function" ? store.idFactory() : randomUUID();
}

export function retainedRestartRequest(store, request) {
  return request && !request.operationId
    ? { ...request, operationId: restartOperationId(store) }
    : request;
}

export async function recoverRestartOperation(store, request, target) {
  const retained = retainedRestartRequest(store, request);
  return mutateRestartOperation(store, () => {
    const operation = request?.operationId
      ? store.get(request.operationId)
      : store.migrateLegacyRestart(retained, target) ?? store.latestRestart(target);
    if (!operation) return null;
    store.recoverInterrupted({ operationIds: [operation.operationId] });
    return store.get(operation.operationId);
  }, retained?.operationId);
}
