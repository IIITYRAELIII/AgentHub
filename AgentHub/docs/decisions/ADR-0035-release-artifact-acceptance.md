# ADR-0035: explicit acceptance of an already-built runtime artifact

Status: accepted for the runtime-replacement scope; production data parity remains incomplete.

The rolling dev contour rebuilds and starts Node directly. It cannot establish
that the published artifact and RuntimeHost can replace a still-live process.
The new `test-contour.mjs accept-release` command consumes two already-built
Windows artifacts, verifies their manifests, and copies only listed bytes into
a fresh root. It installs the candidate's verified stable RuntimeHost, starts
the previous artifact, switches only that root's pointer and invokes its normal
`restart-server` control action. It observes simultaneous live old/new PIDs and
requires exact new release/PID agreement between instance lock and control
snapshot, plus termination of the old process.

WMI independent restart does not inherit environment overrides. A root-local,
identity-bound marker therefore makes RuntimeHost give every generation a
minimal environment and empty isolated homes. Synthetic Telegram/provider
adapters are configured persistently. No autostart is installed, production
commands/data are not copied, and candidate bytes are never watermarked or
rebuilt by acceptance. The capability marker is included in the runtime hash
manifest; candidates with old launchers fail before any process starts.

The resulting acceptance manifest describes its narrow scope and records
unimplemented/excluded scenarios. A passed lifecycle scope is not full release
acceptance: coherent production journal/runtime/command-ledger snapshots,
pending command/outbox recovery and fault injection remain required work.
This command is initially explicit and does not silently lengthen every test
or change the existing rolling contour/release preflight policy.

No compatibility fallback to direct Node launch is allowed: it would evade the
very launcher and overlap behavior this scope must exercise.
