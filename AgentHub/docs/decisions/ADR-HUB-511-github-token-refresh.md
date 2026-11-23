# ADR-HUB-511 — GitHub OAuth token refresh

Accepted source contract: REL-001.

GitHub invalidates the previous access and refresh tokens when it issues a new pair.
An interrupted network response therefore cannot authorize another exchange of the
same grant. The broker exchanges once, with the existing registered application's
client ID and secret. It omits the scope parameter so the granted access stays the same.

The selected connection record keeps the access secret in its existing DPAPI
field. Optional DPAPI-protected refresh and verifier fields share that record.
API, Git and gh acquire the per-connection lock only at the expired credential
boundary. Then they reread the current selection and persist the attempt before
submitting the exchange. The Git profile and its locator stay stable when the
atomic credential file advances to a new generation. Replacements and disconnect
remove the old file under the same lock.

The Worker stores the admission before contacting GitHub. The original verifier
proves possession and protects the result with AES-GCM for the existing five-minute
authorization interval. The Worker persists neither the verifier nor the pair
in plaintext. Reopening after a lost response retrieves the same sealed result.
The sealed result and admission have separate object identities in the existing
namespace. This keeps the previous Worker's whole-object alarm cleanup safe
during a rollback. After the result is purged, the admission and terminal status
stay until the original refresh grant expires. A temporary transport failure
keeps the local attempt available for readback. An authoritative unknown outcome
keeps that attempt and both credentials in storage and requires explicit sign-in.

The authorized browser poll requests refresh fields explicitly. Older clients
receive the existing access-only response. A new client still accepts a legacy
Worker response and existing access-only vault rows. These rows need a browser
sign-in once their access credential expires. Deploy the compatible Worker before
verifying refresh on the installed Hub.
