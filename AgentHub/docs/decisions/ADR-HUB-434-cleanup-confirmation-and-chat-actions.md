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
