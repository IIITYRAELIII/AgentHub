"use strict";

(() => {
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

  window.AgentHubMessageSendTransaction = { run, observeRemote };
})();
