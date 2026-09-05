import { createHash, createHmac } from "node:crypto";

export const REMOTE_CONTROL_WAKE_PROTOCOL = "agent-hub-control-wake-v1";
export const REMOTE_CONTROL_WAKE_FALLBACK_MS = 10_000;
export const REMOTE_CONTROL_WAKE_HEARTBEAT_MS = 60_000;
export const REMOTE_CONTROL_WAKE_PONG_TIMEOUT_MS = 10_000;

export function signRemoteControlWakeRequest({
  secret,
  pathname,
  timestamp = Math.trunc(Date.now() / 1_000),
}) {
  const bodyHash = createHash("sha256").update("").digest("hex");
  const signature = createHmac("sha256", secret)
    .update([timestamp, "GET", pathname, bodyHash].join("\n"))
    .digest("hex");
  return { timestamp, signature };
}

export function remoteControlWakeUrl({ publicUrl, pathname, secret, parameters = {} }) {
  const target = new URL(pathname, `${String(publicUrl).replace(/\/+$/u, "")}/`);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const { timestamp, signature } = signRemoteControlWakeRequest({ secret, pathname });
  target.searchParams.set("timestamp", String(timestamp));
  target.searchParams.set("signature", signature);
  for (const [key, value] of Object.entries(parameters)) {
    if (value != null && String(value)) target.searchParams.set(key, String(value));
  }
  return target.href;
}

function addSocketListener(socket, type, listener) {
  if (typeof socket?.addEventListener === "function") {
    socket.addEventListener(type, listener);
    return;
  }
  if (typeof socket?.on === "function") socket.on(type, listener);
}

export class RemoteControlWakeChannel {
  #createUrl;
  #createSocket;
  #fallbackMs;
  #heartbeatMs;
  #pongTimeoutMs;
  #logger;
  #setTimeout;
  #clearTimeout;
  #setInterval;
  #clearInterval;
  #socket = null;
  #open = false;
  #pending = false;
  #closed = false;
  #waitPromise = null;
  #waitResolve = null;
  #fallbackTimer = null;
  #heartbeatTimer = null;
  #pongTimer = null;
  #lastAvailabilityRevision = null;

  constructor({
    createUrl,
    createSocket = (url) => new WebSocket(url),
    fallbackMs = REMOTE_CONTROL_WAKE_FALLBACK_MS,
    heartbeatMs = REMOTE_CONTROL_WAKE_HEARTBEAT_MS,
    pongTimeoutMs = REMOTE_CONTROL_WAKE_PONG_TIMEOUT_MS,
    logger = console,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (typeof createUrl !== "function") throw new TypeError("wake channel createUrl is required");
    if (typeof createSocket !== "function") throw new TypeError("wake channel createSocket is required");
    this.#createUrl = createUrl;
    this.#createSocket = createSocket;
    this.#fallbackMs = Math.max(1_000, Math.trunc(Number(fallbackMs) || REMOTE_CONTROL_WAKE_FALLBACK_MS));
    this.#heartbeatMs = Math.max(10_000, Math.trunc(Number(heartbeatMs) || REMOTE_CONTROL_WAKE_HEARTBEAT_MS));
    this.#pongTimeoutMs = Math.max(1_000, Math.trunc(Number(pongTimeoutMs) || REMOTE_CONTROL_WAKE_PONG_TIMEOUT_MS));
    this.#logger = logger;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#setInterval = setIntervalImpl;
    this.#clearInterval = clearIntervalImpl;
  }

  #settle(reason) {
    if (!this.#waitResolve) return false;
    const resolve = this.#waitResolve;
    this.#waitResolve = null;
    this.#waitPromise = null;
    this.#clearTimeout(this.#fallbackTimer);
    this.#fallbackTimer = null;
    if (["connected", "wake"].includes(reason)) this.#pending = false;
    resolve(reason);
    return true;
  }

  #scheduleFallback() {
    if (this.#closed || this.#open || !this.#waitResolve || this.#fallbackTimer) return;
    this.#fallbackTimer = this.#setTimeout(() => {
      this.#fallbackTimer = null;
      this.#settle("fallback");
    }, this.#fallbackMs);
    this.#fallbackTimer.unref?.();
  }

