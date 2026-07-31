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
}) {
  const mutations = new Set(mutationActions);
  let mutationQueue = Promise.resolve();

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
    if (mutations.has(action)) {
      return serializeDesktopMutation(() => handler(resolvedParams, context));
    }
    return handler(resolvedParams, context);
  }

  return {
    handleDesktopControl,
    serializeDesktopMutation,
  };
}
