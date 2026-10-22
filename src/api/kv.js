// Storage shim: localStorage in the browser, in-memory Map under Node so the
// exact same modules can be exercised by scripts/test-e2e.mjs.
const mem = new Map();
const real = typeof localStorage !== "undefined" ? localStorage : null;

export const kv = {
  get(k) { return real ? real.getItem(k) : (mem.has(k) ? mem.get(k) : null); },
  set(k, v) { real ? real.setItem(k, v) : mem.set(k, v); },
  del(k) { real ? real.removeItem(k) : mem.delete(k); },
  clear() { real ? real.clear() : mem.clear(); },
};
