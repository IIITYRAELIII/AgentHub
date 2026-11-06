import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openReleaseApiHost } from "./src/interfaces/mcp/release-api-host.mjs";

export function parseApiArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--provider", "--thread", "--stream", "--connection-file"].includes(args[i])
      || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error("Invalid release API argument");
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 4) throw new Error("Expected provider, thread, stream and connection-file");
  return { identity: { provider: options["--provider"], threadId: options["--thread"], streamId: options["--stream"] },
    connectionFile: path.resolve(options["--connection-file"]) };
}

export async function serveReleaseApi(input, { waitForClose = () => new Promise(resolve => {
  process.once("SIGINT", resolve); process.once("SIGTERM", resolve);
}) } = {}) {
  const host = await openReleaseApiHost(input.identity);
  const bytes = `${JSON.stringify(host.connection)}\n`;
  let created = false;
  try {
    await writeFile(input.connectionFile, bytes, { flag: "wx", mode: 0o600 }); created = true;
    process.stdout.write("Release API ready; connection credentials are in the addressed private file.\n");
    await waitForClose();
  } finally {
    try { await host.close(); }
    finally {
      if (created && await readFile(input.connectionFile, "utf8").catch(() => null) === bytes) await unlink(input.connectionFile);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveReleaseApi(parseApiArguments(process.argv.slice(2))).catch(error => {
    process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1;
  });
}
