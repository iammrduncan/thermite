import type { Context, Hono } from "hono";
import {
  GeminiApiError,
  type GeminiApiStatus,
  type GeminiKeyState,
} from "../../providers/index.ts";
import type { ModelProvider } from "../../store/index.ts";
import { esc } from "../../ui/components/index.ts";
import type { Dashboard } from "../context.ts";
import { inUseWords } from "./shared.ts";

/**
 * The owner's page for Gemini API keys: the monthly spend cap and what was spent and is reserved
 * under it; each key's provider, with its test, its Disconnect and its Disconnect and delete; the
 * form that seals a key; the output limit and the prices the cap counts with.
 */

export const GEMINI_API_PAGE = "/ui/settings/gemini-api";
const PAGE = GEMINI_API_PAGE;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Micro-dollars as US dollars, to a hundredth of a cent. */
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;
const perMillion = (n: number) => `$${n}`;

/** Each state of a provider's key, in the words Providers and the key page show. */
const STATE_WORDS: Record<GeminiKeyState, string> = {
  connected: "Key sealed in control",
  disconnected: "Disconnected: no key",
  unusable: "Its key can't be opened",
  removal_pending: "Removal not finished",
};

/** The form that deletes a provider no rig uses, or why it can't be deleted yet. */
function deleteForm(name: string, state: GeminiKeyState, rigs: string[], csrf: string): string {
  if (rigs.length) return `<div class="muted small">${esc(inUseWords(rigs))}</div>`;
  return `<form class="inline" method="post" action="/ui/settings/providers/${encodeURIComponent(name)}/delete"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">${state === "disconnected" ? "Delete this provider" : "Disconnect and delete"}</button></form>`;
}

/** A Gemini API key's row on Providers: its state, its models, its page, and its removal. */
export function geminiApiRow(
  p: ModelProvider,
  state: GeminiKeyState,
  rigs: string[],
  csrf: string,
): string {
  return `<details class="dq${state === "connected" ? "" : " dq-bad"}" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Models</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· Gemini API key, under its spend cap</span></span><span class="dq-why${state === "connected" ? "" : " bad"}">${STATE_WORDS[state]} · runs in Pi</span><span class="dq-sub"><span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
<span class="dq-side"><a class="btn sm" href="${PAGE}">Key and spend</a></span>
</summary><div class="dq-body"><p>A Gemini API key under the monthly spend cap you set. The key stays in control; no other provider is tried when the cap is reached or a call fails.</p><div class="chips">${p.models.map((m) => `<span class="chip">${esc(m.id)}</span>`).join("")}</div>
${deleteForm(p.name, state, rigs, csrf)}</div></details>`;
}

