# Retain Windows Task Git Job retirement across Hub exit

A Task Git guard can outlive its Hub after a ref transaction has already
committed. The guard and the current refs answer different questions. The
refs identify the Git effect and the guard keeps other operations out until
the exact process tree has retired.

The existing Windows native process helper owns a separate Job for each
guarded Git invocation. It pins the Hub process by PID and creation time.
Windows places the suspended Git root in the Job at creation, with only its
three standard handles inherited. The helper flushes and publishes the
admission record before running Git. The helper survives an individual Hub
process exit. It monitors the pinned parent handle, cancellation and timeout.
On interruption it terminates its own Job. It publishes a completion record
only after the root handle signals and Job accounting reports zero members.
Natural completion uses the same gate and records its actual exit code.

Recovery binds the two records to the guard nonce, process creation identities,
Task, operation and repository. It acquires the existing Task and repository
leases, plus the exact shared native owner lease for a shared guard. It saves
the verified receipt before removing the guard. A requested cancellation
continues through the existing cancellation owner and retains the original
argument hash, request and receipt. For Test with a native intent, read the
actual dev and result refs against that intent. Retirement never reruns Git
effects and never turns an interrupted lifecycle into a successful Test.

A historical v1 guard has no Job records. A missing or invalid v2 completion,
including when the native helper itself was lost, also cannot prove retirement.
Keep those guards. The Release Manager may use the existing exact after-guard
Windows boot witness when available. A current process list, a numeric PID,
and an independently readable Git result are insufficient individually.
