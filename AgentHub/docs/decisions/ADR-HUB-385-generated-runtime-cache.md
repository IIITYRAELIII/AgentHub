# HUB-385: prove historical Whisper bytecode before runtime retirement

## Cause and boundary

Voice transcription imported the shipped `whisper_runtime.py` and Python wrote
an undeclared cache inside immutable runtime bodies. The existing sealed owner
correctly refused those bodies, leaving their same maintenance originals
UNKNOWN and consuming retention slots. Filename or timestamp alone cannot prove
that the extra bytes are disposable. A manual purge or manifest amendment would
lose custody rather than repair it.

## Decision

Use the existing runtime-retention owner and original pointer admission. When a
single undeclared Whisper cache exists, the configured existing interpreter runs
isolated standard-library compile-only code (`-I -S -B`). It must reproduce the
complete bytecode, including header and embedded source filename, from the exact
manifest-hashed source. Source and cache identities/content must remain stable
across this probe. The returned in-process proof is branded to the original
root/manifest binding. No imported source, new durable state or replacement
maintenance identity is involved.

The existing native sink retains its whole metadata/foreign-data preflight.
It accepts only that exact additional cache identity/hash and retires it first,
holding a hash-verified source handle until its deletion completes. Cache counts
against the existing 64-file/256-MiB/cooperative ten-second deletion limits.
A lost reply therefore leaves either the cache untouched or a normal admitted
partial runtime with no cache. The next attempt uses the same original without
a persistent exception or a second cleanup ledger.

Changed/foreign cache, unavailable/mismatched Python, missing/mutated source,
links, streams, reparse paths or additional WIP remain UNKNOWN with data kept.
New transcription uses Python `-B`; packaging and old manifests are unchanged.
This historical allowance can be removed after no retired runtime contains the
undeclared Whisper cache. It grants no cleanup of arbitrary Python caches or
dependencies and no adoption of unknown runtime bodies.

## Evidence

An actual Git-independent Windows/SQLite/native owner regression starts RED on
the undeclared cache, then checks cache-first bounded partial progress, SAME
original completion/lost reply, late source drift, foreign bytecode/useful WIP,
missing configured compiler and forged proof refusal. Existing ordinary native
batches and foreign-data controls remain required. The transcriber test observes
the actual process argv without invoking a model or provider.
