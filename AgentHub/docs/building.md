# Independent build and package primitives

Release orchestration was removed by ADR-HUB-463. Building does not require a
ReleaseOperation, generation/freeze, PREPARED.json or Hub release API. It does
not install, activate, restart, publish, push or change Task status.

The explicitly pinned external package supplies `src/build.mjs`
(`buildPinnedCandidate`) → `src/runtime-build.mjs` (`prepareRuntime`) →
`python/build_package.py`. The first entry checks a clean exact repository
HEAD/tree before and after building. The runtime builder owns source collection,
locked production dependencies, C# compilation and the byte/companion manifest.
No dev/operational aggregate or unaccepted Task source is substituted.

The application development primitive is:

```powershell
node build-runtime.mjs --runtime-root <build-output> --release-id <body-id> --source-commit <exact-OID> --artifact-version <version+build.N>
```

It delegates directly to the independent runtime builder. The delivery owner
must pin/check the source repository and tool before using this primitive;
`buildPinnedCandidate` provides the existing repository check around it. Set the
existing `AGENT_HUB_RELEASE_TOOLS_ROOT` and `AGENT_HUB_RELEASE_TOOLS_SHA256`
variables to the accepted immutable tool export. Their legacy names are package
location/digest compatibility, not an enabled release recipe.

Build requirements: Node >=22.5 with SQLite, Git, npm and the production lock,
Python >=3.10, and the supported Windows .NET 4 C# compiler/System.Drawing for
RuntimeHost/icon. Reuse only an exact matching dependency root. Dependencies,
build outputs and local configuration stay outside tracked source.

The application retains its JSON `runtime-maintenance.mjs` boundary: status,
verify, install, package-install, config-validate and maintenance-read. The
independent recipient installer uses those installation owners. See
[distribution/README.md](../distribution/README.md). Worker asset/deploy/verify
commands remain independent tools; they do not start a Hub release operation.
