export function preparationEnvelope(projectRoot = "/test/repository") {
  return {
    schemaVersion: 1, planRevision: "plan-1", publicationHash: "a".repeat(64),
    sourceCommit: "b".repeat(40), sourceTree: "c".repeat(40), sourceClosureHash: "d".repeat(64),
    tasks: [{ taskId: "task-current", rowRevision: 1, taskRevision: 7,
      baseCommit: "f".repeat(40), resultCommit: "e".repeat(40), projectRoot }],
    repositories: [{ projectRoot, approvedBaseCommit: "f".repeat(40), publishedRevision: "f".repeat(40),
      primaryMainCommit: "1".repeat(40), originMainCommit: "2".repeat(40),
      checkpointHash: "3".repeat(64), manifestHash: "4".repeat(64),
      preReleaseHead: "5".repeat(40), tree: "6".repeat(40), approvedTree: "7".repeat(40) }],
  };
}
