# ADR-HUB-467: autonomous recipient installer

The explicitly requested update authorizes forced termination of the selected
installation, including its active work. This supersedes the interactive legacy
window for the standalone recipient installer. It does not authorize stopping a
different installation or rolling back historical maintenance receipts.

The installer retains its verified script and exact request outside the runtime.
It creates a suspended worker with the interactive desktop as explicit parent,
proves that worker is outside all Jobs, then resumes it. No installed API, stdin
confirmation, manually started WMI helper or external agent is required.

Discovery identifies the selected stable RuntimeHost and absolute Hub entry
scripts under that installation. Actual effects retain native process handles,
creation identities and images. Descendants are captured before termination;
another Hub installation cuts off that branch. PID/name alone is not authority.
The installer never terminates a shared outer Job.

Only Node's executable program position establishes a root entrypoint; preload,
evaluation text and application data arguments do not. Unknown option arity is
not guessed. Descendant edges require creation order and the exact retained
native parent's birth identity, preventing integer PPID reuse from granting
authority. All supported Hub entry names share the same foreign-root cutoff.

Post-publication correction: names such as server.mjs also belong to ordinary
owned MCP children. A foreign installation requires its physical current/data/
native-Host layout plus matching manifest/native/entry bytes. A basename is not
that proof. Genuine foreign installations still refuse before parent retirement.

Explicit --resume-prestop continues only the published8c09 pre-capture foreign
refusal. The old worker must be retired, both unchanged old Host/Ready Node must
predate original admission, pointer/manifest/input must match and no backup,
retirement/install/launch boundary may exist. Together with the exact old code
and error this proves the stopping pass never reached termination; generic
effectsAdmitted or absence alone does not. The existing maintenance CAS retains
the whole prior UNKNOWN in autonomousResume, without rewriting old cache/history.
The same original proceeds under a fresh outside-Job worker and becomes terminal
only after real Ready. Repetition joins/readbacks that continuation. Remove this
bounded8c09 compatibility once those exact pre-stop originals are disposed.

The existing maintenance-operation store owns the original and its terminal
result. An external flushed request/dispatch fence is transport, not a second
restart registry. Repetition reads the same original and never repeats dispatch.
Missing historical maintenance schema is compatible absence before first
dispatch; an existing failed, skipped or UNKNOWN original remains read-only.

The verified public archive is extracted and checked with the existing complete
package verifier. After selected processes exit, the existing stopped-runtime
backup and installation owners perform their normal work. The previous manifest
and full previous release are verified before stop. Backup retains its declared
durable scope; excluded source/payload directories stay in place.

The new Host is started once. Success requires authenticated Ready, the exact
installed release, the launched Host creation identity and its actual Node child.
A joined installation/start failure attempts one restoration of verified prior
code through the existing installation owner and verifies previous Ready. Data
is not restored over newer records. A failed recovery remains UNKNOWN with its
backup and diagnostics; elapsed time never means successful recovery.

Compatibility is bounded to the existing Windows runtime/data/release layout
and the same-user interactive desktop. Arbitrary layouts and inaccessible
foreign processes do not acquire termination authority. Remove the historical
manual bootstrap from maintained callers once all recipient distributions use
the autonomous entry. Preserve versioned old packages and originals meanwhile.

The public 2.1.7 payload and its old installer remain immutable inputs. The new
standalone artifact is delivered separately; replacing a published asset or
changing packaged cooperative callers belongs to the distribution owner.
