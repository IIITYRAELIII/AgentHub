# ADR-0121: Already agreed origin with installed local source

The installed local source may contain the exact already accepted local main,
while durable OWN publication still names an older commit. Origin can equal
that agreed main without introducing a new incoming commit. The previous
no-adoption verifier required origin to equal OWN publication, preventing the
ordinary Test from retaining the installed repairs in this topology. Creating
an upstream-adoption receipt for local main would misrepresent the identity:
the existing adoption writer and reader deliberately reject that equality.

Use the existing installed-local-source-v1 envelope and its existing optional
approvedOriginMainCommit/adoptions fields. A genuinely empty array is allowed
only when the approved origin equals agreedMainCommit. The existing verifier
requires current primary main and origin to equal that bound identity, OWN
publication to be its ancestor, and agreed main to be an ancestor of retained
installed source. Exact source/tree/patch, current installed manifest and
physical runtime, selection and inherited repository file proofs still apply.
The empty receipt set is checked against actual selected adoption records.
Missing origin fields retain the original OWN-publication pin; nonempty
adoption records retain their original strict verification. Non-array values
and a foreign origin with empty receipts refuse. No receipt is invented.

Derivation seals this mode only after observing origin equal to current agreed
main. An existing envelope cannot switch its pin to publication or a newer
origin. Primary Git owns the current origin/ref observation, including when
candidate materialization uses a standalone clone. The origin is checked again
after physical-source verification and by the existing candidate validation
and lifecycle authority closure immediately before Task CAS. Test recovery,
candidate reuse, promotion and final persistence retain their original owners.

Ordinary Await derives installed proof when main differs from publication even
without new adoption records. If no installed runtime exists, the ordinary
no-adoption route returns no migration envelope; a selected adoption still
requires its installed proof. Explicit reviewed-main, preparation envelopes
and frozen generations keep their existing rules. No public flag, writer,
receipt family, Task transition or publication operation is added.

Real Git/SQLite regressions cover Test integration, ordinary Await success and
terminal drift refusal, unchanged Task CAS on failure, terminal readback,
candidate reuse/promotion and primary preservation. Negative checks retain
missing ancestry, changed origin, substituted authority and malformed fields.
This migration is unnecessary once normal publication/main synchronization
contains the installed source. It authorizes no future origin or product set.
