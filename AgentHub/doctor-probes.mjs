import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { callTelegramJson } from "./telegram-api.mjs";
import { stopProcessTree } from "./claude-run-io.mjs";

export async function probeTelegramConnectivity({
  token,
  apiBaseUrl,
  fetchImpl = fetch,
  timeoutMs = 5_000,
} = {}) {
  const bot = await callTelegramJson({
    token,
    apiBaseUrl,
    method: "getMe",
    body: {},
    fetchImpl,
    timeoutMs,
  });
  if (!bot?.id) throw new Error("Telegram getMe returned no bot id");
  return { id: bot.id, username: String(bot.username ?? "") };
}

export async function probeCodexAppServer({
  command,
  prefixArgs = [],
  cwd,
  timeoutMs = 10_000,
  spawnImpl = spawn,
  stopTree = stopProcessTree,
} = {}) {
  const child = spawnImpl(command, [...prefixArgs, "app-server", "--stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let sequence = 1;
  let stderr = "";
  let transportError = null;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  const lines = createInterface({ input: child.stdout });
  const rejectPending = (error) => {
    transportError = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  child.once("error", rejectPending);
  child.once("exit", (code, signal) => {
    if (pending.size) rejectPending(new Error(
      `Codex App Server exited before probe completion (code=${code}, signal=${signal})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    ));
  });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message ?? "Codex App Server RPC failed"));
    else item.resolve(message.result);
  });

  const rpc = (method, params = {}) => {
    if (transportError) return Promise.reject(transportError);
    const id = sequence++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex App Server ${method} probe timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  };

  try {
    await new Promise((resolve, reject) => {
      if (child.pid) resolve();
      else {
        child.once("spawn", resolve);
        child.once("error", reject);
      }
    });
    const initialized = await rpc("initialize", {
      clientInfo: { name: "agent_hub_doctor", title: "Agent Hub Doctor", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const listed = await rpc("thread/list", { limit: 1, archived: false });
    return {
      userAgent: String(initialized?.userAgent ?? ""),
      threadCount: Array.isArray(listed?.data) ? listed.data.length : 0,
    };
  } finally {
    lines.close();
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    const exited = child.exitCode != null
      ? Promise.resolve()
      : new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    if (child.pid) await stopTree(child.pid).catch(() => child.kill());
    else child.kill();
    await exited;
  }
}
