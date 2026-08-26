"use strict";

(() => {
  async function firstSuccessfulWithDelayedFallback({
    primary,
    fallback,
    delayMs,
    setTimer = (callback, timeoutMs) => window.setTimeout(callback, timeoutMs),
    clearTimer = (timer) => window.clearTimeout(timer),
  }) {
    const primaryPromise = Promise.resolve().then(primary);
    let timer = null;
    let fallbackStarted = false;
    const fallbackPromise = new Promise((resolve, reject) => {
      const startFallback = () => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        Promise.resolve().then(fallback).then(resolve, reject);
      };
      timer = setTimer(startFallback, Math.max(0, Number(delayMs) || 0));
      primaryPromise.then(
        () => clearTimer(timer),
        () => {
          clearTimer(timer);
          startFallback();
        },
      );
    });
    try {
      return await Promise.any([primaryPromise, fallbackPromise]);
    } catch (error) {
      const failures = Array.isArray(error?.errors) ? error.errors : [];
      throw failures.at(-1) ?? error;
    }
  }

  async function run({ send, reject, receive, synchronize, synchronizationFailed }) {
    let result;
    try {
      result = await send();
    } catch (error) {
      await reject(error);
      throw error;
    }

    try {
      await receive(result);
      await synchronize(result);
    } catch (error) {
      await synchronizationFailed(error, result);
    }
    return result;
  }

  async function observeRemote({
    wait,
    receive,
    reject,
    unconfirm,
    refresh = async () => {},
    definitelyRejected = () => false,
    report = () => {},
  }) {
    let result;
    try {
      result = await wait();
    } catch (error) {
      report(error);
      try {
        if (definitelyRejected(error)) await reject(error);
        else await unconfirm(error);
      } finally {
        await refresh(error);
      }
      return null;
    }
    try {
      await receive(result);
    } catch (error) {
      report(error);
      await refresh(error);
    }
    return result;
  }

  window.AgentHubMessageSendTransaction = {
    run,
    observeRemote,
    firstSuccessfulWithDelayedFallback,
  };
})();
