import { buildCodexDeveloperInstructions } from "../providers/codex/codex-settings.mjs";

export async function resolveHubDeveloperInstructions({
  provider,
  threadId,
  streamId,
  workspaceCatalogStore,
  preTurnInstructions,
  hubMcpService,
}) {
  const rules = streamId
    ? workspaceCatalogStore.developerRulesForStream?.(streamId)
    : threadId
      ? workspaceCatalogStore.developerRulesForThread?.({ provider, threadId })
      : null;
  const shared = await preTurnInstructions.snapshot();
  return buildCodexDeveloperInstructions({
    guide: shared.guide.content,
    global: shared.global.content,
    workspace: rules?.workspace?.content,
    stream: rules?.stream?.content,
    context: hubMcpService.developerContext({ provider, threadId, streamId }),
  });
}
