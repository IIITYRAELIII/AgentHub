# ADR-HUB-385 — Read-only literal transport disposition

An explicitly approved private duplicate Git pack passed the sealed transport
sink's identity, link, stream and full hash checks, but legacy handle disposition
refused its read-only attribute with native error 5. The original remains UNKNOWN;
present-day file survival does not establish NO_EFFECT or authorize a new ID.

The literal transport owner now uses the SAME existing handle disposition pattern
as the runtime-body and native-capture sinks: FileDispositionInfoEx with
DELETE/POSIX/IGNORE_READONLY flags. The handle remains open from initial identity
check through SHA-256, final identity/stream check and disposition. Ancestors stay
pinned; the target is opened no-follow with read/delete access and read sharing
only. No attribute is cleared by name, no path-based unlink is added, and there
is no weaker fallback if extended disposition refuses.

Deletion authority still comes entirely from the existing artifact owner. This
change grants no Git garbage collection, pack reachability proof, recursive
deletion or new scope. The JS bridge still joins its actual child before return
or rejection, and every native error stays an error. Historical uncertain
operations need a separate supported owner disposition and exact operational
review before any continuation; this source is not a retry authorization.

The real Windows regression creates one small real Git pack, sets read-only and
observes legacy error 5 before the fix, then exact absence after it. Wrong hash
and same-path byte-identical replacement preserve read-only bytes; named streams,
hardlinks and reparse ancestors remain refused. Existing ordinary hash, writer
and junction controls exercise the unchanged handle sealing boundary.
