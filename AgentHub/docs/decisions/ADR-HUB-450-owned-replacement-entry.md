# ADR-HUB-450 — Admit the verified new replacement Job

Status: accepted by the explicit Host-fix request of 2026-11-15.

The independent-process creator checks the suspended child outside every
inherited Job, then assigns its fresh per-Host Job before resume. Rejecting every
Job in the resumed Host contradicts that ownership boundary and prevents Node
and Ready. Simply accepting a PID-shaped Job name or a supplied environment flag
would discard the creator's native proof.

The existing native replacement launcher now supplies its child an internal
entry address for a single local pipe created before the child. Both ends verify
kernel peer PIDs. The child pins its live issuer, verifies the same executable
and security context, original operation and membership in its exact new Job.
The issuer retains the original child/Job handles and sends its entry proof only
to that child after the existing pre-resume independence check and assignment.
Only this verified entry admits the new Job; ordinary foreign/inherited entry
still refuses. Missing or forged issuers do not create a fallback launch.

This extends entry verification within the existing owned-replacement lifetime;
it creates no durable owner, restart original, retry, standalone launch wrapper
or new execution deadline. The existing Ready/commit/abort control remains the
completion owner. Node cannot inherit the one-use entry address, which is passed
only to the native child as arguments. Existing cleanup retains the exact new
Job until commit or native zero proof, and old-cohort retirement remains separate.

Real compiled-Host tests cover the existing Ready/extra/not-ready/foreign-ready/
lost-reply cases and prove that each reached Node. Additional native fixtures
refuse inherited, foreign and matching-name forged Jobs even with a supplied
outside-Jobs flag, before Node. All processes belong to disposable private roots.
These checks do not claim a historical legacy recipient update succeeded.

Startup timing remains in the existing payload-free Host lifetime trace, bound
to the same Host PID and restart operation when present. Native gate setup and
actual mutex waits are separate observations. Pointer/manifest reads, aggregate
path validation and file hashing, the package-admission child wait, acceptance
environment preparation and Node creation expose elapsed time and outcome.
These observations neither extend a readiness deadline nor supply Ready proof;
an initial runtime reaching Ready after its observer expired remains a failure.
