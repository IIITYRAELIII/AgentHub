# ADR-HUB-374: Content-proven targeted test retry

Status: accepted for the user-directed correction; delivery remains the normal Task lifecycle.

## Cause and decision

The observed G5 runner made 742 file decisions: 649 lacked sufficient input proof,
93 had a different input fingerprint and none reused success. Checkpoint v2 already
allows reuse across release identities. Historical digest-only evidence does not
identify which input changed in those 93 cases. Lack of an audited IO declaration
is not evidence of unchanged inputs. We do not mark those 649 files cacheable.

Use the existing typed exact selection, checkpoint and isolation owners. The
read-only `test-suite.mjs --plan-retry=<selection JSON>` classifies the selected
inventory as failed, affected, unknown, unproven or reusable. Failed, unknown and
unproven IDs remain proposed reruns. Reuse requires the same current fingerprint,
an unexpired successful checkpoint and no retained failure. A subset run preserves
failures outside its subset; success clears only that file's failure. Restart or
a lost reply after durable checkpoint commit reuses the recorded success. A crash
before durable commit remains unproven; this is not an exactly-once child launcher.

The actual isolated child environment and its fingerprint share one normalization:
profile overrides are included, publication capabilities removed, and overwritten
home/state/temp roots represented by a stable per-child ownership token in proof.
Windows keys use the same case-insensitive map in execution and proof. Real OS
identity (`USERPROFILE`), all other environment values, toolchain, runner/policy,
locks, transitive modules, declared assets and browser binary remain bound. Raw
package capture text cannot enter cache miss diagnostics. The conservative import
scanner is not a complete JavaScript analyzer; dynamic/unknown refusals remain.

## Application and limits

The plan writes no checkpoint, starts no dependencies/test child/accounting and
does not amend a release. It is a proposal for the existing exact selection owner,
not a frozen proof or authority to skip a subsequently changed input. Execution
recomputes reuse at its normal boundary. Manual selection reports omitted IDs as
not-selected, never PASS. An RM may use a reviewed exact include list only through
ordinary same-original continue after terminal/idle/not-applied readback and its
revision/generation CAS. Preserve the original scope, including publication checks;
do not silently add profiles or remove unresolved coverage. No active G5 mutation,
stop, new publisher, timeout increase, extra cache writer or declaration waiver.

Changing this input policy invalidates affected old fingerprints once. No old G5
hash is upgraded into new-policy proof. This does not promise all old tests can be
skipped: unresolved IO needs an actual audited input contract or an explicit,
truthful selection decision. No production speedup is inferred from fixture counts.
