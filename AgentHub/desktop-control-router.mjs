import { DurableCommandReceipts, commandFingerprint } from "./durable-command-receipts.mjs";

const DEFAULT_MINI_APP_LIMITS = Object.freeze({
  source: "telegram-mini-app",
  limit: 10,
  maxAnswerChars: 75_000,
  maxResponseBytes: 850_000,
});

const DEFAULT_DESKTOP_MAX_RESPONSE_BYTES = 3_500_000;

export function createDesktopControlRouter({
  handlers,
  mutationActions,
  miniAppLimits = DEFAULT_MINI_APP_LIMITS,
  desktopMaxResponseBytes = DEFAULT_DESKTOP_MAX_RESPONSE_BYTES,
  receiptFile = null,
  reconcileMutation = null,
}) {
  const mutations = new Set(mutationActions);
  let mutationQueue = Promise.resolve();
  const receipts = receiptFile ? new DurableCommandReceipts({ file: receiptFile }) : null;

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

  async function handleDesktopControl({ action, params, context = null }) {
    const handler = handlers[action];
    if (typeof handler !== "function") {
      throw new Error(`Неизвестная desktop-команда: ${action}`);
    }
    const resolvedParams = effectiveParams(params, context);
    if (action === "send-message" && context?.commandId && !resolvedParams.clientUserMessageId) {
      resolvedParams.clientUserMessageId = String(context.commandId);
    }
    if (mutations.has(action)) {
      const execute = () => serializeDesktopMutation(() => handler(resolvedParams, context));
      const commandId = String(context?.commandId ?? "").trim();
      if (!receipts || !commandId) return execute();
      return receipts.execute({
        id: commandId,
        fingerprint: commandFingerprint({
          action,
          params: resolvedParams,
          source: context?.source ?? "",
          userId: context?.userId ?? "",
        }),
        action,
        effect: execute,
        reconcile: typeof reconcileMutation === "function"
          ? (receipt) => reconcileMutation({ action, params: resolvedParams, context, receipt })
          : null,
      });
    }
    return handler(resolvedParams, context);
  }

  return {
    handleDesktopControl,
    serializeDesktopMutation,
    forgetDesktopControl: (commandId) => receipts?.forget(commandId) ?? Promise.resolve(false),
  };
}
