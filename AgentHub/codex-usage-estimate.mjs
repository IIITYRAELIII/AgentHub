export const IMAGE_GENERATION_ESTIMATE_UNITS = 720_000;

const IMAGE_GENERATION_PROMPT_PATTERNS = [
  /\bimagegen\b/iu,
  /(?:^|[^\p{L}])(?:нарисуй|сгенерируй)(?=$|[^\p{L}])[\s\S]{0,240}(?:изображени\w*|картин\w*|иллюстраци\w*|аватар\w*|фон\w*|обложк\w*|логотип\w*|арт\w*)/iu,
  /(?:изображени\w*|картин\w*|иллюстраци\w*|аватар\w*|фон\w*|обложк\w*|логотип\w*|арт\w*)[\s\S]{0,240}(?:^|[^\p{L}])(?:нарисуй|сгенерируй)(?=$|[^\p{L}])/iu,
  /\b(?:draw|generate)\b[\s\S]{0,240}\b(?:image|picture|illustration|avatar|background|cover|logo|artwork)\b/iu,
  /\b(?:image|picture|illustration|avatar|background|cover|logo|artwork)\b[\s\S]{0,240}\b(?:draw|generate)\b/iu,
];

export function looksLikeImageGenerationPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  return Boolean(text) && IMAGE_GENERATION_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

export function estimateMissingCodexUsage({
  status,
  usageReported,
  prompt,
  imageGenerationCount,
} = {}) {
  const exactCount = Math.max(0, Math.floor(Number(imageGenerationCount) || 0));
  const count = exactCount || (
    String(status ?? "") === "completed"
      && usageReported !== true
      && looksLikeImageGenerationPrompt(prompt)
      ? 1
      : 0
  );
  if (!count) return null;
  return {
    estimatedUnits: IMAGE_GENERATION_ESTIMATE_UNITS * count,
    estimateKind: "imagegen-default",
  };
}
