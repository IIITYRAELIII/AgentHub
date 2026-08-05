import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROVIDER_REQUIRED_OPERATIONS,
  AgentProviderRegistry,
} from "./src/providers/agent-provider-registry.mjs";

function adapter(id, calls = []) {
  return Object.fromEntries([
    ["id", id],
    ["name", id.toUpperCase()],
    ...AGENT_PROVIDER_REQUIRED_OPERATIONS.map((operation) => [operation, (...args) => {
      calls.push({ id, operation, args });
      return `${id}:${operation}`;
    }]),
  ]);
}

test("provider registry validates one complete adapter per provider", () => {
  assert.throws(() => new AgentProviderRegistry([{}]), /provider id is required/u);
  assert.throws(() => new AgentProviderRegistry([{ id: "codex" }]), /codex\.discoverTasks is required/u);
  const registry = new AgentProviderRegistry([adapter("codex")]);
  assert.deepEqual(registry.ids(), ["codex"]);
  assert.throws(() => registry.register(adapter("codex")), /already registered/u);
  assert.throws(() => registry.get("claude"), /unknown agent provider/u);
});

test("provider operations dispatch through the registered adapter", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([adapter("codex", calls), adapter("claude", calls)]);
  assert.equal(await registry.call("claude", "launchTurn", { id: "run" }), "claude:launchTurn");
  assert.deepEqual(calls, [{
    id: "claude",
    operation: "launchTurn",
    args: [{ id: "run" }],
  }]);
});

test("catalog sources preserve provider order and use the same adapters", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry([adapter("codex", calls), adapter("claude", calls)]);
  const sources = registry.catalogSources();
  assert.deepEqual(sources.map((source) => source.name), ["CODEX", "CLAUDE"]);
  assert.equal(await sources[0].discover(), "codex:discoverTasks");
  assert.equal(await sources[1].toEntries([1]), "claude:projectTasks");
  assert.deepEqual(calls.map(({ id, operation }) => `${id}:${operation}`), [
    "codex:discoverTasks",
    "claude:projectTasks",
  ]);
});
