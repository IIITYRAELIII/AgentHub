# Build Hub independently

The application source retains its own runtime builder and public preparation
interface. Use the dependency versions pinned by `package-lock.json`; reuse an
existing matching dependency root. Node >=22.5, Python and the supported Windows
C# compiler are required for the Windows RuntimeHost body.

From the exact clean application source:

```sh
node AgentHub/build-runtime.mjs --runtime-root <owned-build-runtime> --release-id <original-body-id> --source-commit <exact-source-OID> --artifact-version <frozen-public-version+build.N>
```

This prepares an immutable body under the existing runtime installation lease.
It does not install, activate, restart, publish, change Task status or create a
release authorization. Its manifest and the runtime builder retain the source,
version, complete file inventory, native companion and dependency verification.
The external release tool's `build` command adds exact clean Git HEAD/tree checks
before and after invoking this interface.

Release ordering, package creation and publication are in the independent
`IIITYRAELIII/AgentHub-ReleaseTools` package. The publisher configures its exact
`AGENT_HUB_RELEASE_TOOLS_ROOT` and `AGENT_HUB_RELEASE_TOOLS_SHA256` pin; neither
the package nor its dependencies are copied into the application runtime. Run
`agent-hub-release identity` from that installed tool to obtain its content pin.
Keep that directory immutable until its consumers join.

For application tests that exercise publication/distribution adapters, supply
the reviewed tool source root and its exact pin. The standalone tool's tests run
in its own repository. The normal complete publication pipeline remains owned
by the release operation and consumes the whole accepted prepared candidate.
