function nonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function normalizedTarget(target) {
  if (!target || typeof target !== "object") return null;
  const hubTaskId = String(target.hubTaskId ?? "").trim() || null;
  const provider = String(target.provider ?? "").trim() || null;
  const projectRoot = String(target.projectRoot ?? "").trim() || null;
  const threadId = String(target.threadId ?? "").trim() || null;
  if (!hubTaskId && !(provider && threadId)) return null;
  return Object.freeze({ hubTaskId, provider, projectRoot, threadId });
}

function targetLane(target) {
  if (target?.hubTaskId) return `task:${target.hubTaskId}`;
  return `provider:${target?.provider ?? ""}:${target?.projectRoot ?? ""}:${target?.threadId ?? ""}`;
}

export class ApplicationCommandBus {
  #commands = new Map();
  #lanes = new Map();

  register(type, {
    handler,
    mutating = false,
    target = "optional",
    lane = mutating ? "global" : "none",
  } = {}) {
    const commandType = nonEmpty(type, "command type");
    if (this.#commands.has(commandType)) throw new Error(`command already registered: ${commandType}`);
    if (typeof handler !== "function") throw new TypeError(`${commandType}.handler is required`);
    if (!["none", "optional", "required"].includes(target)) {
      throw new TypeError(`${commandType}.target must be none, optional or required`);
    }
    if (!(typeof lane === "function" || ["none", "global", "target"].includes(lane))) {
      throw new TypeError(`${commandType}.lane is invalid`);
    }
    this.#commands.set(commandType, Object.freeze({ handler, mutating: Boolean(mutating), target, lane }));
    return this;
  }

  has(type) {
    return this.#commands.has(String(type ?? "").trim());
  }

  async dispatch({ type, payload = {}, target = null, context = {} } = {}) {
    const commandType = nonEmpty(type, "command type");
    const command = this.#commands.get(commandType);
    if (!command) throw new Error(`unknown application command: ${commandType}`);
    const clientId = nonEmpty(context.clientId, "clientId");
    const taskTarget = normalizedTarget(target);
    if (command.target === "required" && !taskTarget) {
      throw new Error(`${commandType} requires an explicit task target`);
    }
    if (command.target === "none" && taskTarget) {
      throw new Error(`${commandType} does not accept a task target`);
    }
    const envelope = Object.freeze({
      type: commandType,
      payload: payload && typeof payload === "object" ? payload : {},
      target: taskTarget,
      context: Object.freeze({ ...context, clientId }),
    });
    const execute = () => command.handler(envelope);
    if (!command.mutating || command.lane === "none") return execute();
    const lane = typeof command.lane === "function"
      ? nonEmpty(command.lane(envelope), `${commandType} lane`)
      : command.lane === "target" ? targetLane(taskTarget) : "global";
    const previous = this.#lanes.get(lane) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(execute);
    const settled = operation.catch(() => {});
    this.#lanes.set(lane, settled);
    try {
      return await operation;
    } finally {
      if (this.#lanes.get(lane) === settled) this.#lanes.delete(lane);
    }
  }
}
