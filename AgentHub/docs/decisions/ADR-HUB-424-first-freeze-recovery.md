# Recover an exact first frozen release generation

Date: 2026-11-07
Status: proposed; affected independent review required
Contracts: REL-001, MCP-001, SYS-001

The first release freeze used the ordinary system Git configuration while its
reader inherited preparation isolation. With system autocrlf=true and no local
override/attributes, metadata was materialized as CRLF and the isolated reader
rejected a structurally exact frozen checkout. The failed compose retained local
generation one, but the durable original still had generation zero and no generic
terminal continuation was permitted.

Use preparationGitInvocation for both writer and reader, retaining only the
controlled private GIT_INDEX_FILE override. The generation owner can prove and
rematerialize whole committed metadata afterimages when CRLF conversion is the
only difference. It retains refs, immutable evidence and raw notes payload.
Other content/custody/identity differences refuse. The ordinary frozen reader
remains strict.

Add a narrowly bound exception to existing continue and Store transition:
positive failed FIRST compose receipts, original authorization/input, no later
effects/generation, fresh revision, and exact retained local frozen bindings.
The Store repeats the receipt proof inside its mutation boundary. Existing
ownership, heartbeat and step persistence append attempt two for generation one.
Unknown is not failure; absence is not settlement.

The recovered generation is registered before checking current Await selection.
If it changed, existing waiting/amendment semantics select the corrected whole
set and notes for generation two. The accepted fix must itself be selected in
that next candidate. Both generations retain the frozen public/runtime version;
the ordinary runtime allocator still rejects an actual allocation collision.
The first failed receipt, first frozen generation and authorization remain
historical immutable records. No recovery is applied to a live release by tests.

Focused regressions use a real tiny Git repository/system config, strict readback,
CRLF-only recovery and changed-content refusal; real SQLite first-attempt
preservation, transactional UNKNOWN refusal and amendment; and real generation
preparation from recovered old content to a corrected next artifact with the
same version. Existing local-autocrlf/mixed-EOL assertions remain unchanged.
This does not implement the separate release performance task.
