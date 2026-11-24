# ADR-HUB-537 · Runtime command storage

The Codex lifecycle launcher and runtime command client resolve a common spool
under the installation's runtime data. The repository only supplies the cwd
inside the request. Hook installation binds its commands to the selected runtime
root. A copied launcher can therefore run from a separate Codex environment.
The runtime command server keeps the new durable receipt journal
outside the writable spool, and the managed Codex workspace-write policy allows
the spool directory alongside the existing project root. The pipe name and
downstream authorization are unchanged.

The listening owner processes commands already in the previous configured spool
through their original journal. The same journal guards effects if installation
rolls back before Ready. A request appearing in both queues uses its original
receipt. If the new queue handled it first, the listening owner retains its
exact durable state in the previous journal before replying on that queue.
An acknowledgement retires both copies after the requests are gone.
Legacy replies and acknowledgements retain the addresses existing
clients use. The previous server's configured queue excludes abandoned
directories written under unrelated working folders.
During the automatic installer rollback to 2.1.23, the installer verifies the
stopped candidate and the previous release's receipt owners. Before it changes
the release pointer or launches the old Host, it imports retained command IDs
into the previous server's journal under that journal's lock. The import keeps
started effects and terminal outcomes, including commands whose old request has
not arrived. A repeated import accepts identical records. A conflicting or
unverified journal, or one inside a Git working tree, blocks automatic restart
and leaves the command files in place for recovery.
The legacy reader can be retired when the installed hooks have been refreshed
and the last old writer and pending request have been accounted for.

Git's registered-primary fingerprint keeps checking tracked and untracked
changes. On an unchanged 2.1.23 server the existing pipe can already pass a
lifecycle command without writing into the checkout. Its installed standalone
launcher still uses the old path until the hook is refreshed through the
installation owner. A passing isolated compatibility check changes neither the
installed hook configuration nor the original Await outcome.
