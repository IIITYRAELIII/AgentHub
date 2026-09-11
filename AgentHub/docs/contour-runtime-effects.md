# Recording contour runtime effects

The recording profile applies operational file guards at the existing cleanup
owners: runtime restoration, deferred inputs, composer transfers, forwarded
bundles, provider completion and launch failure. Canonical attachment paths are
mapped to the profile's attachment copies at the effect boundary. Already-owned
recording/data files are accepted after ancestor-link checks. Unknown mappings
fail closed; cleanup never falls back to the original path. Missing copies are
an idempotent cleanup result. Commands, input text, annotations, fingerprints,
queue identity and persisted historical paths are not rewritten by cleanup.

Claude runs started in the contour retain `contourProcessRoot` in the existing
runtime run snapshot. Reattachment and cancellation additionally require the
normal exact process fingerprint; provenance does not replace that check.
Output paths must belong to the exact turn under the contour data directory.
Captured production PID/fingerprint/output fields do not grant authority to
read, attach or stop. They remain evidence. Recovery records
`contourRecoveryExclusion=captured-process-and-output-not-owned` before invoking
the existing interrupted-run recovery owner, without replaying the provider or
inventing a completed response. Production Claude stdout/stderr are not part of
the current prepared cohort, so this is an explicit recovery-parity limitation.

Interactive and final-delivery Git diff refreshes are excluded through the
verified contour effect policy. Returning `null` retains the available previous
diff; it does not claim that the source repository has no changes. A captured
Git baseline is historical evidence, never an executable repository target.

The verified policy also denies every executable public Task Git and Release
Git operation, including preview/read methods that inspect stored repository
references. These owners throw `CONTOUR_EXTERNAL_EFFECT_EXCLUDED` before Git,
filesystem locks, dependency preparation or caller callbacks. The Task and
Await lock entrypoints reject before lifecycle CAS; copied branch/ref paths
never become authority to delete or update the original repository. Historical
Git references remain unchanged. This is explicit unavailable release behavior,
not a successful cleanup, empty diff or prepared candidate. The restriction
remains until a separate owned Git cohort and operation authority exist.

Relevant contracts: RST-001, TURN-001, MSG-001 and REL-001. Focused behavioral
coverage is in `tests/runtime/contour-runtime-effects.test.mjs`, including a real
owned child, restored queue cleanup, foreign PID/output paths, junctions and
provider-owned attachment cleanup. This boundary alone does not authorize boot:
the prepared-cohort, background-media and delivery guards remain mandatory.
