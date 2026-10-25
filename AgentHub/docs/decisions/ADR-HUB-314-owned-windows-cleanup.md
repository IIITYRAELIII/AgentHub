# ADR-HUB-314: Bounded removal of owned Windows test roots

Date: 2026-10-26
Contracts: PERF-001
Status: proposed for independent review

GEN10 and GEN12 recorded successful Node/browser commands followed by EBUSY
while removing their isolated temporary roots. Node close certifies its own
stdio lifetime; it does not certify that every native Windows handle is gone.
Historical BITS/Edge/filter ownership remains unknown and is not inferred from
a temporary filename. Existing fixture owners already await browser close.

The isolated test owner uses standard Node recursive removal with at most three
retries and a 100ms linear delay on Windows, unchanged zero retries elsewhere.
This explicitly refines cleanup policy; it never retries the test command or
waives assertions. Only the existing minted temporary root is removed. No
process/service is stopped, foreign directory adopted, error ignored, rename
used or new owner introduced. Persistent failure retains the same execution/
cleanup aggregation. An execution assertion remains the exact original error
if cleanup subsequently succeeds. Actual removal precedes successful checkpoint.

Node documents this behavior at
https://nodejs.org/api/fs.html#fspromisesrmpath-options . The former zero-retry
policy differed from existing Windows fixture teardown. This change neither
identifies the historical actor nor guarantees every external lock ends.

An initial controlled ten-retry witness preserved all four execution/cleanup
outcomes, but three persistent-lock controls consumed 201 seconds because Node
recursively retries child and parent removals. The final policy uses three
retries to limit that amplification. It does not claim a fixed whole-cleanup
deadline for arbitrary directory depth. The final addressed controls must use
the final three-retry policy; the ten-retry witness is retained separately.

A maintained Windows regression first proves an actual exclusive sharing
violation in its own root, retires that owned handle and requires actual root
removal with exactly one execution. Existing persistent-lock cases still
require failure, original assertion/OS identity, both errors and cleanup
metadata. Unclassified execution errors are never replayed.
