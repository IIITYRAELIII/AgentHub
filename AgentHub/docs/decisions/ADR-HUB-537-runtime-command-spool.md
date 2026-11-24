# ADR-HUB-537 · Runtime command storage

The Codex lifecycle launcher and runtime command client resolve a common spool
under the installation's runtime data. The repository only supplies the cwd
inside the request. The runtime command server keeps its durable receipt journal
outside the writable spool, and the managed Codex workspace-write policy allows
the spool directory alongside the existing project root. The pipe name and
downstream authorization are unchanged.

The listening owner carries the previous server's journal to the new location
before draining its configured legacy spool. It uses one durable command journal
for both queues. Legacy responses and acknowledgements remain at the original
addresses for existing clients. Only the previous server's configured queue is
read, excluding abandoned directories written under unrelated working folders.
The legacy reader can be retired when the installed hooks have been refreshed
and the last old writer and pending request have been accounted for.

Git's registered-primary fingerprint keeps checking tracked and untracked
changes. On an unchanged 2.1.23 server the existing pipe can already pass a
lifecycle command without writing into the checkout. Its installed standalone
launcher still uses the old path until the hook is refreshed through the
installation owner. A passing isolated compatibility check changes neither the
installed hook configuration nor the original Await outcome.