  #startHeartbeat() {
    this.#clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = this.#setInterval(() => {
      if (!this.#open || this.#pongTimer !== null) return;
      const socket = this.#socket;
      try {
        socket?.send("ping");
        const pongTimer = this.#setTimeout(() => {
          if (this.#pongTimer !== pongTimer) return;
          this.#pongTimer = null;
          if (!this.#open || this.#socket !== socket) return;
          this.#disconnect(socket, { closeSocket: true, immediateFallback: true });
        }, this.#pongTimeoutMs);
        this.#pongTimer = pongTimer;
        this.#pongTimer.unref?.();
      } catch {
        this.#disconnect(socket, { closeSocket: true, immediateFallback: true });
      }
    }, this.#heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  #clearPongDeadline() {
    this.#clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
  }

  #disconnect(socket = this.#socket, { closeSocket = false, immediateFallback = false } = {}) {
    if (socket && this.#socket !== socket) return;
    this.#open = false;
    this.#pending = false;
    this.#socket = null;
    this.#clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#clearPongDeadline();
    if (closeSocket) {
      try {
        socket?.close();
      } catch {}
    }
    if (!immediateFallback || !this.#settle("fallback")) this.#scheduleFallback();
  }

  async #ensureSocket() {
    if (this.#closed || this.#socket) return;
    let socket;
    try {
      socket = this.#createSocket(await this.#createUrl());
    } catch (error) {
      this.#logger.warn?.(`Remote control wake connection failed: ${String(error?.message ?? error)}`);
      this.#scheduleFallback();
      return;
    }
    this.#socket = socket;
    addSocketListener(socket, "open", () => {
      if (this.#closed || this.#socket !== socket) return;
      this.#open = true;
      this.#pending = true;
      this.#startHeartbeat();
      this.#settle("connected");
    });
    addSocketListener(socket, "message", (event) => {
      if (this.#closed || this.#socket !== socket) return;
      const data = String(event?.data ?? event ?? "");
      if (data === "pong") {
        this.#clearPongDeadline();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      if (payload?.protocol !== REMOTE_CONTROL_WAKE_PROTOCOL || payload?.kind !== "available") return;
      const revision = payload.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      if (this.#lastAvailabilityRevision !== null && revision <= this.#lastAvailabilityRevision) return;
      this.#lastAvailabilityRevision = revision;
      this.#pending = true;
      this.#settle("wake");
    });
    addSocketListener(socket, "close", () => {
      if (this.#socket === socket) this.#disconnect(socket);
    });
    addSocketListener(socket, "error", () => {
      if (this.#socket !== socket) return;
      this.#disconnect(socket, { closeSocket: true });
    });
  }

  async wait() {
    if (this.#closed) return "closed";
    if (this.#pending) {
      this.#pending = false;
      return "wake";
    }
    if (this.#waitPromise) return this.#waitPromise;
    this.#waitPromise = new Promise((resolve) => {
      this.#waitResolve = resolve;
    });
    const waiting = this.#waitPromise;
    await this.#ensureSocket();
    if (!this.#open) this.#scheduleFallback();
    return waiting;
  }

  close() {
    this.#closed = true;
    this.#clearTimeout(this.#fallbackTimer);
    this.#clearInterval(this.#heartbeatTimer);
    this.#clearTimeout(this.#pongTimer);
    this.#fallbackTimer = null;
    this.#heartbeatTimer = null;
    this.#pongTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#open = false;
    this.#pending = false;
    try {
      socket?.close();
    } catch {}
    this.#settle("closed");
  }
}
