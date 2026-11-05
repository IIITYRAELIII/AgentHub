# ADR-HUB-387: explicit continuation before package dispatch

The public recipient can receive HTTP 200 for a small canonical descriptor and
then time out in TLS body read, leaving an empty file. Bounded external and tool
controls also observed header stalls and successful transfers under the same
caller/peer/certificate settings. Both TLS 1.2 and 1.3 succeeded. The responsible
network/server/TLS component has not been established; protocol changes, timeout
increases and automatic retry loops are not justified by this evidence.

The independently reproduced product defect is deterministic: `prepare_update`
treated every existing cache as potentially dispatched and returned status only.
An explicit same-original request could never complete after an interrupted
download even when the transport subsequently worked.

Keep the existing retained-cache owner, public verification and native bootstrap.
New caches exclusively persist a `public-update-preparation-v1` receipt before
network work, binding the physical runtime, scratch and cache identities, original
ID, exact tag, optional archive checksum and executing installer digest. After
stable canonical metadata validation, exclusively persist the three canonical
asset URL/length/digest identities before reading any descriptor/archive body.
The executing installer must match that published asset. Repeating the same
command revalidates these exact identities and refuses drift; it does not repin.

Only a new-format preparation with neither request nor dispatch intent and a
fresh successful read-only canonical-row absence may continue. A per-cache OS
file lock serializes checking and preparation; a concurrent caller refuses.
Database/schema/read errors and any existing canonical original are not absence.
Each explicit continuation creates a fresh exclusive child in the SAME retained
cache. Failed bytes are retained, never resumed as verified input or overwritten.
Actual descriptor, ZIP and complete extraction checks remain mandatory. Bounded
attempt results contain only stage, allowlisted failure type and verified hashes;
no credential, signed redirect, exception text or payload enters those records.
New record reads, writes, lock and path checks use the existing Windows extended
filesystem namespace at I/O boundaries, as do their affected asset read/write
callers. Persisted identity and subprocess paths keep their ordinary spelling;
this does not resolve away descendant links or relax exclusive creation, regular
file proof, integrity, fsync or one-dispatch guards. A previously working ordinary
scratch whose new result record exceeds MAX_PATH must remain supported.

After verification and another canonical read, exclusively flush the ordinary
request and a digest-bound dispatch intent BEFORE calling `bootstrap-start` once.
Either saved fence makes all later calls readback-only, even with absent SQL or a
crash before actual spawn. Native original/CAS admission remains the final owner.
This is not atomicity between a Python read and native admission, cross-scratch
recovery, universal filesystem race protection or power-failure durability.

Historical unbound caches, old originals and public assets stay immutable. The
legacy failed public 2.1.1 request cannot be adopted by this new format. Preserve
its original ID/cache/readback; a later release/operational disposition belongs
to the release owner. Do not choose another scratch to bypass an uncertain fence.
The incoming modern/legacy handoff, manual stop, backup, installer, one launch and
ready owners are unchanged. Actual public online upgrade remains separate work.

Focused evidence exercises interrupted descriptor/archive bodies, explicit same
original continuation, exact verification, changed identity, locked SQLite,
existing UNKNOWN, lost spawn reply, concurrent requests, malformed/shared
receipt, actual junction and runtime replacement. HTTPS and the final subprocess
boundary are controlled; no provider/native/installed runtime action is claimed.
