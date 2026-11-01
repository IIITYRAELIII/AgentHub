# ADR-HUB-394: read framed release responses before local closure

The public 2.1.2 installer timed out reading the first HTTP status line after a
completed connection. New bounded controls execute that exact published owner,
URL, anonymous headers and Python version without invoking its CLI. Time-paired
controls observed both success and response-read failure after TLS 1.3 completed.
An independent TLS stack also stalled before headers or partway through the body
when given the same early-close header. Its earlier successful default requests
were therefore insufficient evidence for replacing Python or TLS.

The existing urllib HTTP owner unconditionally inserts `Connection: close`.
Two subsequent paired exact-owner controls changed only whether that header was
emitted: both original requests stalled, while both requests without it completed
the same stable metadata against the same peer, TLS version and HTTP protocol.
This establishes an actionable request-policy interoperability trigger. It does
not establish which server, network intermediary or TCP/TLS implementation loses
the response. Historical failures and public assets remain unchanged evidence.

Keep urllib, its default certificate-validating TLS context, proxy handling and
the existing API/asset redirect policies. A narrow HTTPSConnection subclass omits
only the inserted `Connection: close`; the existing HTTPSHandler.do_open still
owns request/response handling and local socket closure. The response context
closes the remaining stream on completion or failure. No connection is pooled or
reused. Content framing and the existing size/digest/package guards still decide
completion. A timeout or incomplete response remains failure, never verified data.

There is one transport, no automatic retry, TLS policy change, timeout increase,
new dependency, alternate launcher or receipt. Exact pre-dispatch selection,
failed bytes, original/cache identity and one-dispatch fences are unchanged.
The correction applies to future artifacts; it does not adopt or replay the
historical public update original. Only its release owner may perform a supported
continuation after a factual prerequisite change. Real public update readiness
remains separate from these read controls and local regression tests.

The maintained fixture routes only connect() to a local HTTP peer while retaining
the real urllib request/parser/redirect/closure path. The peer truncates an
early-close response and otherwise sends a complete length-framed response without
closing first. This exercises the property without a flaky network dependency.
It also checks unconditional truncation, error/budget and redirect refusal; default
certificate policy and certificate-error propagation are checked separately.
The fixture does not itself execute TLS or an installer/update process.
