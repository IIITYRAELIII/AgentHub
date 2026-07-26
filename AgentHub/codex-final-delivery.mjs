export async function routeCodexFinalDelivery({
  completion,
  deliverRegistered,
  deliverStandard,
}) {
  if (typeof deliverRegistered !== "function" || typeof deliverStandard !== "function") {
    throw new TypeError("Both Codex final delivery handlers are required");
  }
  if (completion?.message) {
    return {
      mode: "registered",
      result: await deliverRegistered(completion),
    };
  }
  return {
    mode: "standard",
    result: await deliverStandard(),
  };
}
