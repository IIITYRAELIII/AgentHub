import { createHash } from "node:crypto";

// The one MCP receipt argument identity. Admission stores it; release
// recovery recomputes it from exact original arguments. Keys are sorted
// recursively and context_token is never part of the identity.
export function canonicalMcpValue(value) {
  if (Array.isArray(value)) return value.map(canonicalMcpValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalMcpValue(value[key])]));
}

export function mcpArgumentsHash(args) {
  const value = { ...args };
  delete value.context_token;
  return createHash("sha256").update(JSON.stringify(canonicalMcpValue(value)), "utf8").digest("hex");
}
