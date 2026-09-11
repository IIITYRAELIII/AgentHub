# Prepared projects and canonical read-model coordinates

> Design-stage record: the text below describes the earlier isolated layer.
> These layers are now integrated in HUB-182; current preparation, executed
> full-shell acceptance and remaining exclusions are documented in
> [Recording contour](recording-contour.md). Historical statements about an
> unconditional boot fence or unintegrated callers do not describe current code.

Status: bounded, unintegrated WIP. This layer follows the recording-provider,
reference-effects and mapping-wiring layers. It does not boot a Hub or claim
production parity. `CONTOUR_RECORDING_BOOT_NOT_READY` remains unconditional.

## Authority and change

The existing recording marker and `createContourCommandMapping` own typed path
equivalence and exact seeded provider/Thread/Stream bindings. The prepared
Workspace catalog has operational project paths; journal and task history keep
canonical evidence. Passing operational projects into Desktop search previously
filtered out every canonical journal record, and path-sensitive catalog joins
could not identify their Stream.

`contourReadModelOptions` projects only known project and binding fields before
the existing Desktop read composition. It supplies canonical project roots,
catalog entries, Workspace hierarchy and historical Thread bindings. Exact
provider/Thread identity and page options pass to LocalTaskSyncStore unchanged.
Cached/provider history reads receive the same canonical bindings. No returned
message content is rewritten. Unknown paths and unseeded or conflicting bindings
fail closed through the existing mapping owner. Profile-absent options retain
their original object and behavior. No new persistent store, queue or receipt is
introduced; reads never write the mapped view back to the catalog or journal.

The shell creates its existing mapping before the read composition and forwards
that exact mapping. The shell artifact was composed from published `99240e5`
plus the previous mapping-wiring hunks, preserving the published async-question
sender. `desktop-message-controller` and accepted attachment ownership fixes are
not part of this layer and were not copied or edited.

`prepareContourProjectConfiguration` prepares the explicit default project and
all projects with the same typed mapper. It removes only `CODEX_PROJECT_ROOT`
from the supplied environment copy: loadConfig otherwise treats that variable
as an authoritative single-project override and discards the prepared list.
It preserves unrelated values and arbitrary user text. It performs no writes.
This helper is tested against the actual config loader, but the installer/cohort
preparation caller still needs to invoke it when that guarded flow is completed.
The ordinary fake-contour configuration and launcher are unchanged.

## Behavioral evidence

Run from `read-model-files`:

```text
node --test --test-concurrency=1 tests/runtime/contour-read-model-wiring.test.mjs
```

The fixture creates an owned synthetic SQLite database through the real
WorkspaceCatalogStore, JournalDatabase and LocalTaskSyncStore. Two Workspaces
contain two projects, Codex with a rotated Thread, and Claude. Real catalog
preparation changes only its declared catalog references. The actual Desktop
read composition then performs canonical journal search, retained Stream joins,
and both pages of history; after closing/reopening the owners it repeats those
operations. Journal row bytes/hash, message identities and literal user text
remain equal. No production data is accessed by the tests.

With the published read composition restored, the final regression returns zero
search results instead of three. With this layer it passes. A separate loader
negative control retains the old environment override and observes only one
project; the prepared environment loads both. Supplying the recording profile
still fails with the unchanged boot fence. Unknown roots, foreign Stream and
unknown Thread are rejected; an 80,000-character annotation remains literal.

Contracts selected for these deliverable paths: SYS-001, SYS-002, RST-001.
Preserved: one identity owner, exact existing Workspace/Stream/Thread identities,
no new durable authority, read-only canonical evidence, no success inferred from
an unavailable runtime. No accepted behavior is redefined and no migration of
stored history is introduced.

## Integration boundary

The Task checkout remains at `08a87d9`; tracked source is unchanged. The runnable
WIP harness carries a pinned dependency closure from published `99240e5`, plus
the explicitly listed earlier WIP prerequisites. Those support files are not new
Task changes. `read-model.patch` contains only this layer's five deliverables;
`read-model-baseline.json` identifies each dependency and baseline hash.

Before promotion, reconcile the earlier layers against the exact then-published
source. Never overlay their complete saved controller files over current
attachment fixes or import rolling dev/Test-only work. This patch is conditional
on the earlier mapping layer being integrated; it is not directly applicable to
the old Task baseline as a standalone production fix.

Remaining within this boundary: installer/cohort config-helper invocation,
full shell/compact-snapshot/Telegram acceptance, and production-shaped coherence.
The tests exercise the real Desktop read composition, not a full shell launch.
PID/output/cleanup and external-effect guards remain outside this layer. This
evidence cannot authorize production capture, contour boot or release.
