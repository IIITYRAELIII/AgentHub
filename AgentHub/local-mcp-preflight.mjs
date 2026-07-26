import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const DEFAULT_PROBE_TIMEOUT_MS = 350;

function decodeSectionName(match) {
  if (match[1] != null) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  return match[2] ?? match[3] ?? "";
}

function quotedValue(line, key) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|'([^']*)')`));
  if (!match) return null;
  if (match[1] == null) return match[2];
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

export function isLoopbackMcpUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseLocalHttpMcpServers(text) {
  const servers = [];
  let current = null;

  const finish = () => {
    if (current?.url && current.enabled !== false && isLoopbackMcpUrl(current.url)) {
      const parsed = new URL(current.url);
      servers.push({
        name: current.name,
        url: current.url,
        host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname,
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      });
    }
    current = null;
  };

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const section = line.match(/^\s*\[mcp_servers\.(?:"((?:\\.|[^"])*)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/);
    if (section) {
      finish();
      current = { name: decodeSectionName(section), url: null, enabled: true };
      continue;
    }
    if (/^\s*\[/.test(line)) {
      finish();
      continue;
    }
    if (!current) continue;
    const url = quotedValue(line, "url");
    if (url != null) current.url = url;
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\b/i);
    if (enabled) current.enabled = enabled[1].toLowerCase() === "true";
  }
  finish();
  return servers;
}

export function codexMcpEnabledOverride(name, enabled) {
  const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  return `mcp_servers.${key}.enabled=${enabled ? "true" : "false"}`;
}

export function probeTcpEndpoint({ host, port }, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function unavailableLocalMcpOverrides({
  configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"),
  probe = probeTcpEndpoint,
} = {}) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { args: [], disabled: [] };
    throw error;
  }

  const servers = parseLocalHttpMcpServers(text);
  const availability = await Promise.all(servers.map((server) => probe(server)));
  const disabled = servers.filter((_, index) => !availability[index]);
  return {
    args: disabled.flatMap((server) => ["-c", codexMcpEnabledOverride(server.name, false)]),
    disabled,
  };
}
