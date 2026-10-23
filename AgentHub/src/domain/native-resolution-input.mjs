// Transport and authenticated reviews are inputs to the existing Git sequencer,
// not another candidate or approval owner.
export function normalizedNativeResolution(value) {
  const record = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
  const review = v => {
    if (!record(v, ["requestId", "text"]) || typeof v.requestId !== "string"
        || !v.requestId.trim() || v.requestId.length > 200 || typeof v.text !== "string"
        || !v.text.trim() || Buffer.byteLength(v.text) > 32 * 1024) {
      throw new TypeError("Invalid exact native review");
    }
    return { requestId: v.requestId, text: v.text };
  };
  if (record(value, ["requestId", "text"])) return review(value);
  if (!record(value, ["bundlePath", "bundleSha256", "reviews"])
      || typeof value.bundlePath !== "string" || !value.bundlePath.trim()
      || value.bundlePath.length > 2048 || !/^[a-f0-9]{64}$/u.test(value.bundleSha256)
      || !Array.isArray(value.reviews) || !value.reviews.length || value.reviews.length > 32) {
    throw new TypeError("Invalid exact native resolution bundle");
  }
  const reviews = value.reviews.map(review);
  if (new Set(reviews.map(item => item.requestId)).size !== reviews.length) {
    throw new TypeError("Duplicate native resolution review");
  }
  return { bundlePath: value.bundlePath, bundleSha256: value.bundleSha256, reviews };
}
