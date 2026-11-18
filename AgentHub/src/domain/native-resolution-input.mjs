// Reuse the original authenticated native-review message format only for an
// explicit manual-sync compatibility input. Ordinary Task merges need no review.
export function normalizedNativeResolutionReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "requestId,text"
      || typeof value.requestId !== "string" || !value.requestId.trim() || value.requestId.length > 200
      || typeof value.text !== "string" || !value.text.trim()) throw Error("Invalid exact native review input");
  return { requestId: value.requestId, text: value.text };
}

export function nativeResolutionReviewDeclaration(value) {
  const review = normalizedNativeResolutionReview(value);
  const matches = [...review.text.matchAll(/<native-merge-review>\s*([^]*?)\s*<\/native-merge-review>/gu)];
  let declaration;
  try { declaration = matches.length === 1 && JSON.parse(matches[0][1]); } catch { /* refuse below */ }
  if (!declaration || Object.keys(declaration).sort().join(",") !== "binding,kind,verdict"
      || declaration.kind !== "native-merge-review-v1" || declaration.verdict !== "ACCEPT"
      || declaration.binding?.kind !== "manual-dev-resolution-v1") throw Error("Native merge requires an exact reviewed verdict");
  return declaration;
}
