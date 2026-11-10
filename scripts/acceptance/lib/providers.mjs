// @ts-check
// The agents acceptance's scenes of providers entered on control's settings page, on its scripted
// model. One with a key: control lists its models, the rig takes one, and its model check goes
// through it with the provider's own key, which shows nowhere. One with no key, as a local server
// that takes none (pull request 80): control saves it and lists its models with none, the rig
// takes its model, and the rig's model check, Pi's own client in the harness, calls it with no
// Authorization header, never an empty bearer. Before that change control refused to save it, so
// the rig never took its model. The rig keeps the last provider's model.
import { api, events, rigCheck, until } from "./smoke-env.mjs";

/** The key of the provider with one, which the scripted model must see and no page may show. */
export const PROVIDER_KEY = "provider-key-acceptance-0001";

/**
 * Both scenes. `ui`: a dashboard session; `csrf`: its form token; `base`: the scripted model's
 * address as the containers reach it, ending in /v1; `keys`: the Authorization header of every
 * request the scripted model took, which each scene clears.
 * @param {{
 *   ui: { page: (path: string) => Promise<string>, post: (path: string, form: Record<string, string>) => Promise<number> },
 *   csrf: string,
 *   base: string,
 *   keys: Set<string>,
 *   check: import("./checks.mjs").Check,
 * }} o
 */
export async function providerScenes({ ui, csrf, base, keys, check }) {
  /** Adds a provider, gives the rig its model and runs the rig's model check. */
  const take = async (/** @type {string} */ name, /** @type {string | undefined} */ key) => {
    await ui.post("/ui/settings/providers", {
      csrf,
      name,
      type: "openai",
      base_url: base,
      ...(key ? { api_key: key } : {}),
    });
    const listed = await ui.page("/ui/settings");
    await ui.post("/ui/settings/rigs", { csrf, rig: "local-1", choice: `${name}|scripted` });
    const taken = await until(`the rig takes ${name}'s model`, async () => {
      const m = (await api("/v1/rigs/local-1/view")).body.model;
      return m?.source === "control" && m.name === name ? m : undefined;
    });
    keys.clear();
    return { listed, taken, modelCheck: await rigCheck("model") };
  };
  const keyed = await take("scripted-provider", PROVIDER_KEY);
  const shown = ["/ui/settings", "/ui/rigs/local-1/edit", "/ui/rigs/local-1"];
  const pages = (await Promise.all(shown.map((p) => ui.page(p)))).join("");
  check(
    "a provider from the settings page lists its models, reaches the rig and its model, and its key shows nowhere",
    /1 model/.test(keyed.listed) &&
      keyed.modelCheck.ok === true &&
      keys.has(`Bearer ${PROVIDER_KEY}`) &&
      !pages.includes(PROVIDER_KEY) &&
      !JSON.stringify(await events()).includes(PROVIDER_KEY),
    { taken: keyed.taken, summary: keyed.modelCheck.summary, keys: keys.size },
  );
  const keyless = await take("scripted-no-key", undefined);
  check(
    "a provider with no key is saved and listed with none, and the rig's model check calls it with no Authorization header",
    keyless.listed.includes('<span class="chip">no key</span>') &&
      keyless.modelCheck.ok === true &&
      keys.has("") &&
      !keys.has("Bearer ") &&
      ![...keys].some((k) => /Bearer (trial|proxy|call)\./.test(k)),
    {
      taken: keyless.taken,
      summary: keyless.modelCheck.summary,
      keys: [...keys].map((k) => k.slice(0, 16)),
    },
  );
}
