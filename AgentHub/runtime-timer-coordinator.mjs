export class RuntimeTimerCoordinator {
  constructor({
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = Date.now,
  } = {}) {
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.timers = new Map();
    this.groups = new Map();
  }

  schedule(name, callback, delayMs = 0, { replaceIfEarlier = false, unref = false } = {}) {
    const key = String(name ?? "").trim();
    if (!key || typeof callback !== "function") return false;
    const delay = Math.max(0, Number(delayMs) || 0);
    const dueAt = this.now() + delay;
    const previous = this.timers.get(key);
    if (previous) {
      if (!replaceIfEarlier || previous.dueAt <= dueAt) return false;
      this.clearTimeoutImpl(previous.timer);
    }
    const record = { timer: null, dueAt };
    record.timer = this.setTimeoutImpl(() => {
      if (this.timers.get(key) !== record) return;
      this.timers.delete(key);
      void callback();
    }, delay);
    if (unref) record.timer?.unref?.();
    this.timers.set(key, record);
    return true;
  }

  has(name) {
    return this.timers.has(String(name ?? "").trim());
  }

  clear(name) {
    const key = String(name ?? "").trim();
    const record = this.timers.get(key);
    if (!record) return false;
    this.clearTimeoutImpl(record.timer);
    this.timers.delete(key);
    return true;
  }

  scheduleInGroup(groupName, itemKey, callback, delayMs = 0, options = {}) {
    const group = String(groupName ?? "").trim();
    const item = String(itemKey ?? "").trim();
    if (!group || !item) return false;
    const timerName = `${group}:${item}`;
    if (!this.schedule(timerName, () => {
      this.groups.get(group)?.delete(item);
      if (this.groups.get(group)?.size === 0) this.groups.delete(group);
      return callback();
    }, delayMs, options)) return false;
    const items = this.groups.get(group) ?? new Map();
    items.set(item, timerName);
    this.groups.set(group, items);
    return true;
  }

  clearGroup(groupName) {
    const group = String(groupName ?? "").trim();
    const items = this.groups.get(group);
    if (!items) return 0;
    let cleared = 0;
    for (const timerName of items.values()) {
      if (this.clear(timerName)) cleared += 1;
    }
    this.groups.delete(group);
    return cleared;
  }

  clearAll() {
    for (const record of this.timers.values()) this.clearTimeoutImpl(record.timer);
    this.timers.clear();
    this.groups.clear();
  }
}
