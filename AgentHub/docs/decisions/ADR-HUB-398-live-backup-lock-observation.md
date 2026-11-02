# ADR-HUB-398: live backup support and owned lock directories

The retained public update failed before stopping: live support enumeration
listed a native lock ready directory, then lstat observed its absence. The
historical removal schedule is not recorded. The deterministic regression
joins actual native publication/release between those same production I/O
boundaries, without changing durable data or retrying an update.

Live preflight uses the existing interprocess lock producer's call-scoped
read-only observation. Exact locally created directory identity, and an already
admitted publication/removal's confirmed outcome, distinguish its ephemeral
paths. Names, UUID appearance, ages and foreign owner files are not authority.
An absent observed entry joins only that already-running producer outcome;
unknown effect, replacement, durable-file disappearance and unowned lookalikes
still refuse. The observer performs no mutation, lock acquisition, retry,
timer, cleanup or durable bookkeeping. Records live only while their actual
producer or an inspection holds them. Other-process lock churn is not inferred.

All live intake/pre-stop callers use this support entry point. It does not
grant snapshot/stop authority. The stopped inventory, identity equality,
custody/reparse/config/SQLite checks and exclusive output/copy/hash/integrity
work remain strict and fresh after original retirement.

## Historical terminal original

The existing failed maintenance original is terminal. Neither an unchanged
restart-package request nor its retained bootstrap can resume it. Both return
the saved result; the domain transition rejects terminal regression. Runtime
adoption alone cannot recapture the old original's binding, and a failed row
with an ENOENT message does not prove native admission never happened.

A product continuation would require an explicit existing-owner transition
that preserves the prior terminal attempt and binding, accepts the same business
identity, revalidates fresh roots/current/instance/public files, and admits an
addressed next attempt with a CAS and no unresolved native/launch effect. The
current row model has no such attempt transition or authenticated input. This
change does not invent one, reset terminal state, replace a binding, create a
second update ID or grant installer/Host execution. That representational
boundary is reported to the RM separately from the corrected live scan.
