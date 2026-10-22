import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { trustedWindowsPowerShellPath } from "../process/system-boot-identity.mjs";

const source = fileURLToPath(new URL("./sealed-transport-delete.cs", import.meta.url));
const script = ["$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "Add-Type -Path $env:AGENT_HUB_TRANSPORT_SOURCE",
  "$b=ConvertFrom-Json $env:AGENT_HUB_TRANSPORT_BINDING",
  "[AgentHubSealedTransportDelete]::Delete($env:AGENT_HUB_TRANSPORT_PATH, [string]$b.dev, [string]$b.ino, [string]$b.size, [string]$b.sha256)",
  "'deleted'"].join("\n");

export function deleteSealedTransport(target, binding) {
  if (process.platform !== "win32") return Promise.reject(new Error("sealed-transport-platform-unavailable"));
  if (!["dev", "ino", "size"].every(k => /^\d+$/u.test(String(binding?.[k])))
      || !/^[a-f0-9]{64}$/u.test(binding?.sha256)) throw new TypeError("Invalid transport identity");
  return new Promise((resolve, reject) => {
    execFile(trustedWindowsPowerShellPath(process.env), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], {
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
        AGENT_HUB_TRANSPORT_SOURCE: source, AGENT_HUB_TRANSPORT_PATH: path.resolve(target),
        AGENT_HUB_TRANSPORT_BINDING: JSON.stringify(binding) },
      windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024,
      // No timeout that abandons a destructive child. Shutdown drains the owner.
    }, (error, stdout) => {
      if (error) reject(error);
      else if (stdout.trim() !== "deleted") reject(new Error("transport-outcome-unknown"));
      else resolve();
    });
  });
}
