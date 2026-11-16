// One addressed test composition; normal production module loading is untouched.
let parent, source;
export function initialize(data) { parent = data.parent; source = data.source; }
export function resolve(specifier, context, next) {
  if (context.parentURL === parent && specifier === "./agent-hub-execution.mjs") {
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
}
