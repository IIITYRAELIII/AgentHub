export async function routeCodexFinalDelivery({
  completion,
  deliverStandard,
}) {
  if (typeof deliverStandard !== "function") throw new TypeError("Codex final delivery handler is required");
  return {
    mode: "standard",
    result: await deliverStandard(),
  };
}
