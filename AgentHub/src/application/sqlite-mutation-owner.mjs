import { createHash } from "node:crypto";

const WORKSPACE_MUTATIONS = new Set([
  "ensureExperiments", "createWorkspace", "createWorkspaceWithStream", "renameWorkspace", "updateWorkspaceComment",
  "updateWorkspaceSettings", "moveWorkspaceToFolder", "renameWorkspaceFolder",
  "archiveWorkspace", "restoreWorkspace", "deleteArchivedWorkspace",
  "updateWorkspaceDeveloperRules", "recordWorkspaceEvent", "beginMcpOperation",
  "bindMcpOperationInterstreamContentHash",
  "completeMcpOperation", "failMcpOperation", "recordClaimAdmissionRefusal", "cancelMcpOperation", "beginMcpOperationReconciliation",
  "markMcpOperationUnknown", "completeUnknownMcpOperation", "failUnknownMcpOperation",
  "checkpointClaimCustody",
  "mergeWorkspaces", "createWorkspaceFromStream", "createStream", "renameStream",
  "archiveStream", "updateStreamSettings", "updateStreamDeveloperRules", "moveStream",
  "moveStreamToStart", "reorderStream", "moveStreamOrdered", "bindThread", "rebindThread",
  "assignUnknownThread", "assignCatalogEntries", "moveThreadToNewStream", "setMeta",
  "deleteMeta", "completeThreadNaming",
]);

const WORKSPACE_READS = new Set([
  "archivedWorkspaces", "releaseWorkflowEnabledForThread", "workspaceDeveloperRules", "workspaceEvents",
  "claimCustodyForOriginal", "claimCustodyForTask", "claimCustodyNamespaceForTask", "claimCustodyTaskSnapshot", "mcpOperation", "pendingMcpOperations", "mcpOperations", "interstreamOriginForClientMessage",
  "workspace", "workspaceBySystemKey", "stream", "streamDeveloperRules", "developerRulesForThread",
  "developerRulesForStream", "thread", "activeThread", "threadsForStream", "resolveThread", "hierarchy",
  "meta", "threadNaming", "mutationDiagnostics", "close",
]);

const TASK_MUTATIONS = new Set([
  "create", "attachToSourceMessage", "addAttachment", "appendSourceMessage",
  "mergeSourceMessage", "disablePendingTriage", "markTriageRunning", "updatePresentation",
  "applyTriage", "markTriageFailed", "retryTriage", "move", "reassignWorkspace",
  "assignWorkspaceTaskNumbers", "moveColumn", "setNotesComment", "prepareStart",
  "admitPreparedStart", "cancelPreparedStart", "fencePreparedStartCancellation",
  "completePreparedStartCancellation", "markStarted", "complete", "setWorkflowStatus", "claim",
  "requestWorkflowStatus", "beginLifecycleTransition", "failLifecycleTransition",
  "commitWorkflowTransition", "commitSquashTransferTransition", "rollbackWorkflowOutcome", "finalizeCleanupTransition", "recordTaskTurn",
  "recordTaskGitReference", "adoptLegacyGitReference", "completeRelease", "remove", "setCaptureEnabled",
  "updateChecklist", "applyChecklistLinkedTaskAction", "clearAwaitRebuildPending", "recordReleaseFinalizationStage",
]);

// These owners perform external effects outside SQL retry and queue their own
// durable transitions. They are explicitly classified, never exposed as reads.
const TASK_MANAGED_EFFECTS = new Set(["deliverChecklistEvents"]);

const TASK_READS = new Set([
  "task", "list", "pendingTriage", "orderedColumnIds", "notesComment", "claimedTaskForTurn",
  "claimBindingForOperation",
  "lifecycleTransition", "lifecycleOutcome", "releaseTasks", "captureEnabled", "mutationDiagnostics", "close",
  "selectedCompositionForRelease",
  "returnedNativeTestPriorResult",
  "assertSelectedAbsorptionState",
  "checklistRequestResult", "awaitRebuildPending", "releaseFinalizationOutcome",
]);

const READ_PROPERTIES = new Set(["revision", "snapshotRevision"]);
const OWNER_SCOPES = new WeakMap();

function stableValue(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key], seen)]));
}

function mutationIdentity(scope, method, args) {
  const digest = createHash("sha256")
    .update(JSON.stringify(stableValue(args)))
    .digest("hex")
    .slice(0, 24);
  return `${scope}:${method}:${digest}`;
}

function createMutationOwner(store, { scope, mutations, reads, managedEffects = new Set() }) {
  if (typeof store?.runMutation !== "function") throw new TypeError(`${scope} mutation queue is required`);
  const owner = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "runMutation" || property === "transaction") return undefined;
      if (typeof property === "string" && mutations.has(property)) {
        const value = Reflect.get(store, property, store);
        if (typeof value !== "function") return undefined;
        return (...args) => store.runMutation(
          () => value.apply(store, args),
          { requestId: mutationIdentity(scope, property, args), method: property, args },
        );
      }
      if (typeof property === "string" && managedEffects.has(property)) {
        const value = Reflect.get(store, property, store);
        return typeof value === "function" ? value.bind(store) : undefined;
      }
      if (typeof property === "string" && reads.has(property)) {
        const value = Reflect.get(store, property, store);
        return typeof value === "function" ? value.bind(store) : value;
      }
      if (typeof property === "string" && READ_PROPERTIES.has(property)) {
        return Reflect.get(store, property, store);
      }
      if (typeof property === "symbol" || property === "then") return undefined;
      if (Reflect.has(store, property)) {
        throw new TypeError(`${scope} store member is not classified for production access: ${String(property)}`);
      }
      return undefined;
    },
    set() {
      throw new TypeError(`${scope} mutation owner is immutable`);
    },
  });
  OWNER_SCOPES.set(owner, scope);
  return owner;
}

export function createWorkspaceCatalogMutationOwner(store) {
  return createMutationOwner(store, { scope: "workspace", mutations: WORKSPACE_MUTATIONS, reads: WORKSPACE_READS });
}

export function createTaskBoardMutationOwner(store) {
  return createMutationOwner(store, {
    scope: "task", mutations: TASK_MUTATIONS, reads: TASK_READS, managedEffects: TASK_MANAGED_EFFECTS,
  });
}

export const workspaceMutationMethods = Object.freeze([...WORKSPACE_MUTATIONS].sort());
export const taskMutationMethods = Object.freeze([...TASK_MUTATIONS].sort());
export const taskManagedEffectMethods = Object.freeze([...TASK_MANAGED_EFFECTS].sort());
export const workspaceReadMethods = Object.freeze([...WORKSPACE_READS].sort());
export const taskReadMethods = Object.freeze([...TASK_READS].sort());

export function isTaskBoardMutationOwner(value) {
  return OWNER_SCOPES.get(value) === "task";
}

export function isWorkspaceCatalogMutationOwner(value) {
  return OWNER_SCOPES.get(value) === "workspace";
}
