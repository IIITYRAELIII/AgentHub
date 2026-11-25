# ADR-HUB-517 — Serve the last cold-chat exchange first

Status pending independent review.

Opening a cold tab already separates ordered selection from local history.
The first HTTP history response still projected and compressed the ordinary
page before showing any of it. A background native job can delay the gzip
callback even after the history handler returns. The installed 2.1.23 trace
also shows a long overlapping snapshot, with no history compression or
socket records to attribute the historical gap.

Keep the addressed history owner and request its last two turns for first
paint. Return the exact full exchange and existing cursor through the same
projection and read-acknowledgement fences. If the known final exchange is
outside the tail or the response was truncated while older turns remain,
request the ordinary page under the same navigation identity. The initial
read still performs bounded durable identity recovery for the turns it
serves. Start optional provider refresh and widen the page through the
existing history scheduler after the paint opportunity; the selection and
retained-page paths keep their independent ownership.

The HTTP owner can send a first page of up to 128 KiB as identity when the
client accepts it. Larger responses, ordinary pages and trace pages keep
the existing compression behavior. Record the original trace ID across the
server and browser stages, with sizes and timing counters only. Compare the
same Windows Edge fixture on both implementations with the same synthetic
native-worker load and an actual local SQLite history. This establishes the
dependency and its removal for that fixture. It does not identify the share
of the uninstrumented historical interval or report installed performance.
