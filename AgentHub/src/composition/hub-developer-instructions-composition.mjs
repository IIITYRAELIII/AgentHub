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
  const context = hubMcpService.developerContext({ provider, threadId, streamId });
  if (streamId && !String(context ?? "").trim()) {
    throw new Error("Agent Hub could not inject the current Stream MCP context");
  }
  return buildCodexDeveloperInstructions({
    guide: shared.guide.content,
    global: shared.global.content,
    workspace: rules?.workspace?.content,
    stream: rules?.stream?.content,
    context,
  });
}
