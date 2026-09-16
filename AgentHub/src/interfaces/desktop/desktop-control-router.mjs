import { DurableCommandReceipts, commandFingerprint } from "../../infrastructure/persistence/durable-command-receipts.mjs";
import { SqliteDurableCommandReceipts } from "../../infrastructure/persistence/sqlite-durable-command-receipts.mjs";
import { clientCommandBoundaryTraceSpans } from "../../application/client-command-trace.mjs";

const DEFAULT_MINI_APP_LIMITS = Object.freeze({
  sources: Object.freeze(["telegram-mini-app", "trusted-device", "local-mini-app"]),
  limit: 10,
  maxAnswerChars: 75_000,
  maxResponseBytes: 850_000,
});

const DEFAULT_DESKTOP_MAX_RESPONSE_BYTES = 3_500_000;
/**
 * Sources that reach the Hub over a locally authenticated channel: the Desktop
 * named pipe guarded by the ACL-protected secret, the loopback Web session, and
 * the loopback VS Code webview session. The last two are assigned only by the
 * loopback server after verifying a token derived from the local web secret,
 * never taken from request parameters. Every other source is remote and must
 * not mint credentials or rewrite the server configuration, however well
 * authenticated it is.
 */
const PRIVILEGED_CONTROL_SOURCES = Object.freeze(["desktop-control", "local-mini-app", "local-vscode-webview"]);
const RECEIPT_SHAPE = "__agentHubControlReceiptShape";
const SNAPSHOT_RESULT_KEYS = Object.freeze([
  "apiVersion", "workspaces", "boardTasks", "boardLayout", "selected", "settings",
  "pendingApprovals", "messageReceipts", "messagePins", "deferredInputs", "restartPending",
  "restartWaiting", "restartBlockingCount", "restartFailure", "exchangeRates", "activeCount", "server",
  "tasks", "conversations", "collectionDeltas", "generatedAt", "version", "notModified",
]);

function projectDesktopReceiptResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value[RECEIPT_SHAPE]) return value;
  if (value.snapshot && typeof value.snapshot === "object") {
    const projected = { ...value, [RECEIPT_SHAPE]: "nested-snapshot" };
    delete projected.snapshot;
    delete projected.history;
    return projected;
  }
  if (
    !Array.isArray(value.tasks)
    && !Array.isArray(value.conversations)
    && !value.collectionDeltas?.conversations
  ) return value;
  if (!value.selected) return value;
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
  commandTrace = null,
}) {
  const localOnly = new Set(localOnlyActions);
  const privileged = new Set(privilegedSources);
  const mutations = new Set(mutationActions);
  const concurrentMutations = new Set(concurrentMutationActions);
  const durableMutations = new Set(receiptActions);
  const miniAppSources = new Set([
    ...(Array.isArray(miniAppLimits.sources) ? miniAppLimits.sources : []),
    miniAppLimits.source,
  ].map((source) => String(source ?? "").trim()).filter(Boolean));
  let mutationQueue = Promise.resolve();
  const ReceiptStore = String(receiptFile ?? "").toLowerCase().endsWith(".sqlite")
    ? SqliteDurableCommandReceipts
    : DurableCommandReceipts;
  const receipts = receiptFile ? new ReceiptStore({
    ...receiptOptions,
    file: receiptFile,
    projectResult: projectDesktopReceiptResult,
    onTrace: ({ commandId, waitMs, lockCount, retryCount, transport, action }) => {
      commandTrace?.recordBestEffort?.({
        commandId,
        stage: "receipt-lock-wait",
        outcome: "succeeded",
        transport: transport || "desktop-control",
        lockWaitMs: waitMs,
        metadata: { action, lockCount, retryCount },
      });
    },
  }) : null;

  function serializeDesktopMutation(operation) {
    const next = mutationQueue.catch(() => {}).then(operation);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function effectiveParams(params, context) {
    if (miniAppSources.has(String(context?.source ?? ""))) {
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

  function durableFingerprintParams(params) {
    const { clientTiming: _clientTiming, clientTraceId: _clientTraceId, ...stableParams } = params;
    return stableParams;
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
    if (!miniAppSources.has(String(context?.source ?? ""))) return value;
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
    const traceCommandId = String(
      resolvedParams.clientUserMessageId
        ?? (/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(resolvedParams.clientTraceId ?? "")
          ? resolvedParams.clientTraceId : context?.commandId) ?? "",
    ).trim();
    const traceTransport = String(context?.source ?? "desktop-control").trim().toLowerCase()
      || "desktop-control";
    const handlerEnteredAtMs = Date.now();
    const contextReceivedAtMs = Number(context?.transportReceivedAtMs);
    const receivedAtMs = Number.isSafeInteger(contextReceivedAtMs)
      && contextReceivedAtMs >= 0
      && contextReceivedAtMs <= handlerEnteredAtMs
      ? contextReceivedAtMs
      : handlerEnteredAtMs;
    for (const span of clientCommandBoundaryTraceSpans({
      commandId: traceCommandId,
      timing: resolvedParams.clientTiming,
      receivedAtMs,
      transport: traceTransport,
    })) {
      commandTrace?.recordBestEffort?.({ ...span, metadata: { action, ...span.metadata } });
    }
    commandTrace?.recordBestEffort?.({
      commandId: traceCommandId,
      stage: "handler-enter",
      outcome: "succeeded",
      transport: traceTransport,
      observedAtMs: handlerEnteredAtMs,
      monotonicDurationMs: 0,
      metadata: {
        action,
        transportReceiveToHandlerMs: Math.max(0, handlerEnteredAtMs - receivedAtMs),
      },
    });
    const responseSpan = commandTrace?.startBestEffortSpan?.({
      commandId: traceCommandId,
      stage: "response-send",
      transport: traceTransport,
      metadata: { action, receivedAtMs, handlerEnteredAtMs },
      recordStarted: true,
    });
    const measuredHandler = () => commandTrace?.measureBestEffort
      ? commandTrace.measureBestEffort({ commandId: traceCommandId, stage: "control-handler", transport: traceTransport, metadata: { action } },
        () => handler(resolvedParams, context))
      : handler(resolvedParams, context);
    try {
      let result;
      if (mutations.has(action)) {
        const execute = () => concurrentMutations.has(action)
          ? measuredHandler()
          : serializeDesktopMutation(measuredHandler);
        const commandId = String(context?.commandId ?? "").trim();
        if (!receipts || !commandId || !durableMutations.has(action)) {
          result = await mutationResultForClient(await execute(), context);
        } else {
          const noLiveResult = Symbol("no-live-result");
          let liveResult = noLiveResult;
          const durableResult = await receipts.execute({
            id: commandId,
            fingerprint: commandFingerprint({
              action,
              params: durableFingerprintParams(resolvedParams),
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
            traceContext: { commandId: traceCommandId || commandId, transport: traceTransport, action },
          });
          result = liveResult !== noLiveResult
            ? await mutationResultForClient(liveResult, context)
            : await hydrateProjectedResult(durableResult, context);
        }
      } else {
        result = await measuredHandler();
      }
      responseSpan?.finish?.({
        outcome: "succeeded",
        metadata: {
          hubReceiveToResponseMs: Math.max(0, Date.now() - receivedAtMs),
          handlerToResponseMs: Math.max(0, Date.now() - handlerEnteredAtMs),
        },
      });
      return result;
    } catch (error) {
      responseSpan?.finish?.({
        outcome: "failed",
        metadata: {
          hubReceiveToResponseMs: Math.max(0, Date.now() - receivedAtMs),
          handlerToResponseMs: Math.max(0, Date.now() - handlerEnteredAtMs),
          failed: true,
        },
      });
      throw error;
    }
  }

  return {
    handleDesktopControl,
    serializeDesktopMutation,
    forgetDesktopControl: (commandId) => receipts?.forget(commandId) ?? Promise.resolve(false),
  };
}
