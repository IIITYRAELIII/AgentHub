# Addressed assets for a completed publication

Status — implemented for independent review.

An installed-runtime target can finish while the versioned recipient assets are
absent. Its completed authorization and publication execution retain their
original target identity. The existing release continuation accepts a separate
`assets_publication` request from the Release Manager for that completed current
generation.

The request binds the existing `agent-hub-github-release` target identity with environment
`github-release`, the existing PACKAGED input identity and raw result digest,
the original PREPARED receipt digest and the pinned external tool digest. The
existing completed-generation proof checks validation, finalization, effects and
the immutable candidate. Fresh revision/generation CAS and actor Workspace
identity apply. Amendment and dev-sync inputs remain exclusive.

The existing release-step table records this target's authorization before its
remote effects. The completed operation, selected results, previous receipts,
version and original production execution remain unchanged. The existing
publication journal has a separate execution namespace for the assets target.
Its identity includes the authorization receipt digest and complete source,
artifact and package binding. A changed input cannot replace that identity.

The existing GitHub distribution adapter consumes the same verified package
namespace and original artifact reader. Its packaging checkpoint reuses the
existing output. The source clone stays clean on main at the frozen commit and
tree. Original runner/tool identity, prepared and package metadata are reread at
publication boundaries. Full artifact and package verification keep their
existing owners. Content-free recorder spans distinguish local Git commands,
GitHub requests and declared upload payload sizes. A declared payload size is
separate from confirmed transferred bytes.

The GitHub adapter owns tag, draft, upload and final publication intents. Lost
successful responses use its digest readback. An unconfirmed upload retains its
unknown outcome and refuses replay. An applied assets receipt is returned only
after the adapter verifies the complete public target. The existing source API
returns that addressed result directly so the completed production snapshot
cannot substitute for the assets result.

The focused regression uses a real tiny Git clone, SQLite admission, public MCP
roles, the real publication journal and actual asset files. Artifact preparation,
packaging and GitHub transport ports are controlled fixture boundaries. Live
publication and anonymous recipient install/update/rollback verification belong
to the Release Manager.

Run the affected check with the existing explicit release-tool pin.

    node --test tests/infrastructure/process/published-assets-admission.test.mjs
