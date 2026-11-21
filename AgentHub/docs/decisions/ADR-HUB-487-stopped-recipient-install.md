# ADR-HUB-487. Stopped recipient installation after a Job refusal

- Status: Accepted
- Contracts: RST-001

The Windows process provider can create a worker that still belongs to a Job.
The autonomous installer must join that exact suspended worker and preserve
its original refusal. Other Windows launch providers do not establish
independence merely by creating a process.

Expose the existing stopped-only package installer via explicit `--offline`
in the current distribution entry. Hold the autonomous installer's mutex for
the physical root from stopped preflight through installation. Recheck the
selected path and physical root before passing the original root to the
stopped-only owner's guarded write. This mode never stops or starts a Hub, and its
availability never admits a second autonomous attempt.

Relevant evidence is a refusal while the selected application is live, then
installation into that same stopped root from a caller inside a Windows Job.
Verify package identity and retention of the previous release and user files.
