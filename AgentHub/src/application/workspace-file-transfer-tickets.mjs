import { randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class WorkspaceFileTransferTickets {
  #capacity;
  #entries = new Map();
  #randomBytes;
  #ttlMs;

  constructor({ capacity = 64, randomBytesImpl = randomBytes, ttlMs = 60_000 } = {}) {
    this.#capacity = Math.max(1, Math.floor(Number(capacity) || 64));
    this.#randomBytes = randomBytesImpl;
    this.#ttlMs = Math.max(1_000, Math.floor(Number(ttlMs) || 60_000));
  }

  get size() {
    return this.#entries.size;
  }

  issue(file, { deviceId = "", now = Date.now() } = {}) {
    const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    this.#prune(observedAt);
    while (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest == null) break;
      this.#entries.delete(oldest);
    }
    let token;
    do {
      token = this.#randomBytes(32).toString("base64url");
    } while (this.#entries.has(token));
    const ticket = {
      bytes: Number(file?.bytes) || 0,
      deviceId: String(deviceId ?? ""),
      expiresAt: observedAt + this.#ttlMs,
      name: String(file?.name ?? ""),
      target: String(file?.target ?? ""),
      type: String(file?.type ?? "application/octet-stream"),
    };
    if (!ticket.target || !ticket.name || ticket.bytes < 1) {
      throw new Error("Некорректный файл для передачи");
    }
    this.#entries.set(token, ticket);
    return {
      bytes: ticket.bytes,
      expiresAt: ticket.expiresAt,
      name: ticket.name,
      token,
    };
  }

  consume(value, { now = Date.now() } = {}) {
    const token = String(value ?? "").trim();
    if (!TOKEN_PATTERN.test(token)) return null;
    const ticket = this.#entries.get(token) ?? null;
    if (!ticket) return null;
    this.#entries.delete(token);
    const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return ticket.expiresAt > observedAt ? ticket : null;
  }

  #prune(now) {
    for (const [token, ticket] of this.#entries) {
      if (ticket.expiresAt > now) continue;
      this.#entries.delete(token);
    }
  }
}
