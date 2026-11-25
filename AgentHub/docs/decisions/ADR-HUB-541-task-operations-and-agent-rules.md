# Separate Task operation evidence from agent workflow rules

[HUB-541](agent-hub://task/9dee9d19-5cae-49f8-9b0c-cfe7e9f7955c)

Agent rules continue to govern release, review and delegation decisions. The
Hub authenticates each call and records the actual actor and target.

| Surface | Checks kept by the Hub |
| --- | --- |
| MCP reconciliation and CLI | Look up the original by request ID. Match the durable Task, arguments, CAS and effect evidence. Use the original owner and locks. If evidence is insufficient, report UNKNOWN without replay. |
| Operation readback and cancellation | Read the addressed receipt. Record the actual cancellation actor separately. Exact target, CAS, cancellation fence, process retirement and active execution remain enforced. |
| Start, reassign and inter-Stream delivery | An explicit command conveys the selected action. Existing admission, target resolution, current-run identity and provider receipt determine the result. |
| Release membership, adoption, squash and manual delivery | Verify membership, ownership of stored artifacts, exact published or delivered data, preview proof and lifecycle CAS. Roles remain metadata for the agent's rules. |
| Complete and Delete, including Desktop | The selected action and exact preview token bind any irreversible effect. Archive and Delete are distinct. A legacy confirmation field remains accepted. Abandoned-service evidence identifies the original release actor. |
| Review and custody | The existing review receipt must match the exact bytes and integration context. Custody checks its durable plan, original lease or isolation proof, reserved successor arguments and actual current claimant. |

Database-only outcomes and already committed effects settle the original
receipt through its existing SQLite CAS. Pending Git effects still use the
original Task and repository recovery owners.
