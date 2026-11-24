# ADR-0138 — Startup health uncertainty preserves confirmed stages

A 1500 ms health delay previously erased the startup list and restored it on
the next successful response. Keep that same threshold and polling owner, but
retain confirmed stages/counts/elapsed time with an explicit stale connection
label. Do not animate cached progress as current or infer a failed stage.

Timer and recovery events coalesce while one health read (including JSON body)
is pending. Restart and disposal abort/invalidate that read; its stale callback
cannot clear another timer, paint or schedule another poll. Confirmed startup
timestamps fence older-generation responses. Online alone does not finish a
replacement wait; a newer authoritative generation or fresh canonical terminal
restart health can do so. Success additionally requires ready health; an older
terminal or pending operation cannot settle a new wait. This also covers a
restart observed before the first health sample. A replacement starts with no
inherited stage list. Entering a new replacement wait establishes its own time
boundary even after a transient loss; repeated events within that same wait do
not advance it. A terminal between the transient loss and the new replacement
is previous-operation evidence and cannot settle that replacement.
Display fallback timestamps never establish generation.

This is UI projection, not a runtime/readiness/restart owner or a correction of
server latency. Existing ready/background-failure diagnostics and explicit
recovery actions remain separate; no automatic retry/restart command is added.

Health query `clientTraceId` uses the existing read-owner correlation interface;
an older server may ignore it, so current end-to-end correlation is not assumed.
Existing client trace stages distinguish headers, JSON body, whole read and
actual projection/paint with that same ID. Only four finite startup-health
actions reuse the existing 256-event/24-hour reporter outage ring alongside
uploads; no new store or reporting loop is created. Errors retain only status
and failure category, without response bodies, URLs, stage names or secrets.
Ordinary successful steady-ready polls do not continually refill this ring;
startup/replacement observations and failures retain the bounded diagnostic.

## Current transport and working paint

The initial health observation uses the existing authenticated runtime-health
control, with the redacted public health response as fallback. The same client
trace ID correlates request, response and projection. The first working paint
is recorded separately, after authoritative readiness, the blocking overlay is
closed and an online application projection can paint. Process startup and
browser navigation durations have separate clocks. No stage labels, error
details, or other response contents are retained in this trace.
