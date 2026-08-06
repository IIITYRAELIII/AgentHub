import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexMcpEnabledOverride,
  isLoopbackMcpUrl,
  parseLocalHttpMcpServers,
  unavailableLocalMcpOverrides,
} from "../../../src/infrastructure/process/local-mcp-preflight.mjs";

test("local MCP parser selects enabled loopback HTTP servers only", () => {
  const result = parseLocalHttpMcpServers(`
[mcp_servers.edt-mcp]
url = "http://localhost:8765/mcp"

[mcp_servers.remote]
url = "https://learn.microsoft.com/api/mcp"

[mcp_servers.disabled-local]
url = "http://127.0.0.1:6004/mcp"
enabled = false

[mcp_servers.command]
command = "pwsh.exe"
`);
  assert.deepEqual(result, [{
    name: "edt-mcp",
    url: "http://localhost:8765/mcp",
    host: "localhost",
    port: 8765,
  }]);
});

test("loopback MCP URL validation rejects remote and malformed addresses", () => {
  assert.equal(isLoopbackMcpUrl("http://127.0.0.1:6014/mcp"), true);
  assert.equal(isLoopbackMcpUrl("http://[::1]:6014/mcp"), true);
  assert.equal(isLoopbackMcpUrl("https://example.com/mcp"), false);
  assert.equal(isLoopbackMcpUrl("not a URL"), false);
});

test("MCP preflight disables unavailable endpoints without changing available ones", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-mcp-preflight-"));
  const configPath = path.join(directory, "config.toml");
  await writeFile(configPath, `
[mcp_servers.available]
url = "http://127.0.0.1:6004/mcp"
[mcp_servers.unavailable-test]
url = "http://127.0.0.1:6045/mcp"
`, "utf8");

  const result = await unavailableLocalMcpOverrides({
    configPath,
    probe: async ({ port }) => port === 6004,
  });
  assert.deepEqual(result.disabled.map((server) => server.name), ["unavailable-test"]);
  assert.deepEqual(result.args, [
    "-c",
    "mcp_servers.unavailable-test.enabled=false",
  ]);
  assert.equal(codexMcpEnabledOverride("quoted.name", false), 'mcp_servers."quoted.name".enabled=false');
});
