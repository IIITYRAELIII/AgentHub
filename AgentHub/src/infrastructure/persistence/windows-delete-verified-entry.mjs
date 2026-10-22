import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trustedWindowsPowerShellPath } from "../process/system-boot-identity.mjs";

const source = fileURLToPath(new URL("./windows-delete-verified-entry.cs", import.meta.url));
const script = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "Add-Type -Path $env:AGENT_HUB_VERIFIED_DELETE_SOURCE",
  "[AgentHubVerifiedEntryDeletion]::Delete($env:AGENT_HUB_VERIFIED_DELETE_PATH,",
  "  $env:AGENT_HUB_VERIFIED_DELETE_VOLUME, $env:AGENT_HUB_VERIFIED_DELETE_INDEX,",
  "  $env:AGENT_HUB_VERIFIED_DELETE_SIZE,",
  "  [bool]::Parse($env:AGENT_HUB_VERIFIED_DELETE_DIRECTORY),",
  "  $env:AGENT_HUB_VERIFIED_DELETE_TEST_BARRIER)",
  "'deleted'",
].join("\n");

export function deleteVerifiedWindowsEntry(target, identity, {
  execFileImpl = execFile,
  testBarrier = "",
} = {}) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Handle-bound backup pruning requires Windows"));
  }
  if (!identity || !/^\d+$/u.test(String(identity.dev))
      || !/^\d+$/u.test(String(identity.ino))
      || !/^\d+$/u.test(String(identity.size))) {
    return Promise.reject(new Error("Verified deletion requires exact numeric receipt identity"));
  }
  const powershell = trustedWindowsPowerShellPath(process.env);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFileImpl(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: process.env.PATH,
        AGENT_HUB_VERIFIED_DELETE_SOURCE: source,
        AGENT_HUB_VERIFIED_DELETE_PATH: path.resolve(target),
        AGENT_HUB_VERIFIED_DELETE_VOLUME: String(identity.dev),
        AGENT_HUB_VERIFIED_DELETE_INDEX: String(identity.ino),
        AGENT_HUB_VERIFIED_DELETE_SIZE: String(identity.size),
        AGENT_HUB_VERIFIED_DELETE_DIRECTORY: String(Boolean(identity.directory)),
        AGENT_HUB_VERIFIED_DELETE_TEST_BARRIER: String(testBarrier),
      },
      timeout: 20_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout) => {
      if (error) reject(error);
      else if (String(stdout).trim() !== "deleted") reject(new Error("Verified deletion returned no receipt"));
      else resolve();
    });
  });
}
