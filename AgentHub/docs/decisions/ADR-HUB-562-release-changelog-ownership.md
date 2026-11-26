# ADR-HUB-562 — Root changelog ownership

Status: Accepted

An ordinary Task merge into dev or PreRelease keeps the root `CHANGELOG.md`
from the destination prefix. Task source commits retain their original bytes.
Git completes the merge against the original Task commit, so the exact
parents and the checks for other content and conflicts remain meaningful.

New merge captures record the decision for verification and recovery.
Historical captures keep their original graph and verification evidence.
The Release Manager's prepared entry and synchronization from the published
main use their existing paths.
