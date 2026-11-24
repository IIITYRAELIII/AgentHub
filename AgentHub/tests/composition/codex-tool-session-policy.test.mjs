import assert from "node:assert/strict";
import test from "node:test";

import { agentHubCodexMcpArgs } from "../../src/composition/codex-lifecycle-composition.mjs";

test("Agent Hub launch policy disables eager Computer Use while preserving other MCP arguments", () => {
  const existing = ["-c", "mcp_servers.unavailable.enabled=false"];
  const hub = ["-c", 'mcp_servers.agent_hub.url="http://127.0.0.1:1234/mcp/token"'];

  assert.deepEqual(agentHubCodexMcpArgs(existing, hub), [
    ...existing,
    ...hub,
    "-c", "mcp_servers.cua_repl.enabled=false",
    "-c", 'plugins."computer-use".enabled=false',
    "-c", 'plugins."computer-use@openai-bundled".enabled=false',
    "-c", 'plugins."unified-computer-use".enabled=false',
  ]);
});
