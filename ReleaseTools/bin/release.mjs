#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient, executeRelease } from "../src/hub-client.mjs";
import { toolIdentity } from "../src/tool-identity.mjs";
import { buildPinnedCandidate } from "../src/build.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function parseArguments(argv) {
  const [action, ...args] = argv;
  const values = {};
  let fullTests = false;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (key === "--full-tests") { fullTests = true; i -= 1; continue; }
    if (!["--connection-file", "--request-file"].includes(key) || Object.hasOwn(values, key) || !value) throw new Error("Invalid release argument");
    values[key] = value;
  }
  if (!values["--connection-file"] || !values["--request-file"]) throw new Error("Expected --connection-file and --request-file");
  return { action, connectionFile: values["--connection-file"], requestFile: values["--request-file"], fullTests };
}

export async function main(argv, { output = line => process.stdout.write(`${JSON.stringify(line)}\n`) } = {}) {
  argv = argv.filter(value => value !== "--json");
  const identity = await toolIdentity();
  if (!argv.length || ["--help", "help"].includes(argv[0])) {
    const result = { usage: "agent-hub-release <command> [arguments]", commands: {
      identity: "Print the independent tool version and file digest",
      doctor: "Read-only MCP compatibility check; optional --connection-file",
      run: "Authorize one release using --connection-file and --request-file; optional --full-tests",
      continue: "Continue an explicitly addressed original using business JSON",
      get: "Read an exact release operation using business JSON",
      accept: "Submit one Task Await with its original request ID and fresh CAS",
      "task-read": "Read an original Task receipt; never replay its mutation",
      build: "Build a pinned candidate through its public application self-build interface",
      package: "Package an exact owner PREPARED receipt; see README for flags",
    } };
    output(result); return result;
  }
  if (argv.length === 1 && argv[0] === "identity") { output(identity); return identity; }
  if (argv[0] === "doctor") {
    if (argv.length === 1) {
      const result = { tool: identity, mode: "offline", credentials: "missing", endpointChecked: false,
        next: "Supply --connection-file for the existing Hub MCP endpoint" };
      output(result); return result;
    }
    if (argv.length !== 3 || argv[1] !== "--connection-file") throw new Error("Doctor accepts only --connection-file");
    let connection;
    try { connection = JSON.parse(await readFile(argv[2], "utf8")); }
    catch { throw new Error("Connection file could not be read as JSON"); }
    const client = new HubClient(connection);
    const info = await client.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: identity.name, version: identity.version } });
    const methods = await client.rpc("tools/list");
    const available = new Set(methods.tools.map(tool => tool.name));
    const required = ["hub_release_run", "hub_release_continue", "hub_release_get", "hub_task_status_update", "hub_task_operation_get"];
    const result = { tool: identity, mode: "http-mcp", server: info.serverInfo,
      credentials: "present_not_authorized_until_business_call", endpointChecked: true,
      originalReleaseReadback: Boolean(methods.tools.find(tool => tool.name === "hub_release_get")?.inputSchema?.properties?.operation_request_id),
      missingMethods: required.filter(name => !available.has(name)) };
    output(result); return result;
  }
  if (argv[0] === "package") {
    const command = process.platform === "win32" ? "python.exe" : "python3";
    const result = await promisify(execFile)(command, ["-B", "-X", "utf8",
      fileURLToPath(new URL("../python/build_release.py", import.meta.url)), ...argv.slice(1)],
    { encoding: "utf8", windowsHide: true, maxBuffer: Infinity });
    const value = JSON.parse(result.stdout); output({ tool: identity, result: value }); return value;
  }
  if (argv[0] === "build") {
    const values = {};
    for (let i = 1; i < argv.length; i += 2) {
      if (!["--candidate", "--commit", "--runtime-root", "--release-id", "--artifact-version"].includes(argv[i])
        || !argv[i + 1] || Object.hasOwn(values, argv[i])) throw new Error("Invalid build argument");
      values[argv[i]] = argv[i + 1];
    }
    if (Object.keys(values).length !== 5) throw new Error("Build requires candidate, commit, runtime-root, release-id and artifact-version");
    const result = await buildPinnedCandidate({ candidate: values["--candidate"], commit: values["--commit"],
      runtimeRoot: values["--runtime-root"], releaseId: values["--release-id"], artifactVersion: values["--artifact-version"] });
    output({ tool: identity, result }); return result;
  }
  const input = parseArguments(argv);
  let connection;
  try { connection = JSON.parse(await readFile(input.connectionFile, "utf8")); }
  catch { throw new Error("Connection file could not be read as JSON"); }
  const request = JSON.parse(await readFile(input.requestFile, "utf8"));
  if (input.fullTests) {
    if (input.action !== "run") throw new Error("--full-tests applies to a new run only; continuation retains its original validation");
    request.validation_mode = "full";
  }
  const client = new HubClient(connection);
  const result = await executeRelease(client, input.action, request, {
    onAccepted: accepted => output({ tool: identity, accepted }),
  });
  output({ tool: identity, result });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    if (result?.taskOperation && result.taskOperation.status !== "succeeded") process.exitCode = 1;
    if (result?.operation?.state === "failed") process.exitCode = 1;
    if (result?.accepted === false) process.exitCode = 1;
    if (result?.missingMethods?.length) process.exitCode = 1;
  }).catch(error => {
    // Endpoint/caller credentials are deliberately excluded from diagnostics.
    process.stderr.write(`${JSON.stringify({ error: { name: error.name, message: error.message,
      ...(error.requestId ? { requestId: error.requestId } : {}) } })}\n`);
    if (error.originalReceipt) process.stdout.write(`${JSON.stringify({ originalReceipt: error.originalReceipt })}\n`);
    process.exitCode = 1;
  });
}
