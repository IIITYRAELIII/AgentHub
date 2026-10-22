import { registerHooks } from "node:module";

const target = new URL("../../src/infrastructure/filesystem/native-release-merge.mjs", import.meta.url).href;
const original = `${target}?original-history-observer`;
// Isolated child instrumentation delegates every original history assertion.
// It observes completion of that await without replacing validation success.
registerHooks({ load(url, context, next) {
  if (url !== target) return next(url, context);
  return { format: "module", shortCircuit: true, source: `
    import * as actual from ${JSON.stringify(original)};
    export * from ${JSON.stringify(original)};
    export async function assertNativeTaskHistories(...args) {
      const result = await actual.assertNativeTaskHistories(...args);
      const observe = globalThis[Symbol.for("agent-hub.test.after-native-history")];
      if (typeof observe === "function") await observe();
      return result;
    }
  ` };
} });
