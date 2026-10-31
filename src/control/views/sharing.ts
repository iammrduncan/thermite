/**
 * What a kept fold shares with the views read from it (goal 168). A record the fold never changes
 * once made (an event, a note, a finished trial) is frozen when the fold makes it: every view
 * shares it, and code that tries to change it throws. Everything else a view gets is copied, so
 * each caller has objects of its own: what it sorts, pushes or edits changes neither the fold nor
 * another caller's view. Only `frozen` freezes what a fold holds, so a frozen object is frozen all
 * the way down.
 */

/** `x`, frozen with all it holds: a record the fold never changes again. */
export function frozen<T>(x: T): T {
  if (typeof x !== "object" || x === null || Object.isFrozen(x)) return x;
  for (const v of Object.values(x)) frozen(v);
  return Object.freeze(x);
}

/**
 * A copier for one view: what is not frozen is copied (plain objects and arrays, with their keys in
 * their order, undefined ones too), what is frozen is shared. An object met twice is copied once,
 * so the view keeps the fold's sharing: the judge's job in progress is one of its jobs.
 */
export function ownCopier(): <T>(x: T) => T {
  const copies = new Map<object, unknown>();
  const own = (x: unknown): unknown => {
    if (typeof x !== "object" || x === null || Object.isFrozen(x)) return x;
    const met = copies.get(x);
    if (met !== undefined) return met;
    if (Array.isArray(x)) {
      const a: unknown[] = [];
      copies.set(x, a);
      for (let i = 0; i < x.length; i++) a[i] = own(x[i]);
      return a;
    }
    const o: Record<string, unknown> = {};
    copies.set(x, o);
    for (const k of Object.keys(x)) {
      const v = own((x as Record<string, unknown>)[k]);
      // A rig's report may name a key `__proto__`: it stays a key, as JSON.parse made it.
      if (k === "__proto__")
        Object.defineProperty(o, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else o[k] = v;
    }
    return o;
  };
  return <T>(x: T) => own(x) as T;
}
