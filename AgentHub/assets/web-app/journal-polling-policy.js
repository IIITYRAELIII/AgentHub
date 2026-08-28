(() => {
  "use strict";

  const DEFAULT_INTERVAL_MS = 10_000;
  const DEFAULT_MAX_INTERVAL_MS = 60_000;
  const DEFAULT_BACKOFF_FACTOR = 2;

  function boundedNumber(value, fallback, minimum) {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum ? number : fallback;
  }

  function createBoundedPollingFallback({
    request,
    isEnabled = () => true,
    isOnline = () => true,
    isVisible = () => true,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
    backoffFactor = DEFAULT_BACKOFF_FACTOR,
  } = {}) {
    if (typeof request !== "function") throw new TypeError("request must be a function");

    const baseIntervalMs = boundedNumber(intervalMs, DEFAULT_INTERVAL_MS, 1);
    const maximumIntervalMs = Math.max(
      baseIntervalMs,
      boundedNumber(maxIntervalMs, DEFAULT_MAX_INTERVAL_MS, baseIntervalMs),
    );
    const multiplier = boundedNumber(backoffFactor, DEFAULT_BACKOFF_FACTOR, 1);
    let timer = null;
    let stopped = true;
    let inFlight = null;
    let failures = 0;

    function eligible() {
      return !stopped && isEnabled() && isOnline() && isVisible();
    }

    function clearTimer() {
      if (timer === null) return;
      clearTimeoutImpl(timer);
      timer = null;
    }

    function nextDelay() {
      if (!failures) return baseIntervalMs;
      return Math.min(maximumIntervalMs, baseIntervalMs * (multiplier ** failures));
    }

    function schedule(delay = nextDelay()) {
      clearTimer();
      if (!eligible()) return;
      timer = setTimeoutImpl(() => {
        timer = null;
        void poll();
      }, Math.max(0, Number(delay) || 0));
    }

    async function poll() {
      if (!eligible()) return false;
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(request);
      try {
        const succeeded = await inFlight;
        failures = succeeded === false ? failures + 1 : 0;
        return succeeded !== false;
      } catch {
        failures += 1;
        return false;
      } finally {
        inFlight = null;
        schedule();
      }
    }

    function refresh() {
      if (inFlight || !eligible()) return;
      schedule(0);
    }

    return Object.freeze({
      refresh,
      start() {
        stopped = false;
        schedule();
      },
      stop() {
        stopped = true;
        clearTimer();
      },
      reconcile() {
        if (!eligible()) {
          clearTimer();
          return;
        }
        refresh();
      },
      snapshot() {
        return Object.freeze({
          failures,
          inFlight: Boolean(inFlight),
          scheduled: timer !== null,
        });
      },
    });
  }

  function createAuthenticatedEventStream({
    ready = Promise.resolve(),
    createSource,
    onReady = () => {},
    onChange = () => {},
    onError = () => {},
  } = {}) {
    if (typeof createSource !== "function") throw new TypeError("createSource must be a function");
    let source = null;
    let starting = null;
    let stopped = false;

    function start() {
      if (source) return Promise.resolve(source);
      if (starting) return starting;
      stopped = false;
      starting = Promise.resolve(ready)
        .then(() => {
          if (stopped) return null;
          const created = createSource();
          if (!created || typeof created.addEventListener !== "function") {
            throw new TypeError("createSource must return an event source");
          }
          source = created;
          source.addEventListener("ready", onReady);
          source.addEventListener("journal", onChange);
          source.addEventListener("error", onError);
          return source;
        })
        .catch((error) => {
          if (!stopped) onError(error);
          return null;
        })
        .finally(() => {
          starting = null;
        });
      return starting;
    }

    function stop() {
      stopped = true;
      source?.close?.();
      source = null;
    }

    return Object.freeze({
      start,
      stop,
      snapshot() {
        return Object.freeze({
          connected: Boolean(source),
          starting: Boolean(starting),
          stopped,
        });
      },
    });
  }

  window.AgentHubJournalPolling = Object.freeze({
    createAuthenticatedEventStream,
    createBoundedPollingFallback,
  });
})();
