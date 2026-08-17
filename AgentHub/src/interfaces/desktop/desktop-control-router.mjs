import { DurableCommandReceipts, commandFingerprint } from "../../infrastructure/persistence/durable-command-receipts.mjs";

const DEFAULT_MINI_APP_LIMITS = Object.freeze({
  source: "telegram-mini-app",
  limit: 10,
  maxAnswerChars: 75_000,
  maxResponseBytes: 850_000,
});

const DEFAULT_DESKTOP_MAX_RESPONSE_BYTES = 3_500_000;
/**
 * Sources that reach the Hub over a locally authenticated channel: the Desktop
 * named pipe guarded by the ACL-protected secret, and the loopback Web session.
 * Every other source is remote and must not mint credentials or rewrite the
 * server configuration, however well authenticated it is.
 */
const PRIVILEGED_CONTROL_SOURCES = Object.freeze(["desktop-control", "local-mini-app"]);
const RECEIPT_SHAPE = "__agentHubDesktopReceiptShape";
const SNAPSHOT_RESULT_KEYS = Object.freeze([
  "apiVersion", "workspaces", "boardTasks", "boardLayout", "selected", "settings",
  "pendingApprovals", "messageReceipts", "deferredInputs", "restartPending",
  "restartWaiting", "restartBlockingCount", "exchangeRates", "activeCount", "server",
  "tasks", "generatedAt", "version", "notModified",
]);

function projectDesktopReceiptResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value[RECEIPT_SHAPE]) return value;
  if (value.snapshot && typeof value.snapshot === "object") {
    const projected = { ...value, [RECEIPT_SHAPE]: "nested-snapshot" };
    delete projected.snapshot;
    delete projected.history;
    return projected;
  }
  if (!Array.isArray(value.tasks) || !value.selected) return value;
  const projected = { ...value, [RECEIPT_SHAPE]: "snapshot" };
  for (const key of SNAPSHOT_RESULT_KEYS) delete projected[key];
  return projected;
}

export function createDesktopControlRouter({
  handlers,
  mutationActions,
  concurrentMutationActions = [],
  receiptActions = mutationActions,
  localOnlyActions = [],
  privilegedSources = PRIVILEGED_CONTROL_SOURCES,
  miniAppLimits = DEFAULT_MINI_APP_LIMITS,
  desktopMaxResponseBytes = DEFAULT_DESKTOP_MAX_RESPONSE_BYTES,
  receiptFile = null,
  receiptOptions = {},
  reconcileMutation = null,
}) {
  const localOnly = new Set(localOnlyActions);
  const privileged = new Set(privilegedSources);
  const mutations = new Set(mutationActions);
  const concurrentMutations = new Set(concurrentMutationActions);
  const durableMutations = new Set(receiptActions);
  let mutationQueue = Promise.resolve();
  const receipts = receiptFile ? new DurableCommandReceipts({
    ...receiptOptions,
    file: receiptFile,
    projectResult: projectDesktopReceiptResult,
  }) : null;

  function serializeDesktopMutation(operation) {
    const next = mutationQueue.catch(() => {}).then(operation);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function effectiveParams(params, context) {
    if (context?.source === miniAppLimits.source) {
      return {
        ...params,
        limit: Math.min(Number(params.limit) || 10, miniAppLimits.limit),
        maxAnswerChars: miniAppLimits.maxAnswerChars,
        maxResponseBytes: miniAppLimits.maxResponseBytes,
        compactSnapshot: true,
      };
    }
    return {
      ...params,
      maxResponseBytes: Math.min(
        Number(params.maxResponseBytes) || desktopMaxResponseBytes,
        desktopMaxResponseBytes,
      ),
    };
  }

  async function hydrateProjectedResult(value, context) {
    const shape = value?.[RECEIPT_SHAPE];
    if (!shape) return value;
    const { [RECEIPT_SHAPE]: _shape, ...projected } = value;
    const snapshot = await handlers.snapshot(effectiveParams({}, context), context);
    return shape === "nested-snapshot"
      ? { ...projected, snapshot }
      : { ...snapshot, ...projected };
  }

  async function mutationResultForClient(value, context) {
    if (context?.source !== miniAppLimits.source) return value;
    return hydrateProjectedResult(projectDesktopReceiptResult(value), context);
  }

  async function handleDesktopControl({ action, params, context = null }) {
    const handler = handlers[action];
    if (typeof handler !== "function") {
      throw new Error(`Неизвестная desktop-команда: ${action}`);
    }
    if (localOnly.has(action) && !privileged.has(String(context?.source ?? ""))) {
      throw new Error("Команда доступна только локальному Agent Hub на этом компьютере");
    }
    const resolvedParams = effectiveParams(params, context);
    if (action === "send-message" && context?.commandId && !resolvedParams.clientUserMessageId) {
      resolvedParams.clientUserMessageId = String(context.commandId);
    }
    if (mutations.has(action)) {
      const execute = () => concurrentMutations.has(action)
        ? handler(resolvedParams, context)
        : serializeDesktopMutation(() => handler(resolvedParams, context));
      const commandId = String(context?.commandId ?? "").trim();
      if (!receipts || !commandId || !durableMutations.has(action)) {
        return mutationResultForClient(await execute(), context);
      }
      const noLiveResult = Symbol("no-live-result");
      let liveResult = noLiveResult;
      const durableResult = await receipts.execute({
        id: commandId,
        fingerprint: commandFingerprint({
          action,
          params: resolvedParams,
          source: context?.source ?? "",
          userId: context?.userId ?? "",
        }),
        action,
        effect: async () => {
          liveResult = await execute();
          return projectDesktopReceiptResult(liveResult);
        },
        reconcile: typeof reconcileMutation === "function"
          ? (receipt) => reconcileMutation({ action, params: resolvedParams, context, receipt })
          : null,
      });
      if (liveResult !== noLiveResult) return mutationResultForClient(liveResult, context);
      return hydrateProjectedResult(durableResult, context);
    }
    return handler(resolvedParams, context);
  }

  return {
    handleDesktopControl,
    serializeDesktopMutation,
    forgetDesktopControl: (commandId) => receipts?.forget(commandId) ?? Promise.resolve(false),
  };
}
