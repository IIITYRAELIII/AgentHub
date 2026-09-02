import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { claudeUsageAccount } from "../../domain/usage-account-identity.mjs";

function claudeConfigFile({ env = process.env, homedir = os.homedir } = {}) {
  const configured = String(env.CLAUDE_CONFIG_DIR ?? "").trim();
  const root = configured || homedir();
  return path.join(path.resolve(root), ".claude.json");
}

function accountDimension(value) {
  return claudeUsageAccount(value);
}

export function createClaudeAccountReader({
  file = "",
  env = process.env,
  homedir = os.homedir,
  statImpl = stat,
  readFileImpl = readFile,
} = {}) {
  const target = file ? path.resolve(file) : claudeConfigFile({ env, homedir });
  let cachedSignature = "";
  let cachedAccount = null;

  return async function readClaudeAccount() {
    let info;
    try {
      info = await statImpl(target);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile()) return null;
    const signature = `${info.mtimeMs}:${info.size}`;
    if (signature === cachedSignature) return cachedAccount;
    const parsed = JSON.parse(await readFileImpl(target, "utf8"));
    cachedAccount = accountDimension(parsed);
    cachedSignature = signature;
    return cachedAccount;
  };
}

export const readClaudeAccount = createClaudeAccountReader();
