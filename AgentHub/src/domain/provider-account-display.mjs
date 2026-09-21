// Display-only projection of provider-owned account state; never usage attribution.
export function providerAccountDisplay(provider, value) {
  if (provider === "codex") {
    if (value?.account === null && value?.requiresOpenaiAuth === true) return { state: "signed-out" };
    const account = value?.account;
    if (!account || !["chatgpt", "apiKey", "amazonBedrock"].includes(account.type)) return { state: "unknown" };
    return publicAccountDisplay({ state: "signed-in", email: account.email, method: account.type });
  }
  if (provider === "claude") {
    if (value?.loggedIn === false) return { state: "signed-out" };
    if (value?.loggedIn !== true) return { state: "unknown" };
    return publicAccountDisplay({ state: "signed-in", email: value.email, method: value.authMethod });
  }
  return { state: "unknown" };
}

export function publicAccountDisplay(value) {
  const state = ["checking", "signed-in", "signed-out", "unknown"].includes(value?.state) ? value.state : "unknown";
  if (state !== "signed-in") return { state };
  const email = typeof value.email === "string" ? value.email.trim().slice(0, 320) : "";
  const method = ["chatgpt", "apiKey", "api_key", "claude.ai", "amazonBedrock", "bedrock", "vertex"].includes(value.method)
    ? value.method : null;
  return { state, email: email && !/[\r\n\u0000-\u001f]/u.test(email) ? email : null, method };
}
