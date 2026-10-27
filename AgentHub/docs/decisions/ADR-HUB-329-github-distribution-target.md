# GitHub distribution in the existing release owner

Status: implemented for bounded review; real standalone delivery is pending.

The offline package checkpoint and callable PREPARED adapter did not connect a
frozen release to its public assets. Manufacturing a receipt or uploading assets
manually would create a second publication path.

The existing `agent-hub-publication` target may explicitly select environment
`github-release`, as part of its original RM authorization. The normal runner
reads that exact target and generation. A CLI flag, rolling source or publisher
environment variable cannot select this profile. Ordinary targets retain their
installed-runtime behavior and identities.

The profile preserves the accepted test selection and normal frozen Git
publication. It prepares one runtime through the existing artifact owner and
passes the unchanged original-operation/generation/source/build PREPARED receipt
to the existing Python checkpoint. It does not install/activate a runtime,
restart Hub, build Android, deploy Worker or install a VS Code extension. Its
saved identity includes the profile; cross-profile resume refuses. Preparation
and packaging precede Git; Git precedes GitHub Release publication.

Only public IIITYRAELIII/AgentHub is supported. The publisher checks registered
origin, repository ID and owner ID. The stable tag resolves directly to the
frozen source. Moved tags, foreign/ambiguous releases, extra/duplicate assets or
size/digest disagreement refuse. Four assets come only from the verified
PACKAGED allowlist. Licence/notices, installer and tool hashes remain checkpoint
inputs. Bundled dependencies retain their own licences and notices; this does
not declare all dependencies MIT or grant redistribution rights.

The existing publication journal owns create/upload intents and results. A
digest marker binds the release body to the frozen input without publishing
private operation IDs or paths. Incomplete own uploads remain in a draft. Lost
successful responses are read back by the same release/asset digests, without
another version, clobber, deletion or tag rewrite. A started upload without a
matching uploaded asset remains unknown and refuses blind replay. Git publication
state alone cannot prove application of the asset target.

The same separation applies to negative readback: origin/main returning to the
Git base cannot disprove an already journaled GitHub tag/create/upload intent or
result. Original matching distribution progress is inspected before Git-only
negative fallbacks. Unreadable, missing-after-runner or incomplete original
evidence remains unknown. A pristine journal or an exact recognized pre-effect
intent with no remote actions retains ordinary not-applied classification.

Publisher credentials remain in its process, using existing gh authentication
for the fixed host. Authenticated redirects and foreign routes refuse. The
recipient installer retains anonymous exact-version discovery. Remote metadata
verification does not replace actual anonymous download, source-free fresh
install, update and rollback acceptance.

The adapter does not authorize repository cutover or rebind old Tasks, frozen
Utilities operations, receipts, manifests or installed pointers. The standalone
candidate still requires ordinary accepted source/selection and the existing
release owner. Real delivery and cutover need their own completion evidence.

Affected check:

    node --test tests/infrastructure/process/github-release-publication.test.mjs

The fixture uses the real publication journal/checkpoint and asset files, with
controlled packaging/GitHub ports. It covers profile selection, stage order,
same-original reuse, lost reply, preserved uncertainty, foreign release/tag/drift
refusal and the asset-versus-Git completion boundary. It is not a public GitHub
or native product installation test.
