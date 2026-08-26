"use strict";

(() => {
  function create({ maxConcurrent = 2 } = {}) {
    const limit = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
    const queue = [];
    let active = 0;

    const drain = () => {
      while (active < limit && queue.length > 0) {
        const request = queue.shift();
        active += 1;
        Promise.resolve()
          .then(request.operation)
          .then((value) => {
            active -= 1;
            drain();
            request.resolve(value);
          }, (error) => {
            active -= 1;
            drain();
            request.reject(error);
          });
      }
    };

    return Object.freeze({
      run(operation) {
        if (typeof operation !== "function") {
          return Promise.reject(new TypeError("Background HTTP operation is required"));
        }
        return new Promise((resolve, reject) => {
          queue.push({ operation, resolve, reject });
          drain();
        });
      },
      snapshot: () => ({ active, queued: queue.length, maxConcurrent: limit }),
    });
  }

  window.AgentHubBackgroundHttpScheduler = Object.freeze({ create });
})();
