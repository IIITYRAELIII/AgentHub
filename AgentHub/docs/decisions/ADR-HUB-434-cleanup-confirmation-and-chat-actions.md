# Durable cleanup confirmation and retired chat actions

The successful cleanup preview is continuation authority. Generic 64-KiB receipt
compaction discarded its token when the Task description was large. The first
read after a pending ACK was already unusable. A later missing-token confirmation
then became UNKNOWN despite refusing before lifecycle admission.

The existing receipt owner retains a bounded confirmation capsule: action,
token, exact Task identity/revision and complete-preview digest/length. The full
preview is retained when it fits; otherwise omission is explicit. Editorial Task
text is excluded first. Confirmation still recomputes and compares the complete
current plan under the original Task owner; a capsule does not waive any cleanup
or publication guard. Incomplete preview bodies cannot serve as full forward
Delete-preservation evidence.

For protocol-v1 ordinary complete/delete previews whose successful historical
receipt was already compacted, the exact same original invocation may obtain a
fresh current preview. Existing caller/tool/arguments authority, Task lease,
lifecycle absence and revision/receipt CAS apply. The prior compacted receipt and
its timestamps remain recorded in the recovery capsule; the original completion
timestamp is unchanged. This is not a reconstruction of lost historical bytes.
Ordinary original reads remain read-only. Remove this compatibility branch once
the addressed old compacted preview receipts have migrated.

This read-only migration also covers the exact ordinary absorbed-preview family.
Its capsule retains survivor identity/revision even when the complete plan is
omitted. Recovery delegates to the existing combined-closure owner, acquiring
Workspace Await and both Task/repository leases once and retaining them through
the receipt CAS. It repeats full composition/Git proof, both Task revisions and
original lifecycle absence. It neither reconstructs a historical token nor
closes a Task. Other special modes and historical UNKNOWN absorbed confirmations
remain excluded. A fresh owning stale combined token is typed pre-admission
validation; a later valid confirmation still uses the full current plan.

A typed owning token mismatch before cleanup admission is terminal failed
validation. Text or a downstream lookalike code is not such proof. The exact
protocol-v1 ordinary UNKNOWN confirmation whose immutable original arguments
omitted the token may re-enter only this validation boundary, using the same
original caller/hash. Under the Task lease it proves lifecycle admission/outcome
absence and repeats original/Task checks in the receipt transaction. It preserves
the previous UNKNOWN result/error/timestamps and execution binding. It performs
no cleanup, creates no lifecycle transition and grants no general NO_EFFECT or
effect replay authority. Admitted, special-mode, changed, foreign and unproven
originals remain refused. A later lawful confirmation is a separate user-intent
command only after that old refusal is terminal.

The same user-requested result removes the redundant Task-attached success toast
and retires new Spark selection, Task retry routing, automatic Spark triage and
provider dispatch. Configured non-Spark classification and ordinary available
model actions retain their owners. Existing Spark preferences, Task records,
messages, accounting and statistics are historical data and remain untouched.
No replacement control, model substitution or second workflow is introduced.
Static and state composition retain an explicitly configured retired default,
including a Spark-only catalog. Filtering new choices cannot seed a different
default or fabricate an available choice. The retained unavailable ID reaches
the existing provider refusal; only an explicit user selection changes it.
