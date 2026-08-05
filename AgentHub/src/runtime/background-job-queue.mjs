export class BackgroundJobQueueFullError extends Error {
  constructor(limit) {
    super(`background job queue is full (${limit})`);
    this.name = "BackgroundJobQueueFullError";
    this.code = "QUEUE_FULL";
    this.limit = limit;
  }
}

export class BackgroundJobQueue {
  #active = 0;
  #pending = [];
  #concurrency;
  #maxJobs;
  #onChange;

  constructor({ concurrency = 1, maxJobs = 20, onChange = () => {} } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new TypeError("concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(maxJobs) || maxJobs < concurrency) {
      throw new TypeError("maxJobs must be an integer not smaller than concurrency");
    }
    if (typeof onChange !== "function") throw new TypeError("onChange must be a function");
    this.#concurrency = concurrency;
    this.#maxJobs = maxJobs;
    this.#onChange = onChange;
  }

  get active() {
    return this.#active;
  }

  get pending() {
    return this.#pending.length;
  }

  get size() {
    return this.#active + this.#pending.length;
  }

  enqueue(work) {
    if (typeof work !== "function") throw new TypeError("work must be a function");
    if (this.size >= this.#maxJobs) throw new BackgroundJobQueueFullError(this.#maxJobs);
    const promise = new Promise((resolve, reject) => {
      this.#pending.push({ work, resolve, reject });
    });
    this.#notify();
    this.#drain();
    return promise;
  }

  #drain() {
    while (this.#active < this.#concurrency && this.#pending.length) {
      const job = this.#pending.shift();
      this.#active += 1;
      this.#notify();
      Promise.resolve()
        .then(job.work)
        .then(
          (value) => this.#finish(job, { value }),
          (error) => this.#finish(job, { error }),
        );
    }
  }

  #finish(job, outcome) {
    this.#active -= 1;
    this.#notify();
    this.#drain();
    if (Object.hasOwn(outcome, "error")) job.reject(outcome.error);
    else job.resolve(outcome.value);
  }

  #notify() {
    try {
      this.#onChange({ active: this.active, pending: this.pending, size: this.size });
    } catch {
      // Наблюдатель не должен ломать саму очередь.
    }
  }
}
