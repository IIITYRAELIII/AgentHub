# ADR-HUB-334 — Retained pre-migration semantic suffix allocation

Status: accepted for implementation, 2026-10-25.

The existing producer appended `.N` to a numeric three-part package version
before the SemVer/build migration. Actual retained release candidates therefore
contain `version: 2.0.0`, `releaseVersion: 2.0.0.1` or `2.0.0.2`, without
`versionScheme`, `publicVersion` or `buildNumber`. Strict semantic artifact
parsing correctly refuses these as new identities, but applying it to every
retained allocation prevents the first new semantic build from being selected.

Recognize this producer shape only inside the existing retained-manifest
allocator. Require a canonical ASCII stable numeric three-part version, exact
public-prefix equality, a positive canonical suffix within the Android bound,
and absence of all new metadata fields (explicit null is not absence). Calendar
manifests keep their existing interpretation. The original manifest's directory
identity/inventory and any mobile metadata byte count/SHA-256 remain checked.

Observe its suffix in the existing global maximum. Emit only the new
`<publicVersion>+build.N`, honoring the same frozen floor, installation lease,
competing-allocation refusal and immutable retry owners. No second allocator,
reservation, state migration, file deletion or old-manifest rewrite is added.
The domain artifact parser and installer/update guards remain strict; recognizing
an old allocation does not certify it as an installable modern artifact.

The reader is necessary while retained pre-migration runtime allocations exist.
It can be removed only after their ordinary retention owner has verified their
retirement and no retained input requires this interpretation. No time-based
expiry, hardcoded release ID/hash or automatic cleanup is introduced.

Behavioral checks exercise real filesystem allocation, old bytes retained,
canonical new output, other public versions, Android hash/floor and overflow,
foreign/partial/unknown metadata refusal, and actual frozen runtime preparation
followed by a competing attempt refused before copying/building. Separately,
the two retained original manifests are exercised read-only from copied audit
inputs, without opening or changing the live Test Contour.
