# Exact retained insertion in native content replay

Status: proposed

## Context

Native selected-content replay can insert a complete literal method already
present in the candidate. Git's zero-context diff may align the insertion across
the repeated method header. The reported added hunk then contains the method tail
followed by its header, although the complete replay merely duplicates one intact
method. The existing literal-hunk check refuses that alignment.

## Decision

Keep the existing literal-hunk proof. If its sole addition hunk is not retained,
permit a second byte-level proof inside the same owner, limited to one pure
insertion in regular files with unchanged mode and nonbinary UTF-8 content.

The longest common suffix determines one insertion boundary. Its length is the
replay/candidate size difference. That exact contiguous block must already occur
in the candidate; inserting it at that boundary must reproduce the complete
replay bytes. Prefix and suffix equality are part of that full comparison. The
scan and comparison are linear in file size; there is no alignment search,
rotation, semantic comparison, persistent cache or new authority.

No removal or replacement receives this new proof. Existing native graph,
selected results, publication identity, automatic clean context, mode/type/binary
guards and ordered-resolution proofs retain their owners. Replay lower boundaries,
ordinary Test, virtual/multiple-base policy and lifecycle/SQL/CAS are unchanged.

## Evidence

The maintained real-Git regression uses an ambiguously aligned repeated method
header and verifies the public native content owner. Separate cases retain
refusal for unique earlier/new loss, near matches, reordered content, removals,
mode/type/binary changes and changed authority through the existing owners.
The captured full prospective composition must also pass every selected result
through that public owner. An isolated proof does not accept a candidate or
authorize publication; the normal owner still controls those effects.
