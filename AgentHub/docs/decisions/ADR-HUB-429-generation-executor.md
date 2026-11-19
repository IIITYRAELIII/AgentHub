# ADR-HUB-429-generation-executor — Scope executor recovery to its generation

An actual generation-two publisher failed before runner launch because the
publication adapter selected the last recovery globally. That valid record
belonged to generation one and pinned its old candidate/tool. It is retained
history, not authority for the amended generation.

Select the last record for the exact publishing generation before applying the
existing candidate/authorization/digest/target/tool/namespace checks. Without
that generation's recovery, normal recorded-runner or explicit pinned executor
selection remains unchanged. New generations cannot borrow old executor pins;
current-generation authority failures cannot be hidden by trailing old history.

The installed old implementation left a definite first-target NOT_APPLIED
failure. Its exact historical-generation mismatch can use the existing
not-applied recovery owner, retaining the failed original and immutable candidate.
Admission still requires a valid historical record, no current recovery, exact
canonical failed boundary, frozen selection/notes and physical all-target absence.
No generic terminal resume, new composition/version or history rewrite follows.

Focused behavior covers old recovery plus amended generation and normal tool
selection, current-record/forged/changed-tool failures, and fresh absence before
the same-generation recovery. External tool/child/public ports are controlled;
tiny Git, real filesystem namespace and installation custody remain exercised.