/** The cap, the month's spend against it by provider, and the months before. */
function ledgerCard(s: GeminiApiStatus, hidden: string): string {
  const capForm = `<form method="post" action="${PAGE}/cap" class="form-grid" autocomplete="off">${hidden}
<label>Cap in US dollars, for a calendar month (UTC)<input name="usd" type="number" required min="0" step="0.01" value="${s.cap === undefined ? "" : (s.cap / 1e6).toFixed(2)}" placeholder="for example 10"></label>
<div class="form-end"><button${s.cap === undefined ? ' class="primary"' : ""}>Set the cap</button></div></form><p class="muted small">The cap is yours to set: Thermite has no amount of its own. A call is refused when its worst case (all its input and its whole output limit at the model's price) would take the month past the cap, so the last part of the cap may stay unspent. 0 refuses every call. A lower cap gives nothing back: what the month has counted stays counted.</p>`;
  if (s.cap === undefined)
    return `<section class="card warn"><h2>No monthly cap is set</h2><p>Set the cap before adding a key. Until one is set, no key is added and every call is refused: nothing is spent without a cap.</p>${capForm}</section>`;
  const l = s.ledger;
  if (!l)
    return `<section class="card warn"><h2>The spend ledger can't be read</h2><p>Control's record of this month's Gemini API spend is damaged. Every call is refused until it is repaired: nothing is spent while the spend can't be counted.</p>${capForm}</section>`;
  const left = Math.max(0, s.cap - l.spent - l.reserved);
  const rows = l.by
    .map((r) => `<tr><td>${esc(r.provider)}</td><td class="num">${usd(r.spent)}</td></tr>`)
    .join("");
  const months = l.closed
    .map(
      (m) =>
        `<tr><td>${esc(m.month)}</td><td class="num">${usd(m.spent)}</td><td class="num">${m.calls}</td><td class="num">${m.uncertain}</td></tr>`,
    )
    .join("");
  return `<section class="card${left === 0 ? " warn" : ""}"><h2>Spend in ${esc(l.month)} (UTC)</h2>
<p><b>Spent ${usd(l.spent)}</b> · reserved by ${l.open} open call${l.open === 1 ? "" : "s"} ${usd(l.reserved)} · cap ${usd(s.cap)} · left ${usd(left)}</p>
<p class="muted small">${l.calls} call${l.calls === 1 ? "" : "s"} counted this month; ${l.uncertain} of them charged their whole reservation because their cost was not known (broken off, timed out, or open when control stopped). All Gemini API keys on this control share this one cap, and a key removed or a provider deleted keeps what it spent counted.</p>
${rows ? `<table><thead><tr><th>Provider</th><th class="num">Spent this month</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
${months ? `<details><summary>Earlier months</summary><table><thead><tr><th>Month</th><th class="num">Spent</th><th class="num">Calls</th><th class="num">Charged in full</th></tr></thead><tbody>${months}</tbody></table></details>` : ""}
${capForm}</section>`;
}

/**
 * What stops every call because of the prices, and the owner's action that ends it: raised prices
 * that can't be read, or prices last checked too long ago. Nothing when the prices count.
 */
function priceWarning(s: GeminiApiStatus, hidden: string): string {
  if (!s.pricesReadable)
    return `<section class="card warn"><h2>The raised prices can't be read</h2><p>The prices you raised are stored, but control can't read them. Every call is refused until you clear them: Thermite does not count at the table's lower prices in their place. After clearing, raise again each price that is still above the table's.</p>
<form method="post" action="${PAGE}/prices-clear">${hidden}<button class="danger">Clear the raised prices</button></form></section>`;
  if (!s.pricesFresh)
    return `<section class="card warn"><h2>The prices need your review</h2><p>The price table counted until ${esc(s.pricesValidUntil)} (UTC). Every call is refused until you have compared the table below with <a href="${esc(s.source)}" target="_blank" rel="noopener noreferrer">Google's price page</a>, raised each price that Google has raised, and confirmed it here.</p>
<form method="post" action="${PAGE}/prices-reviewed">${hidden}<button class="primary">I have checked these prices today</button></form></section>`;
  return "";
}

/** The dated prices, and the form that raises one. */
function priceCard(s: GeminiApiStatus, hidden: string): string {
  const rows = s.prices
    .map((p) => {
      const long = p.tariff.long;
      return `<tr><td><code>${esc(p.model)}</code>${p.raised ? ' <span class="chip">raised by you</span>' : ""}</td><td class="num">${perMillion(p.tariff.rates.input)}</td><td class="num">${perMillion(p.tariff.rates.output)}</td><td class="num">${perMillion(p.tariff.rates.cached)}</td><td>${long ? `over ${long.above.toLocaleString("en-US")} prompt tokens: ${perMillion(long.rates.input)} / ${perMillion(long.rates.output)} / ${perMillion(long.rates.cached)}` : ""}</td></tr>`;
    })
    .join("");
  const options = s.prices
    .map((p) => `<option value="${esc(p.model)}">${esc(p.model)}</option>`)
    .join("");
  return `<section class="card"><h2>Prices the cap counts with</h2>
<p>US dollars per million tokens (input, output with thinking, cached input), read from <a href="${esc(s.source)}" target="_blank" rel="noopener noreferrer">Google's price page</a> on ${esc(s.checked)}. A dated change on that page counts from the day before. A model that is not in this table has no price and is refused.</p>
<table><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th>Long prompts</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted small">If Google raises a price before this table is updated, raise it here. A figure under the table's changes nothing: the higher always counts, so a price can't be lowered.</p>
<p>These prices count until <b>${esc(s.pricesValidUntil)}</b> (UTC). After that day every call is refused until you have compared them with Google's page again.</p>
<form method="post" action="${PAGE}/prices-reviewed">${hidden}<button>I have checked these prices today</button></form>
<form method="post" action="${PAGE}/price" class="form-grid" autocomplete="off">${hidden}
<label>Model<select name="model">${options}</select></label>
<label>Input<input name="input" inputmode="decimal" maxlength="12" placeholder="per 1M tokens"></label>
<label>Output<input name="output" inputmode="decimal" maxlength="12" placeholder="per 1M tokens"></label>
<label>Cached input<input name="cached" inputmode="decimal" maxlength="12" placeholder="per 1M tokens"></label>
<div class="form-end row" style="gap:8px"><button>Raise this model's price</button><button name="clear" value="1">Back to the table's price</button></div></form></section>`;
}

/** One provider's card: what its key's state is, and the actions that state has. */
function providerCard(
  p: ModelProvider,
  state: GeminiKeyState,
  rigs: string[],
  hidden: string,
  csrf: string,
): string {
  const named = `${hidden}<input type="hidden" name="name" value="${esc(p.name)}">`;
  const models = `<p>Models with a price: ${p.models.map((m) => `<code>${esc(m.id)}</code>`).join(", ") || "none"}.</p>`;
  const remove = `${deleteForm(p.name, state, rigs, csrf)}<p class="muted small">Deleting is refused while a rig still uses one of its models. What it spent stays counted.</p>`;
  const again = `<a class="btn sm" href="${PAGE}?name=${encodeURIComponent(p.name)}#add-key">Add a key under this name</a>`;
  if (state === "connected")
    return `<section class="card"><h2>${esc(p.name)}</h2><p>Its key is sealed in control. Rigs hold a capability for control's bridge, never the key. Pi only.</p>${models}
<form method="post" action="${PAGE}/test">${named}<button>Test the key</button></form><p class="muted small">The test asks Google for the model list with this key: no content request and no charge. It then keeps the listed models that have a price.</p>
<form method="post" action="${PAGE}/disconnect">${named}<button>Disconnect</button></form><p class="muted small">Disconnect removes the key from Thermite and stops its rigs' calls at once. The provider stays listed, so its rigs keep their models for a new key. Delete the key itself in Google AI Studio.</p>
${remove}</section>`;
  if (state === "disconnected")
    return `<section class="card warn"><h2>${esc(p.name)}: disconnected</h2><p>Thermite holds no key for this provider, and no rig or agent can call it. Its rigs keep their models: their calls are refused until a key is added under this name.</p>${models}
<p>${again}</p>${remove}</section>`;
  if (state === "removal_pending")
    return `<section class="card warn"><h2>${esc(p.name)}: removal not finished</h2><p>Thermite stopped this provider's calls, but the removal of its key could not be saved. Finish it now: until then the key is still sealed in control's store.</p>
<form method="post" action="${PAGE}/disconnect">${named}<button class="primary">Finish removing the key</button></form>
${remove}</section>`;
  return `<section class="card warn"><h2>${esc(p.name)}: its key can't be opened</h2><p>Control can't open what it sealed for this provider: its secrets key changed, or the stored value is damaged. Its calls are refused. Disconnect it, or add the key again under this name.</p>
<form method="post" action="${PAGE}/disconnect">${named}<button>Disconnect</button></form>
<p>${again}</p>${remove}</section>`;
}

/** These routes inherit the dashboard's session, body limit and POST CSRF checks. */
export function geminiApiPages(app: Hono, dash: Dashboard): void {
  const { parts, page, csrf, store, noted, said } = dash;
  const keys = parts.geminiApi;
  /** Never cached and never a referrer: on the page and on every answer to its forms. */
  const quiet = (c: Context) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
  };
  const back = (c: Context, kind: "ok" | "error", words: string) => {
    quiet(c);
    return c.redirect(`${PAGE}?${kind}=${encodeURIComponent(noted(words))}`, 303);
  };
  /** A form's failure in Thermite's own words: an error here never carries what was typed. */
  const why = (e: unknown) =>
    e instanceof GeminiApiError
      ? `Google's answer: ${e.message}`
      : e instanceof Error && !("issues" in e)
        ? e.message
        : "That was not accepted.";

  app.get(PAGE, (c) => {
    quiet(c);
    const s = keys.status();
    const token = csrf(c);
    const hidden = `<input type="hidden" name="csrf" value="${token}">`;
    const providers = store.modelProviders.list().filter((p) => p.type === "google-gemini-api");
    const cards = providers
      .map((p) => providerCard(p, keys.state(p), store.modelProviders.users(p.name), hidden, token))
      .join("");
    const error = said(c);
    const done = said(c, "ok");
    // A provider's name, from its own card's link, for the form that adds a key under it.
    const asked = c.req.query("name") ?? "";
    const name = NAME.test(asked) ? asked : "";
    const addCard =
      s.cap === undefined
        ? `<section class="card" id="add-key"><h2>Add a key</h2><p>Set the monthly cap first. A key is added only under a cap.</p></section>`
        : `<section class="card" id="add-key"><h2>${providers.length ? "Add or replace a key" : "Add a key"}</h2><form method="post" action="${PAGE}/add" class="form-grid" autocomplete="off">${hidden}
      <label>Provider name<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9._\\-]*" placeholder="gemini-api" value="${esc(name)}"></label>
      <label>Gemini API key<input name="key" type="password" required maxlength="512" autocomplete="new-password" spellcheck="false" placeholder="never shown again"></label>
      <label style="grid-column:1/-1"><span class="row small" style="gap:8px"><input type="checkbox" name="consent" value="1" required style="height:auto;width:auto"> Allow Thermite's agents to spend on this key when I am away, up to the monthly cap.</span></label>
      <div class="form-end"><button class="primary">Seal the key</button></div></form><p class="muted small">Sealing makes no call to Google. An existing provider name replaces its key: the rigs' routes for the old key stop at once.</p></section>`;
    return page(
      c,
      { title: "Gemini API key and spend", active: "settings" },
      `
      <p><a href="/ui/settings">Back to Providers</a></p>
      ${error ? `<div class="card warn"><b class="bad">Not done.</b> ${esc(error)}</div>` : ""}
      ${done ? `<div class="card"><b class="ok">${esc(done)}</b></div>` : ""}
      <p>A Gemini API key lets the agents call Google's Gemini API through control. The key is sealed in control and is never shown again, sent to a rig or given to a model. Thermite counts what each call costs and stops at the monthly cap you set. When the cap is reached or a call fails, the call fails: no other provider, key or route is tried.</p>
      <div class="card warn"><b>What the cap covers.</b> It counts only calls made through this Thermite, from the usage Google reports and the prices below. Anything else that uses the same key or Google project is not counted here. Credits and budget alerts at Google do not stop spending by themselves, and Thermite cannot see whether credits cover a charge: check the billing account in Google AI Studio.</div>
      ${priceWarning(s, hidden)}${ledgerCard(s, hidden)}${cards}${addCard}
      <section class="card"><h2>Output limit</h2><form method="post" action="${PAGE}/output" class="form-grid" autocomplete="off">${hidden}
      <label>Most output tokens a call may ask for, thinking included<input name="tokens" type="number" required min="1024" max="65536" step="1" value="${s.outputLimit}"></label>
      <div class="form-end"><button>Set the output limit</button></div></form><p class="muted small">Control sends every call this limit or the agent's own, whichever is lower. A lower limit reserves less for each call.</p></section>
      ${priceCard(s, hidden)}`,
    );
  });

  app.post(`${PAGE}/add`, async (c) => {
    const f = await c.req.parseBody();
    const name = String(f.name ?? "").trim();
    if (!NAME.test(name))
      return back(
        c,
        "error",
        "A provider's name is lowercase letters, digits, dots, dashes and underscores.",
      );
    try {
      const r = keys.add(name, String(f.key ?? "").trim(), f.consent === "1", "owner:ui");
      return back(
        c,
        "ok",
        `The key for "${name}" is sealed${r === "updated" ? ", in place of the one before" : ""}. Test it, then give one of its models to an agent on Edit rig, with the Pi harness.`,
      );
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
  app.post(`${PAGE}/test`, async (c) => {
    const f = await c.req.parseBody();
    const name = String(f.name ?? "");
    try {
      const { usable, unpriced } = await keys.test(name, "owner:ui");
      return back(
        c,
        "ok",
        `Google accepted the key for "${name}". ${usable} of the models it lists have a price and can be given to agents; ${unpriced} have none and stay refused. No content was requested.`,
      );
    } catch (e) {
      return back(c, "error", `The key for "${name}" was not confirmed. ${why(e)}`);
    }
  });
  app.post(`${PAGE}/disconnect`, async (c) => {
    const f = await c.req.parseBody();
    const name = String(f.name ?? "");
    try {
      const { was, stopped } = keys.disconnect(name, "owner:ui");
      if (was === "disconnected")
        return back(c, "ok", `"${name}" was already disconnected: Thermite holds no key for it.`);
      const broken = stopped
        ? ` ${stopped} call${stopped === 1 ? "" : "s"} in flight ${stopped === 1 ? "was" : "were"} broken off, and ${stopped === 1 ? "is" : "are"} charged ${stopped === 1 ? "its" : "their"} whole reservation.`
        : "";
      return back(
        c,
        "ok",
        `"${name}" is disconnected: Thermite holds no key for it, and its calls are refused from now.${broken} Its rigs keep their models for a new key. Delete the key in Google AI Studio too if it should not work anywhere.`,
      );
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
  app.post(`${PAGE}/cap`, async (c) => {
    const f = await c.req.parseBody();
    const raw = String(f.usd ?? "").trim();
    try {
      keys.setCap(/^\d{1,9}(?:\.\d{1,6})?$/u.test(raw) ? Number(raw) : Number.NaN, "owner:ui");
      return back(c, "ok", `The monthly cap is ${usd(keys.status().cap ?? 0)}.`);
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
  app.post(`${PAGE}/output`, async (c) => {
    const f = await c.req.parseBody();
    const raw = String(f.tokens ?? "").trim();
    try {
      keys.setOutputLimit(/^\d{1,6}$/u.test(raw) ? Number(raw) : Number.NaN, "owner:ui");
      return back(
        c,
        "ok",
        `A call may ask for at most ${keys.status().outputLimit} output tokens.`,
      );
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
  app.post(`${PAGE}/prices-reviewed`, (c) => {
    try {
      keys.reviewPrices("owner:ui");
      return back(
        c,
        "ok",
        `The prices count until ${keys.status().pricesValidUntil} (UTC). Review them again by then.`,
      );
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
  app.post(`${PAGE}/prices-clear`, (c) => {
    try {
      keys.clearRaisedPrices("owner:ui");
      return back(c, "ok", "The raised prices are cleared: the table's prices count.");
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
  app.post(`${PAGE}/price`, async (c) => {
    const f = await c.req.parseBody();
    const model = String(f.model ?? "");
    const figure = (v: unknown) => {
      const raw = String(v ?? "").trim();
      return /^\d{1,6}(?:\.\d{1,6})?$/u.test(raw) ? Number(raw) : Number.NaN;
    };
    try {
      if (f.clear === "1") {
        keys.raisePrice(model, null, "owner:ui");
        return back(c, "ok", `${model} is counted at the table's price again.`);
      }
      const rates = { input: figure(f.input), output: figure(f.output), cached: figure(f.cached) };
      if (Object.values(rates).some((n) => Number.isNaN(n)))
        return back(
          c,
          "error",
          "A raised price needs all three figures, each in US dollars per million tokens.",
        );
      keys.raisePrice(model, rates, "owner:ui");
      return back(
        c,
        "ok",
        `${model} is now counted at the higher of your figures and the table's.`,
      );
    } catch (e) {
      return back(c, "error", why(e));
    }
  });
}
