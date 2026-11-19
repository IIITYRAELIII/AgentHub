import assert from "node:assert/strict";

export function completionPersistenceFailure(originalCode, persistenceError) {
  return error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.code, "MCP_COMPLETION_PERSISTENCE_FAILED");
    assert.equal(error.errors.length, 2);
    assert.equal(error.cause, error.errors[0]);
    assert.equal(error.cause.code, originalCode);
    assert.equal(error.errors[1], persistenceError);
    return true;
  };
}
