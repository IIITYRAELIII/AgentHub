export function createDeferredCompositionPort(name, methodNames) {
  const portName = String(name || "composition port");
  const methods = [...new Set(methodNames.map((method) => String(method || "").trim()))]
    .filter(Boolean);
  let implementation = null;

  const api = Object.fromEntries(methods.map((method) => [method, (...args) => {
    if (!implementation) {
      throw new Error(`${portName} is not bound; cannot call ${method}()`);
    }
    return implementation[method](...args);
  }]));

  return {
    api: Object.freeze(api),
    bind(value) {
      if (implementation) throw new Error(`${portName} is already bound`);
      if (!value || typeof value !== "object") {
        throw new TypeError(`${portName} implementation must be an object`);
      }
      for (const method of methods) {
        if (typeof value[method] !== "function") {
          throw new TypeError(`${portName} implementation is missing ${method}()`);
        }
      }
      implementation = value;
      return implementation;
    },
    isBound() {
      return implementation !== null;
    },
  };
}
