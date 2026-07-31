import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { readJsonWithBackup, writeTextAtomic } from "./state-store.mjs";

const CADDY_VERSION = "2.11.3";
const CADDY_ARCHIVE_SHA256 = "94ba71226d30a07d8eca3f971e88222fafb13f8bc46f391ed01afd6780f9c030";
const CADDY_ARCHIVE_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_windows_amd64.zip`;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : "";
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

async function install() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The direct gateway installer currently supports Windows x64 only");
  }
  const publicUrl = argument("--url").replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error("Use --url https://host.example");
  }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("--url must be an HTTPS origin without a path");
  }
  const runtimeRoot = path.resolve(argument("--runtime-root") || defaultRuntimeRoot());
  const gatewayDirectory = path.join(runtimeRoot, "gateway");
  const executable = path.join(gatewayDirectory, "caddy.exe");
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-caddy-"));
  try {
    const archive = path.join(temporaryDirectory, "caddy.zip");
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Invoke-WebRequest -UseBasicParsing -Uri ${powershellLiteral(CADDY_ARCHIVE_URL)}`
        + ` -OutFile ${powershellLiteral(archive)}`,
    ]);
    const bytes = await readFile(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== CADDY_ARCHIVE_SHA256) {
      throw new Error(`Caddy archive hash mismatch: ${digest}`);
    }
    await run("tar.exe", ["-xf", archive, "-C", temporaryDirectory]);
    await access(path.join(temporaryDirectory, "caddy.exe"));
    await mkdir(gatewayDirectory, { recursive: true });
    await copyFile(path.join(temporaryDirectory, "caddy.exe"), executable);
    await writeTextAtomic(path.join(runtimeRoot, "gateway.json"), `${JSON.stringify({
      enabled: true,
      publicUrl,
      executable: "gateway/caddy.exe",
      caddyVersion: CADDY_VERSION,
      caddySha256: CADDY_ARCHIVE_SHA256,
    }, null, 2)}\n`);
    const configFile = path.join(runtimeRoot, "config.json");
    const runtimeConfig = await readJsonWithBackup(configFile);
    if (runtimeConfig.value) {
      await writeTextAtomic(`${configFile}.before-direct-gateway`, `${JSON.stringify(runtimeConfig.value, null, 2)}\n`);
      runtimeConfig.value.miniApp ??= {};
      runtimeConfig.value.miniApp.worker ??= {};
      runtimeConfig.value.miniApp.quickTunnel ??= {};
      runtimeConfig.value.miniApp.worker.enabled = false;
      runtimeConfig.value.miniApp.quickTunnel.enabled = false;
      await writeTextAtomic(configFile, `${JSON.stringify(runtimeConfig.value, null, 2)}\n`);
    }
    console.log(`Direct gateway installed for ${publicUrl}`);
    console.log(`Caddy: ${executable}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const command = String(process.argv[2] ?? "").trim().toLowerCase();
if (command !== "install") {
  console.error("Usage: node direct-gateway-cli.mjs install --url https://host.example [--runtime-root PATH]");
  process.exitCode = 2;
} else {
  await install();
}
