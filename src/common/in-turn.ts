/**
 * An array's methods for a function that waits (goal 267): each item's call is waited for before
 * the next item's, in the array's order, so the calls happen in the order the array's own method
 * makes them. `Promise.all` over `map` would start every item's work at once.
 */

/** `items.map(fn)`, each call waited for in turn. */
export async function mapInTurn<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => U | Promise<U>,
): Promise<U[]> {
  const out: U[] = [];
  for (const [i, item] of items.entries()) out.push(await fn(item, i));
  return out;
}

/** `items.flatMap(fn)`, each call waited for in turn. */
export async function flatMapInTurn<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => U | readonly U[] | Promise<U | readonly U[]>,
): Promise<U[]> {
  const out: U[] = [];
  for (const [i, item] of items.entries()) {
    const made = await fn(item, i);
    if (Array.isArray(made)) out.push(...(made as readonly U[]));
    else out.push(made as U);
  }
  return out;
}

/** `items.filter(fn)`, each call waited for in turn. */
export async function filterInTurn<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  for (const [i, item] of items.entries()) if (await fn(item, i)) out.push(item);
  return out;
}

/** `items.find(fn)`, each call waited for in turn; it ends at the first item found. */
export async function findInTurn<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<T | undefined> {
  for (const [i, item] of items.entries()) if (await fn(item, i)) return item;
  return undefined;
}

/** `items.some(fn)`, each call waited for in turn; it ends at the first item that passes. */
export async function someInTurn<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<boolean> {
  for (const [i, item] of items.entries()) if (await fn(item, i)) return true;
  return false;
}

/** `items.every(fn)`, each call waited for in turn; it ends at the first item that fails. */
export async function everyInTurn<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<boolean> {
  for (const [i, item] of items.entries()) if (!(await fn(item, i))) return false;
  return true;
}

/** `items.forEach(fn)`, each call waited for in turn. */
export async function eachInTurn<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<void> {
  for (const [i, item] of items.entries()) await fn(item, i);
}
