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

  window.AgentHubMessageSendTransaction = { run };
})();
