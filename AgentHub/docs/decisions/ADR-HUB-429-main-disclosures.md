# ADR-HUB-429 — Invocation-scoped main disclosures

Status: implemented; independent review and operational delivery tracked separately.

The actual gen2 preparation trace contains sixteen main-disclosure calls with
1,252,391 ms inclusive elapsed time inside a 1,491,684 ms workflow. The old owner
launched separate metadata, changed-path and two ancestry Git commands for every
commit on every review. Those timings establish repeated expensive work, not
equal historical input identities or exclusive I/O attribution.

Generation capture now owns an AsyncLocalStorage scope. It may retain one exact
input's changed-path lists per repository until that invocation exits, including
error exit. The key binds the actual primary/index/dirty identity, native clone,
published/local/origin pins, ordered revision sets and effective isolated Git
configuration. A mismatch replaces that repository's entry. Only a successful
final primary check admits lists, and returned audits receive independent arrays.

Current metadata and signature results are never reused. Batches of at most 64
explicit commit IDs reduce process creation while verifying complete unique
metadata identities and restoring the requested output order. Fresh revision
sets supply the same local/origin membership facts without per-commit ancestry
processes. Fresh fetches, baseline ancestry, primary checks, approval and CAS are
unchanged. Existing native isolation disables replacement objects.

The existing timing sink gains a bounded scalar checkpoint for exact-input
hash and metadata/path work; it carries no contents or secrets. This exposes
future equal-input reuse and cold work without another probe or global cache.
No deadline, skipped audit, persistent approval, new publication entrypoint or
extra shared-resource reservation follows. Unrelated release extraction and
the historical full-test no-output phase remain separate open work.
