# ADR-0093: Ordinary own-only reviewed Test conflicts

Status: implementation proposed; delivery requires independent review and the
existing incoming/base approval and release workflow.

An ordinary Task can conflict with rolling dev in a shared registry even when
its own result is independently usable. Importing dev into that Task changes
ownership. The previous selected verifier accepted only the divergent published
merge case and therefore refused a reviewed ordinary conflict proof.

Classify a no-merge result separately inside the existing selected verifier:
exact Task base equals accepted local main; at most 256 single-parent own
commits; exact unique dev/Task base; regular-file own edits/additions only.
Recompute the ordered proof parents, automatic tree and complete conflict
stages. Every resolved conflict must be an own edit, all other entries must
match the automatic tree, and materialization stays within own paths.

Use the existing RM-only public preview/confirmation, durable lifecycle intent,
expected-old dev CAS, private-byte materializer and original-ID recovery.
Published-side merges retain their prior classifier and content-addressed proof
shape. No caller flag can remove those guards. This does not change base refs,
approve incoming main, settle legacy UNKNOWN or authorize installation.

Test resolution is distinct from release resolution. Persist the independently
recomputed publication merge and refuse PreRelease projection when its
non-CHANGELOG conflicts remain. Never replay the dev resolution into production
as implicit approval. No second integration or receipt owner is added.
