# AgentHub Release Tools

Independent MIT-licensed operator package for `IIITYRAELIII/AgentHub`.
Node.js >=22.5 and Python >=3.10 are required. There are no npm dependencies.
The tool version is independent of the application version. The canonical public
repository name is `IIITYRAELIII/AgentHub-ReleaseTools`; repository creation and
publication belong to its publisher.

## Ownership and compatibility

`run`, `continue`, `get`, `accept` and `task-read` use the existing HTTP MCP API.
They never open Hub's SQLite database or import a Hub checkout. Hub owns actor
authorization, Task CAS, original request IDs, admission, workers, Git custody,
immutable generations, receipts and finalization. An unavailable reply remains
unknown; the client reads the original instead of submitting a replacement.
The existing public tools are required, not a newly invented approval token.

The independently pinned publication module supplies ordering, selected checks,
artifact preparation and GitHub effects to Hub's existing stateful ports. Hub's
publication journal and artifact manifests remain the only state owners. The
application retains its own runtime builder and recipient installer. No release
tool package is installed into the application's `node_modules` or runtime ZIP.

Each CLI result prints the tool name, version and SHA-256 of its exported files.
The Hub adapter requires the same explicit `AGENT_HUB_RELEASE_TOOLS_ROOT` and
`AGENT_HUB_RELEASE_TOOLS_SHA256` pin. Its existing runner intent records that pin
beside the original operation/generation/candidate before launch. The package
checkpoint binds the tool, recipient bytes and prepared receipt separately.
Changing a tool cannot change an admitted candidate or overwrite its checkpoint.

Keep the tool directory immutable until its consumers have joined. Update it
between runs. An old runner without this tool identity keeps its original
retained executor; it cannot be silently continued with this package. Existing
applied readbacks and historical receipts are not rewritten.

## Commands

```sh
node bin/release.mjs identity
node bin/release.mjs --help
node bin/release.mjs --json doctor --connection-file <private-connection.json>
node bin/release.mjs accept --connection-file <private-connection.json> --request-file <business.json>
node bin/release.mjs run --connection-file <private-connection.json> --request-file <authorized-release.json> --full-tests
node bin/release.mjs get --connection-file <private-connection.json> --request-file <operation-id.json>
node bin/release.mjs continue --connection-file <private-connection.json> --request-file <original-continuation.json>
node bin/release.mjs task-read --connection-file <private-connection.json> --request-file <original-readback.json>
```

The private connection file is `{ "url": "<existing MCP endpoint>",
"contextToken": "<the actual caller capability>" }`. Keep it outside Git and
exported artifacts. Business JSON contains only the normal public tool arguments.
It never contains `context_token`. For Task Await, use the addressed Task, original
request ID, `status: "awaiting_implementation"` and fresh revision/workflow CAS.
The acknowledgement is emitted before waiting for the original receipt. An
inactive unknown ends the client wait once its addressed local worker has joined;
neither it nor a waiting release authorizes an automatic continuation.
`--full-tests` applies only to a new `run`.

Output is newline-delimited JSON: acknowledgement `{tool, accepted}`, then
`{tool, result}`. Exact reads have only the latter record. Errors are JSON on
stderr as `{error:{name,message,requestId?}}`; a recovered original receipt is
emitted separately on stdout and never relabeled successful. Credentials are
excluded. `doctor` with no connection file reports offline/missing setup without
network access. Its endpoint probe reports available methods, not authorization
of a later business command. `originalReleaseReadback` distinguishes the new
Hub request-addressed recovery adapter from an older compatible ordinary read.
The new adapter also reports `execution.localActive` for the addressed release.
The client waits while that actual local work remains active. An older endpoint
without that field returns its current snapshot without claiming that its worker
has joined; use the Hub-side API owner below for the complete joined lifecycle.
An authoritative failed release exits 1 for `run`, `continue` and `get`, keeping
the exact acknowledgement, result and original error on stdout. A waiting or
done snapshot exits 0; the JSON state distinguishes waiting from completion.

A running Hub with these MCP methods can serve the client. Its actual installed
behavior remains authoritative; changing the client does not upgrade that Hub.
For a reviewed coherent source owner, the application also exposes
`node AgentHub/release-api.mjs --provider <provider> --thread <thread> --stream
<stream> --connection-file <new-private-file>`, with the ordinary canonical
`AGENT_HUB_CONFIG`. This is Hub-side code, not an internal runtime imported by
the tool. That owner joins its admitted addressed workers before closing stores.
The release owner chooses its actual application boundary and original IDs.

## Build and package

```sh
node bin/release.mjs build --candidate <clean-owned-candidate> --commit <exact-OID> --runtime-root <owned-output-runtime> --release-id <original-id> --artifact-version <frozen-version>
node bin/release.mjs package --prepared-receipt <owner-PREPARED.json> --receipt-sha256 <SHA256> --source-commit <exact-OID> --version <frozen-version> --license <LICENSE> --notices <THIRD_PARTY_NOTICES.md> --recipient-root <candidate/AgentHub/distribution> --output-root <owned-output>
```

Build calls the pinned application's public `build-runtime.mjs` self-build
interface. It does not install, activate or publish the resulting body. Package
uses the same immutable PREPARED receipt and verifies every runtime byte. The
public recipient files are explicit candidate inputs, read as data rather than
imported as an internal Hub runtime. Exact successful package repetition reuses
its saved assets; incomplete, altered or foreign output is preserved and refused.
Publisher credentials never enter the package. Actual publication still requires
the Hub release owner's original authorization and complete selected candidate.

## Tests and export

```sh
node --test tests/*.test.mjs
python -B -m unittest discover -s tests -p 'test_*.py' -v
```

The Hub repository keeps the HTTP/SQLite and application-adapter integration
tests. Set the explicit tool root and `identity` digest when running those tests.
`export-manifest.json` lists the complete standalone package source, tests and
license in `repositoryFiles` for the publisher; `files` pins runtime tool content.
Export that directory only; no Hub repository,
history, dependencies, private WIP, credentials or runtime state belongs here.
The staging directory in the managed Task is review input, not final public Hub
repository membership. Its removal follows verified transfer to the independent
repository; old commit/operation identities remain historical.

After publisher verification, `npm install --global <reviewed-tool-directory>`
installs the declared `agent-hub-release` command. The package has no dependency
installation or build step. It can also run by absolute `node .../bin/release.mjs`
from any working directory. Remote publication is a separate publisher action.
