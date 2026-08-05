const MODULE_SPECIFIER_PATTERNS = [
  /(?:import|export)\s+[^;"']*?\s+from\s*["'](\.[^"']+)["']/gu,
  /import\s*["'](\.[^"']+)["']/gu,
  /import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu,
];

export function relativeModuleSpecifiers(source) {
  const matches = [];
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      matches.push({ index: match.index, specifier: match[1] });
    }
  }
  matches.sort((left, right) => left.index - right.index);
  return [...new Set(matches.map(({ specifier }) => specifier))];
}
