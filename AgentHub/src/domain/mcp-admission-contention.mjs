// Positive evidence about one invocation's failed BEGIN only. This is neither
// an MCP receipt nor evidence about another invocation or historical effects.
export class McpAdmissionContentionError extends Error {
  constructor(identity, cause) {
    super("MCP receipt BEGIN could not acquire the SQLite writer", { cause });
    this.name = "McpAdmissionContentionError";
    this.code = "MCP_ADMISSION_CONTENTION";
    this.errcode = Number(cause?.errcode) || 5;
    this.admissionIdentity = Object.freeze({ ...identity });
  }
}
