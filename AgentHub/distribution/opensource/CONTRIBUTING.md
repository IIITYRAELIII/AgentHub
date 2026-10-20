# Contributing

Keep changes small and identify the owner of the behavior you change. Before
editing, read `AgentHub/AGENTS.md`, `AgentHub/docs/contracts/README.md` and the
contracts selected by `npm run contracts:affected -- <changed-paths>` from the
`AgentHub` directory. Describe an intentional contract change and its ADR.

Use the package-lock with `npm ci --ignore-scripts`. Run `npm run check` and the
affected behavioral tests; give exact commands, counts and limitations. Use
`npm test`, `npm run test:installer`, `npm run test:e2e` or the documented broader
profile when the changed behavior requires it. Do not call a subset a full run.
Keep failed attempts and explain their cause rather than relabeling them PASS.

Tests should exercise observable behavior. Do not add snapshots of production
source text, CSS formatting or implementation regexes. Use isolated synthetic
data/providers and owned temporary directories. Never replay a user's message,
upload or external side effect just to reproduce a test.

Do not submit runtime state, credentials, model caches, generated binaries,
personal paths, customer materials or real conversations. Review the entire
commit, including history and screenshots, before publication. Generated release
packages belong in release assets and must carry checksums and dependency notices.

Explain what changed, why, how it was checked and what remains unproven. An
accepted source patch is not permission to change production. The existing release
owner handles Task selection, publication, installation and rollback.

Submit only work you are entitled to license under the repository's confirmed
license. Preserve attribution and third-party notices; identify externally copied
code and its original license. Do not assume that using a dependency gives you
permission to relicense its source or branding.
