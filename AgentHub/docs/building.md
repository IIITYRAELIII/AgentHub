# Build through the external product recipe

The independently versioned Agent Hub release recipe owns the source collector,
native compiler, locked dependency preparation, runtime manifest and package
builder. The application retains its maintenance API and immutable installation
owner. Use the exact reviewed source and tool pins; reuse a matching dependency
root. Node >=22.5, Python and the supported Windows C# compiler are required.

From the independent tool directory:

```sh
node bin/release.mjs identity
node bin/release.mjs build --candidate <clean-repository> --commit <exact-OID> --runtime-root <owned-build-output> --release-id <original-body-id> --artifact-version <frozen-public-version+build.N>
```

The builder reads application source as data. It compiles the native bodies and
verifies source, version, every runtime byte and required companions. It compares
the candidate's clean HEAD/tree before and after the build. It does not import
the candidate's build implementation or call its development wrapper.

`build-runtime.mjs`, the Worker launchers, `release-version.mjs` and the Android
launcher remain thin development aliases for the verified external recipe. Set
`AGENT_HUB_RELEASE_TOOLS_ROOT` and `AGENT_HUB_RELEASE_TOOLS_SHA256` to its exact
immutable export. Building does not install, activate, restart, publish, change
Task status or authorize a release. Tool updates wait for joined consumers.

Hub supplies the generic recipe API and frozen Git custody. The running
application's `runtime-maintenance.mjs` JSON API owns status, installation,
configuration validation and maintenance readback. The recipe owns product
selection, orchestration and Ready verification through that API. No private
Hub build/install callbacks cross the platform's composition boundary.

The external tool's tests, recipient and extension checks live with that tool
and are included in its digest. Supply `AGENT_HUB_RECIPE_TEST_SOURCE` as an
explicit controlled application source stand. Hub keeps canonical SQL/Git and
cross-boundary application tests. Historical tools, frozen candidates, failed
checks and UNKNOWN originals retain their original authority and outcomes.
