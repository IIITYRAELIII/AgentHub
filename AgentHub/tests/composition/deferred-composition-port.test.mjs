import assert from "node:assert/strict";
import test from "node:test";

import { createDeferredCompositionPort } from "../../src/composition/deferred-composition-port.mjs";

test("deferred composition port exposes stable callbacks before binding", () => {
  const port = createDeferredCompositionPort("test wiring", ["read", "write", "read"]);
  const read = port.api.read;

  assert.equal(port.isBound(), false);
  assert.throws(() => read("early"), /test wiring is not bound; cannot call read\(\)/);

  const implementation = {
    read: (value) => `read:${value}`,
    write: (value) => `write:${value}`,
  };
  assert.equal(port.bind(implementation), implementation);
  assert.equal(port.isBound(), true);
  assert.equal(read("ready"), "read:ready");
  assert.equal(port.api.write("ready"), "write:ready");
});

test("deferred composition port validates and binds exactly once", () => {
  const missing = createDeferredCompositionPort("missing wiring", ["run"]);
  assert.throws(() => missing.bind({}), /missing run\(\)/);
  assert.equal(missing.isBound(), false);

  const port = createDeferredCompositionPort("single wiring", ["run"]);
  port.bind({ run: () => "ok" });
  assert.throws(() => port.bind({ run: () => "again" }), /already bound/);
});
