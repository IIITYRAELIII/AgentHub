import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshotCollectionDelta } from "../../../src/interfaces/desktop/snapshot-collection-delta.mjs";

test("snapshot collection delta resets unknown clients and patches known versions", () => {
  const project = createSnapshotCollectionDelta({ keyOf: (item) => item.id });
  const first = project([{ id: "a", value: 1 }, { id: "b", value: 2 }]);
  assert.deepEqual(first.reset, [{ id: "a", value: 1 }, { id: "b", value: 2 }]);
  first.reset[0].value = 999;
  assert.deepEqual(project([{ id: "a", value: 1 }, { id: "b", value: 2 }], first.version), {
    baseVersion: first.version,
    version: first.version,
  });

  const next = project([{ id: "b", value: 3 }, { id: "c", value: 4 }], first.version);
  assert.equal(next.baseVersion, first.version);
  assert.deepEqual(next.upserts, [{ id: "b", value: 3 }, { id: "c", value: 4 }]);
  assert.deepEqual(next.removed, ["a"]);
  assert.deepEqual(next.order, ["b", "c"]);

  const recovered = project([{ id: "b", value: 3 }, { id: "c", value: 4 }], "unknown-version");
  assert.deepEqual(recovered.reset, [{ id: "b", value: 3 }, { id: "c", value: 4 }]);
});

test("snapshot collection delta resets clients after bounded cache eviction", () => {
  const project = createSnapshotCollectionDelta({ keyOf: (item) => item.id, cacheLimit: 2 });
  const first = project([{ id: "a", value: 1 }]);
  const second = project([{ id: "a", value: 2 }], first.version);
  project([{ id: "a", value: 3 }], second.version);

  assert.deepEqual(project([{ id: "a", value: 4 }], first.version).reset, [{ id: "a", value: 4 }]);
});

test("snapshot collection delta rejects unstable and duplicate identities", () => {
  const project = createSnapshotCollectionDelta({ keyOf: (item) => item.id });
  assert.throws(() => project([{ value: 1 }]), /stable key/u);
  assert.throws(() => project([{ id: "same" }, { id: "same" }]), /duplicate key/u);
});

test("snapshot collection delta reuses serialization for an exact source version", () => {
  let serializations = 0;
  const project = createSnapshotCollectionDelta({
    keyOf: (item) => item.id,
    serialize: (item) => {
      serializations += 1;
      return JSON.stringify(item);
    },
  });
  const item = { id: "a", value: 1 };
  const first = project([item], "", { sourceVersion: "source:1" });
  assert.equal(serializations, 1);

  item.value = 999;
  assert.deepEqual(project([item], first.version, { sourceVersion: "source:1" }), {
    baseVersion: first.version,
    version: first.version,
  });
  assert.equal(serializations, 1);

  const next = project([item], first.version, { sourceVersion: "source:2" });
  assert.equal(serializations, 2);
  assert.deepEqual(next.upserts, [{ id: "a", value: 999 }]);
});
