import { registerHooks } from "node:module";

let sequence = 0;

// Execute the unchanged phase with controlled direct dependency ports. Captured
// callbacks are real phase closures; production source is never parsed or sliced.
export async function importCompositionWithPorts(moduleUrl, modules) {
  const id = `hub345-composition-${++sequence}`;
  const target = new URL(moduleUrl);
  target.searchParams.set("fixture", id);
  const ports = new Map(Object.entries(modules).map(([specifier, exports]) => [new URL(specifier, moduleUrl).href, exports]));
  globalThis[id] = Object.fromEntries(ports);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === target.href) {
        const key = new URL(specifier, moduleUrl).href;
        if (ports.has(key)) return { url: `fixture:${id}:${encodeURIComponent(key)}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      const prefix = `fixture:${id}:`;
      if (!url.startsWith(prefix)) return next(url, context);
      const key = decodeURIComponent(url.slice(prefix.length));
      return { format: "module", shortCircuit: true, source: Object.keys(ports.get(key)).map((name) => (
        `export const ${name} = globalThis[${JSON.stringify(id)}][${JSON.stringify(key)}][${JSON.stringify(name)}];`
      )).join("\n") };
    },
  });
  try { return await import(target.href); }
  finally { hook.deregister(); delete globalThis[id]; }
}

export function boundPort() {
  let owner;
  return {
    bind(value) {
      if (owner) throw new Error("Composition port was bound twice");
      owner = value;
      return owner;
    },
    get value() {
      if (!owner) throw new Error("Composition port was used before binding");
      return owner;
    },
  };
}
