// @ts-check
import { formWith, pageText } from "../../../tests/helpers/quick-start.ts";
import { until } from "../lib/smoke-env.mjs";
import { control, rig } from "./context.mjs";

// ---------------------------------------------------------------- the dashboard and the API

/** @typedef {import("../lib/smoke-env.mjs").ControlEvent} ControlEvent */
/** An attempt's event: it names its attempt. */
/** @typedef {ControlEvent & { subject: string }} AttemptEvent */

export let cookie = "";
export let token = "";
/**
 * The owner's token, which the tester reads from .dev/secrets (Your first run, step 4).
 * @param {string} value
 */
export function setToken(value) {
  token = value;
}
/** @param {string} path */
export async function page(path) {
  const r = await fetch(`${control}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text() };
}
/**
 * @param {string} path
 * @param {URLSearchParams} body
 */
export async function send(path, body) {
  const r = await fetch(`${control}${path}`, {
    method: "POST",
    body,
    headers: { cookie },
    redirect: "manual",
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = /** @type {string} */ (set.split(";")[0]);
  return { status: r.status, location: r.headers.get("location") ?? "", text: await r.text() };
}
/**
 * Presses the button of a form on a page, with the form's own fields and what was typed in.
 * @param {string} html
 * @param {string} button
 * @param {string} [holding]
 * @param {Record<string, string>} [typedIn]
 */
export const press = (html, button, holding, typedIn = {}) => {
  const f = formWith(html, button, holding);
  return send(f.action, new URLSearchParams({ ...f.fields, ...typedIn }));
};
/**
 * The green (ok) or red (error) line a redirect carries.
 * @param {string} location
 * @param {string} [kind]
 */
export const said = (location, kind = "ok") =>
  new URL(location, control).searchParams.get(kind) ?? "";
export const words = async (/** @type {string} */ path) => pageText((await page(path)).html);
/**
 * Control's JSON answer, read loosely (`any`) by each caller, as the shared api() gives it.
 * @param {string} path
 * @returns {Promise<any>}
 */
async function api(path) {
  const r = await fetch(`${control}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
/** @returns {Promise<ControlEvent[]>} */
export async function events() {
  /** @type {ControlEvent[]} */
  const all = [];
  for (let after = 0; ; ) {
    const p = await api(`/v1/rigs/${rig}/events?after=${after}&limit=5000`);
    all.push(...p.events);
    if (p.events.length < 5000) return all;
    after = p.events.at(-1).seq;
  }
}
export const view = () => api(`/v1/rigs/${rig}/view`);
/**
 * A rig check's result once it has finished.
 * @param {string} name
 * @param {number} timeoutMs
 */
export const checkDone = (name, timeoutMs) =>
  until(
    `the ${name} check`,
    async () => {
      const c = (await view()).checks?.[name];
      return c?.finished_at ? c : undefined;
    },
    timeoutMs,
    5000,
  );
