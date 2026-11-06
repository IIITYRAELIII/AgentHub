# Independent release operator and application owner

The user requested moving release tooling into its own public versioned
repository. Moving the former CLI unchanged would capture 259 static modules,
including provider and database services. That would reproduce Hub rather than
separate its operator.

The external package uses public MCP for business commands. Hub keeps identity,
permissions, Task CAS, journals, queueing, original workers, Git custody and
publication finalization. Publication ordering, build orchestration, packaging
and GitHub effects live in the independently pinned tool, consuming those Hub
ports. No external SQL writer or orchestration ledger is introduced.

The same Hub API can be hosted by the existing coherent source-owner runtime.
Its explicit lifecycle joins the admitted exact Task promise and locally owned
addressed release work before closing stores. Joining is read/wait only: it does
not call the mutation, wake, reconcile or replay an original. The application
keeps a minimal source self-build command; that command prepares but does not
install, activate, publish or grant Task acceptance.

Tool source/version and frozen application source/version are separate identities.
The existing runner intent records the tool pin before launch. The existing
package checkpoint includes both the tool and explicit recipient input hashes.
Retries retain the original pin; a historical executor without that identity
uses its retained original consumer. Applied historical readbacks stay intact.
Tool replacement happens between joined consumers, never inside a frozen run.

The staged tool source has an explicit export manifest and retains its MIT
license. The publisher transfers it to the independent canonical repository,
then removes staging from the final Hub source. Runtime packaging excludes the
source-only operator entry points and never includes the tool package. This is
not an application install, publication, Task Done or remote repository claim.
