import { randomBytes } from "node:crypto";
import { z } from "zod";
import { errorText } from "../../../common/errors.ts";
import { log } from "../../../common/log.ts";
import { sameSecret } from "../../../common/secrets.ts";
import {
  type GoogleGenerateBody,
  GoogleName,
  googleBridgeBase,
} from "../../../core/google-gemini.ts";
import type { SecretBox } from "../../secrets.ts";
import type { ControlStore, ModelProvider, ProviderModel } from "../../store/index.ts";
import { GeminiApiError } from "./errors.ts";
import { GeminiLedger, type GeminiLedgerView } from "./ledger.ts";
import {
  GEMINI_INPUT_ALLOWANCE,
  GEMINI_OUTPUT_CEILING,
  GEMINI_PRICE_CHECKED,
  GEMINI_PRICE_SOURCE,
  GEMINI_PRICE_VALID_DAYS,
  GEMINI_PRICED_MODELS,
  GeminiPriceOverrides,
  type GeminiRates,
  type GeminiTariff,
  type GeminiUsage,
  geminiCost,
  geminiPricesFresh,
  geminiPricesValidUntil,
  geminiTariff,
  geminiUsage,
  geminiWorstCase,
} from "./prices.ts";
import { geminiModels, geminiStream } from "./upstream.ts";

export { GeminiApiError } from "./errors.ts";
export { GEMINI_OPEN_CALLS } from "./ledger.ts";

/**
 * Gemini API keys (provider type `google-gemini-api`): a key of the owner's, sealed in control,
 * which calls Google's Gemini API for the rigs' agents under the monthly spend cap the owner set.
 *
 * A rig never holds the key. Its route is control's own bridge and a capability made here, and
 * the key is sealed apart from the provider's row. Control checks the capability, reserves the
 * call's worst case in the ledger (ledger.ts), calls Google with the key (upstream.ts) and settles
 * the reservation to what Google reported the call used, at the dated prices (prices.ts). A call
 * whose cost is not known keeps its whole reservation. Nothing here tries another provider, key
 * or route.
 *
 * The cap is the owner's: there is none until the owner sets one, and until then no key is added
 * and no call is made. It covers every Gemini API key on this control together, so that a key
 * removed, replaced or added again under another name starts no new count. It counts only calls
 * made through this bridge: other uses of the same key or project are Google's to bill and are
 * not seen here.
 */

/**
 * The largest cap the setting takes, in micro-dollars (a thousand million US dollars): it keeps
 * the ledger's sums whole numbers. It is no limit on spending: the owner's cap is.
 */
export const GEMINI_CAP_MAX = 1e15;

/** The fewest output tokens the owner may limit a call to. */
const OUTPUT_LIMIT_MIN = 1024;

/** The settings these keys keep in control's store, each set by the owner on the key page. */
const CAP_KEY = "gemini_api_cap_micro_usd";
const OUTPUT_KEY = "gemini_api_output_limit";
const PRICES_KEY = "gemini_api_price_overrides";
/** The day (YYYY-MM-DD, UTC) the owner last reviewed the prices against Google's page. */
const REVIEWED_KEY = "gemini_api_prices_reviewed";
/** The setting the sealed keys are kept under: one JSON object, each key sealed, by provider name. */
const KEYS_KEY = "gemini_api_keys";

/**
 * What a provider row seals: only the capability its rigs' routes carry. The key itself is sealed
 * apart, under KEYS_KEY in control's settings, so nothing that reads a provider row's key (a
 * route, a model list, an older control after a roll back) can ever be handed Google's key.
 */
const Sealed = z.strictObject({ capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) });
type Sealed = z.infer<typeof Sealed>;
/** Any key a header can carry: visible ASCII, no space. */
const ApiKey = z.string().regex(/^[\x21-\x7e]{20,512}$/u);
const SealedKeys = z.record(GoogleName, z.string().min(1));

/**
 * Where a provider's key stands:
 * - `connected`: control holds the key, and its rigs' routes work;
 * - `disconnected`: control holds no key for it, and its calls are refused;
 * - `unusable`: the provider is listed as connected, but its capability or its key can't be
 *   opened (control's secrets key changed, or the row was damaged): its calls are refused;
 * - `removal_pending`: a removal stopped its calls but could not be written to the store. Its
 *   calls stay refused, and the removal is finished by asking for it again.
 */
type GeminiKeyState = "connected" | "disconnected" | "unusable" | "removal_pending";

/** A model's prices as the page shows them, and whether the owner raised any of them. */
interface PricedModel {
  model: string;
  tariff: GeminiTariff;
  raised: boolean;
}

/** What the key page shows: the cap, the ledger, the output limit and the prices. */
interface GeminiApiStatus {
  /** The owner's monthly cap in micro-dollars; undefined while none is set: every call is refused. */
  cap: number | undefined;
  outputLimit: number;
  /** Undefined when the ledger can't be read: every call is refused until it is repaired. */
  ledger: GeminiLedgerView | undefined;
  prices: PricedModel[];
  source: string;
  checked: string;
  /**
   * False when the owner's raised prices are stored but can't be read: every call is refused
   * until the owner clears them, rather than counted at the table's lower prices.
   */
  pricesReadable: boolean;
  /** The day (YYYY-MM-DD, UTC) the prices count until, and whether they still count now. */
  pricesValidUntil: string;
  pricesFresh: boolean;
}

export class GeminiApiKeys {
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly publicUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly ledger: GeminiLedger;
  /** The calls in flight by provider, so that a removal breaks them off. */
  private readonly active = new Map<string, Set<AbortController>>();
  /**
   * Providers a removal stopped before the store took it: refused here, whatever the store still
   * says, until the removal is finished or a key is added again.
   */
  private readonly fenced = new Set<string>();

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    publicUrl: string | undefined,
    fetchImpl: typeof fetch = fetch,
    now: () => Date = () => new Date(),
  ) {
    this.store = store;
    this.secrets = secrets;
    this.publicUrl = publicUrl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.ledger = new GeminiLedger(store, now);
    this.sweep();
  }

  private base(name: string): string {
    if (!this.publicUrl)
      throw new Error("Configure control's public URL before adding a Gemini API key");
    return googleBridgeBase(this.publicUrl, name);
  }

  private sealed(p: ModelProvider): Sealed | undefined {
    if (p.type !== "google-gemini-api" || !p.key_sealed || this.fenced.has(p.name))
      return undefined;
    try {
      return Sealed.parse(JSON.parse(this.secrets.open(p.key_sealed)));
    } catch {
      return undefined;
    }
  }

  /** The sealed keys by provider name; none when what the store holds can't be read. */
  private sealedKeys(): z.infer<typeof SealedKeys> {
    try {
      return SealedKeys.parse(JSON.parse(this.store.ownSettings.get(KEYS_KEY)?.value ?? "{}"));
    } catch {
      return {};
    }
  }

  /** Keeps a provider's sealed key, or with null removes it. Call it inside a transaction. */
  private keepKey(name: string, sealed: string | null, by: string): void {
    const keys = this.sealedKeys();
    if (sealed === null) delete keys[name];
    else keys[name] = sealed;
    this.store.ownSettings.set(
      KEYS_KEY,
      Object.keys(keys).length ? JSON.stringify(keys) : null,
      by,
    );
  }

  /** A provider's key, opened for one call to Google; undefined when control holds none. */
  private keyOf(name: string): string | undefined {
    // An own entry only: a provider may be named as a property every object inherits.
    const keys = this.sealedKeys();
    const sealed = Object.hasOwn(keys, name) ? keys[name] : undefined;
    if (!sealed) return undefined;
    try {
      return ApiKey.parse(this.secrets.open(sealed));
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------------ the owner's settings

  /**
   * The monthly cap in micro-dollars, as the owner set it. Undefined while none is set, and for a
   * stored value that can't be read: every call is then refused, never sent without a cap.
   */
  private cap(): number | undefined {
    const row = this.store.ownSettings.get(CAP_KEY);
    const set = row && /^\d{1,16}$/u.test(row.value) ? Number(row.value) : Number.NaN;
    return Number.isSafeInteger(set) && set <= GEMINI_CAP_MAX ? set : undefined;
  }

  /** The most output tokens a call may ask for: the owner's, never above Google's own cap. */
  private outputLimit(): number {
    const set = Number(this.store.ownSettings.get(OUTPUT_KEY)?.value);
    return Number.isSafeInteger(set) && set >= OUTPUT_LIMIT_MIN
      ? Math.min(set, GEMINI_OUTPUT_CEILING)
      : GEMINI_OUTPUT_CEILING;
  }

  /**
   * The owner's raised prices: none when none are stored, and undefined when what is stored can't
   * be read. An unreadable setting is never read as "none": the owner raised a price because the
   * table's was too low, and counting at the table's again would understate the spend.
   */
  private overrides(): GeminiPriceOverrides | undefined {
    try {
      return GeminiPriceOverrides.parse(
        JSON.parse(this.store.ownSettings.get(PRICES_KEY)?.value ?? "{}"),
      );
    } catch {
      return undefined;
    }
  }

  private tariff(model: string): GeminiTariff | undefined {
    const overrides = this.overrides();
    return overrides === undefined ? undefined : geminiTariff(model, this.now(), overrides);
  }

  /** The day the owner last reviewed the prices, as stored. */
  private reviewed(): string | undefined {
    return this.store.ownSettings.get(REVIEWED_KEY)?.value;
  }

  /**
   * Sets the monthly cap, in US dollars. 0 refuses every call. A cap under what the month has
   * already counted refuses every call until the month ends; it gives nothing back.
   */
  setCap(usd: number, by: string): void {
    const micros = Math.round(usd * 1e6);
    if (!Number.isFinite(usd) || micros < 0 || micros > GEMINI_CAP_MAX)
      throw new Error("The monthly cap is an amount in US dollars, 0 or more.");
    const was = this.cap() ?? null;
    this.store.tx(() => {
      this.store.ownSettings.set(CAP_KEY, String(micros), by);
      this.store.auditLog.add(by, "gemini_api_cap_set", { micro_usd: micros, was });
    });
  }

  /** Sets the most output tokens, thinking included, a call may ask for. */
  setOutputLimit(tokens: number, by: string): void {
    if (!Number.isInteger(tokens) || tokens < OUTPUT_LIMIT_MIN || tokens > GEMINI_OUTPUT_CEILING)
      throw new Error(
        `A call's output limit is a whole number of tokens from ${OUTPUT_LIMIT_MIN} to ${GEMINI_OUTPUT_CEILING}.`,
      );
    this.store.tx(() => {
      this.store.ownSettings.set(OUTPUT_KEY, String(tokens), by);
      this.store.auditLog.add(by, "gemini_api_output_limit_set", { tokens });
      this.relist();
    });
  }

  /**
   * Raises a priced model's prices (null: back to the table's). A figure under the table's does
   * not lower it: the higher of the two always counts.
   */
  raisePrice(model: string, rates: GeminiRates | null, by: string): void {
    if (!GEMINI_PRICED_MODELS.includes(model))
      throw new Error(
        "Only a model in Thermite's price table can have its price raised: a model without one is refused.",
      );
    const current = this.overrides();
    if (current === undefined)
      throw new Error(
        "The stored raised prices can't be read: clear them on this page before changing a price.",
      );
    const next = { ...current };
    if (rates) next[model] = rates;
    else delete next[model];
    const checked = GeminiPriceOverrides.parse(next);
    this.store.tx(() => {
      this.store.ownSettings.set(PRICES_KEY, JSON.stringify(checked), by);
      this.store.auditLog.add(by, "gemini_api_price_raised", { model, rates });
      this.relist();
    });
  }

  /**
   * Clears every raised price, readable or not: the table's prices count again. It is the owner's
   * way out of raised prices that can't be read, which refuse every call.
   */
  clearRaisedPrices(by: string): void {
    this.store.tx(() => {
      this.store.ownSettings.set(PRICES_KEY, null, by);
      this.store.auditLog.add(by, "gemini_api_prices_cleared", {});
      this.relist();
    });
  }

  /**
   * Records that the owner compared the price table with Google's page today (UTC): the prices
   * count for GEMINI_PRICE_VALID_DAYS more days from now.
   */
  reviewPrices(by: string): void {
    const reviewed = this.now().toISOString().slice(0, 10);
    this.store.tx(() => {
      this.store.ownSettings.set(REVIEWED_KEY, reviewed, by);
      this.store.auditLog.add(by, "gemini_api_prices_reviewed", {
        reviewed,
        valid_days: GEMINI_PRICE_VALID_DAYS,
      });
    });
  }

  /**
   * Every key's models again, with the prices and the output limit as they are now. With raised
   * prices that can't be read, the lists stay as they are.
   */
  private relist(): void {
    if (this.overrides() === undefined) return;
    for (const p of this.store.modelProviders.list())
      if (p.type === "google-gemini-api")
        this.store.modelProviders.setModels(
          p.name,
          p.models.map((m) => this.listed(m.id, m.context_window)).filter((m) => m !== undefined),
        );
  }

  /** What the key page shows. */
  status(): GeminiApiStatus {
    const overrides = this.overrides();
    const now = this.now();
    return {
      pricesReadable: overrides !== undefined,
      pricesValidUntil: new Date(geminiPricesValidUntil(this.reviewed(), now))
        .toISOString()
        .slice(0, 10),
      pricesFresh: geminiPricesFresh(this.reviewed(), now),
      cap: this.cap(),
      outputLimit: this.outputLimit(),
      ledger: this.ledger.view(),
      prices: GEMINI_PRICED_MODELS.flatMap((model) => {
        const tariff = this.tariff(model);
        return tariff ? [{ model, tariff, raised: Object.hasOwn(overrides ?? {}, model) }] : [];
      }),
      source: GEMINI_PRICE_SOURCE,
      checked: GEMINI_PRICE_CHECKED,
    };
  }

  // ------------------------------------------------------------------------ a key

  /** A priced model as a provider's list keeps it, with its price for the usage report. */
  private listed(id: string, window?: number | undefined): ProviderModel | undefined {
    const t = this.tariff(id);
    if (!t) return undefined;
    return {
      id,
      ...(window ? { context_window: window } : {}),
      max_output: this.outputLimit(),
      price: { input: t.rates.input, cached_input: t.rates.cached, output: t.rates.output },
    };
  }

  /**
   * Seals a key under a provider name, new or replacing the one there, and gives the provider the
   * priced models. No call to Google is made. A new capability is made each time, so the routes
   * the rigs hold for an earlier key stop at once. The key is never echoed, also not in an error.
   * It is refused until the owner has set the monthly cap: no key is held without one.
   */
  add(name: string, key: string, consent: boolean, by: string): "created" | "updated" {
    GoogleName.parse(name);
    if (this.cap() === undefined)
      throw new Error("Set the monthly spend cap first: no Gemini API key is added without one.");
    if (!consent)
      throw new Error(
        "Allow Thermite's agents to spend on this key, up to the cap, before adding it",
      );
    const checked = ApiKey.safeParse(key);
    if (!checked.success)
      throw new Error(
        "That is not a key's shape: 20 to 512 characters with no space. Nothing was saved.",
      );
    const old = this.store.modelProviders.get(name);
    if (old && old.type !== "google-gemini-api")
      throw new Error("That provider name already belongs to another kind");
    const base = this.base(name);
    this.stop(name);
    const r = this.store.tx(() => {
      const r = this.store.modelProviders.put({
        name,
        type: "google-gemini-api",
        base_url: base,
        key: {
          sealed: this.secrets.seal(
            JSON.stringify({
              capability: randomBytes(32).toString("base64url"),
            } satisfies Sealed),
          ),
          hint: "Gemini API key",
        },
      });
      if (r === "needs_key") throw new Error("The key was not saved");
      this.keepKey(name, this.secrets.seal(checked.data), by);
      if (!old?.models.length)
        this.store.modelProviders.setModels(
          name,
          GEMINI_PRICED_MODELS.map((id) => this.listed(id)).filter((m) => m !== undefined),
        );
      this.store.auditLog.add(
        by,
        r === "created" ? "model_provider_added" : "model_provider_changed",
        {
          name,
          type: "google-gemini-api",
          unattended_use: "allowed by the owner, up to the monthly cap",
          fallback: false,
        },
      );
      return r;
    });
    // The store holds the new key: a removal that had not finished is over.
    this.fenced.delete(name);
    return r;
  }

  /**
   * Checks a key with Google's model list alone (no content request, no charge) and keeps the
   * listed models that have a price. Returns how many Google listed and how many of those have
   * none, which stay refused.
   */
  async test(name: string, by: string): Promise<{ usable: number; unpriced: number }> {
    const p = this.store.modelProviders.get(name);
    const key = p && this.sealed(p) ? this.keyOf(name) : undefined;
    if (!p || !key) throw new Error("No Gemini API key is sealed under that provider name");
    // Without readable prices no listed model would have one, and the list would be emptied.
    if (this.overrides() === undefined)
      throw new Error("The stored raised prices can't be read: clear them on this page first.");
    let outcome = "server";
    try {
      const listed = await geminiModels(this.fetchImpl, key);
      // The key may have been replaced or removed while Google answered.
      if (this.store.modelProviders.get(name)?.key_sealed !== p.key_sealed)
        throw new Error("The key changed during the check: check it again");
      const usable = listed
        .map((m) => this.listed(m.id, m.inputLimit))
        .filter((m) => m !== undefined);
      this.store.modelProviders.setModels(name, usable);
      outcome = "listed";
      return { usable: usable.length, unpriced: listed.length - usable.length };
    } catch (error) {
      if (error instanceof GeminiApiError) outcome = error.reason;
      throw error;
    } finally {
      this.store.auditLog.add(by, "gemini_api_key_tested", { name, outcome });
    }
  }

  // ------------------------------------------------------------------------ removal

  /** Where a provider's key stands (GeminiKeyState). */
  state(p: ModelProvider): GeminiKeyState {
    if (this.fenced.has(p.name)) return "removal_pending";
    const held = Object.hasOwn(this.sealedKeys(), p.name);
    if (!p.key_sealed) return held ? "removal_pending" : "disconnected";
    return this.sealed(p) && this.keyOf(p.name) ? "connected" : "unusable";
  }

  /**
   * Removes a provider's key from control, whatever state it is in, and breaks off its calls in
   * flight: its capability stops at once, so its rigs' routes do. The provider stays listed, so
   * its rigs keep their models for the next key. The ledger keeps what was spent, and a call
   * broken off is charged its whole reservation.
   *
   * The key, the capability and the audit entry change in one transaction of the store. When the
   * store refuses it, nothing of the three has changed, but the provider is refused here from
   * that moment (`removal_pending`), and the same call finishes the removal. A provider already
   * disconnected is left as it is.
   */
  disconnect(name: string, by: string): { was: GeminiKeyState; stopped: number } {
    const p = this.store.modelProviders.get(name);
    if (p?.type !== "google-gemini-api")
      throw new Error("No Gemini API key has that provider name");
    const was = this.state(p);
    if (was === "disconnected") return { was, stopped: 0 };
    const stopped = this.calls(name);
    this.finish(name, () => {
      this.store.modelProviders.setKey(name, "");
      this.keepKey(name, null, by);
      this.store.auditLog.add(by, "gemini_api_key_removed", { name, was, calls_stopped: stopped });
    });
    return { was, stopped };
  }

  /**
   * Disconnects a provider and deletes it, in one transaction of the store: `in_use` while a rig
   * still has one of its models, and nothing is then changed. The ledger keeps what it spent, also
   * for a provider added again under the same name.
   */
  remove(name: string, by: string): "deleted" | "in_use" | "missing" {
    const p = this.store.modelProviders.get(name);
    if (!p) return "missing";
    if (p.type !== "google-gemini-api") throw new Error("No Gemini API key has that provider name");
    const stopped = this.calls(name);
    return this.finish(name, () => {
      const r = this.store.modelProviders.delete(name);
      if (r !== "deleted") return r;
      this.keepKey(name, null, by);
      this.store.auditLog.add(by, "model_provider_deleted", {
        name,
        type: "google-gemini-api",
        key_removed: true,
        calls_stopped: stopped,
      });
      return r;
    });
  }

  /**
   * Runs a removal's writes as one transaction and then breaks off the provider's calls. When
   * the store refuses the transaction, the provider is fenced and its calls broken off all the
   * same, and the error says that the removal is to be asked for again. A removal that changed
   * nothing (the provider is in use) stops no call.
   */
  private finish<T>(name: string, writes: () => T): T {
    let done: T;
    try {
      done = this.store.tx(writes);
    } catch (error) {
      this.fenced.add(name);
      this.stop(name);
      log("gemini-api", "removal not stored", { provider: name, error: errorText(error) }, "error");
      throw new Error(
        "The removal could not be saved. Thermite refuses this provider's calls from now until control restarts: remove it again to finish.",
      );
    }
    if (done !== "in_use") {
      this.fenced.delete(name);
      this.stop(name);
    }
    return done;
  }

  /**
   * At start: removes each sealed key whose provider is gone or holds no capability, which only
   * a damaged or hand-edited store leaves. A key without its provider must not stay sealed here.
   */
  private sweep(): void {
    this.store.tx(() => {
      const left = Object.keys(this.sealedKeys()).filter((name) => {
        const p = this.store.modelProviders.get(name);
        return p?.type !== "google-gemini-api" || !p.key_sealed;
      });
      for (const name of left) {
        this.keepKey(name, null, "control");
        this.store.auditLog.add("control", "gemini_api_key_removed", {
          name,
          was: "removal_pending",
          why: "its provider holds no capability for it",
        });
      }
    });
  }

  /** How many of a provider's calls are in flight. */
  private calls(name: string): number {
    return this.active.get(name)?.size ?? 0;
  }

  private stop(name: string): void {
    for (const c of this.active.get(name) ?? []) c.abort();
  }

  // ------------------------------------------------------------------------ the bridge

  /** A provider's route for a rig: control's bridge and the capability, never the key. */
  route(p: ModelProvider): { base: string; key: string } | undefined {
    const sealed = this.sealed(p);
    return sealed ? { base: this.base(p.name), key: sealed.capability } : undefined;
  }

  /** Whether a provider's key is still the one a call began with, and no removal has stopped it. */
  private current(p: ModelProvider): boolean {
    return (
      !this.fenced.has(p.name) && this.store.modelProviders.get(p.name)?.key_sealed === p.key_sealed
    );
  }

  /** The provider a bridge call's capability is for, if it is its current one. */
  authorized(name: string, capability: string): ModelProvider | undefined {
    const p = this.store.modelProviders.get(name);
    const sealed = p && this.sealed(p);
    return p && sealed && sameSecret(capability, sealed.capability) ? p : undefined;
  }

  /**
   * One content call for a rig: each native chunk of Google's answer, as it arrives. The call's
   * worst case is reserved before it is sent, and refused when it would cross the cap; its
   * reservation is settled to what Google's final usage says it cost, and kept whole when the
   * call ends any other way after it may have reached Google (broken off, timed out, cut short).
   */
  async *generate(
    p: ModelProvider,
    model: string,
    body: GoogleGenerateBody,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>, void, undefined> {
    // A caller already gone is sent nothing and reserves nothing.
    if (signal.aborted) throw new GeminiApiError("timeout", "no");
    const key = this.sealed(p) ? this.keyOf(p.name) : undefined;
    if (!key || !this.current(p)) throw new GeminiApiError("auth", "no");
    if (!p.models.some((m) => m.id === model)) throw new GeminiApiError("route", "no");
    /** A call control refuses before it reserves anything: audited, and nothing is sent. */
    const refuse = (why: "no_cap" | "prices_unreadable" | "prices_stale"): GeminiApiError => {
      this.store.auditLog.refusal(`provider:${p.name}`, "gemini_api_call_refused", { why, model });
      log("gemini-api", "call refused", { provider: p.name, model, why }, "warn");
      return new GeminiApiError(why === "no_cap" ? "no_cap" : "prices", "no");
    };
    if (this.overrides() === undefined) throw refuse("prices_unreadable");
    if (!geminiPricesFresh(this.reviewed(), this.now())) throw refuse("prices_stale");
    const tariff = this.tariff(model);
    if (!tariff) throw new GeminiApiError("unpriced", "no");
    const cap = this.cap();
    if (cap === undefined) throw refuse("no_cap");
    // The limit Google holds the call to, thinking included: never above the owner's.
    const outputLimit = Math.min(
      body.generationConfig?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
      this.outputLimit(),
    );
    const sent = Buffer.from(
      JSON.stringify({
        ...body,
        generationConfig: { ...body.generationConfig, maxOutputTokens: outputLimit },
      }),
    );
    const worst = geminiWorstCase(tariff, sent.byteLength + GEMINI_INPUT_ALLOWANCE, outputLimit);
    const reserved = this.ledger.reserve({ provider: p.name, model, micros: worst }, cap);
    if (!reserved.ok) {
      this.store.auditLog.refusal(`provider:${p.name}`, "gemini_api_call_refused", {
        why: reserved.why,
        model,
      });
      log("gemini-api", "call refused", { provider: p.name, model, why: reserved.why }, "warn");
      throw new GeminiApiError(
        reserved.why === "cap" ? "cap" : reserved.why === "busy" ? "rate_limit" : "ledger",
        "no",
      );
    }
    // Undefined keeps the whole reservation: the only end that gives any of it back is a known cost.
    let cost: number | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const calls = this.active.get(p.name) ?? new Set<AbortController>();
    this.active.set(p.name, calls);
    calls.add(controller);
    try {
      let used: GeminiUsage | undefined;
      let finished = false;
      // Whether the last chunk carried usage that reads: only that is the finished call's bill.
      let finalUsage = false;
      for await (const chunk of geminiStream(this.fetchImpl, key, model, sent, controller.signal)) {
        if (!this.current(p)) throw new GeminiApiError("auth", "unknown");
        const usage = geminiUsage(chunk.usageMetadata);
        if (usage) used = used ? highest(used, usage) : usage;
        finalUsage = usage !== undefined;
        finished ||= ended(chunk);
        yield chunk;
      }
      // The caller may have gone, or the key been removed or replaced, after the last chunk was
      // handed over and before the stream's end was read: such a call's cost is not known either.
      if (controller.signal.aborted || signal.aborted)
        throw new GeminiApiError("timeout", "unknown");
      if (!this.current(p)) throw new GeminiApiError("auth", "unknown");
      if (!finished) throw new GeminiApiError("server", "unknown");
      // Google's stream ended by itself, after its last chunk: with usage on that chunk, the cost
      // is known. Usage an earlier chunk reported does not stand in for it: an answer that came
      // whole without final usage is the rig's all the same, at its whole reservation.
      if (used && finalUsage) cost = geminiCost(tariff, used);
    } catch (error) {
      if (error instanceof GeminiApiError && error.billed === "no") cost = 0;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      controller.abort();
      calls.delete(controller);
      if (!calls.size && this.active.get(p.name) === calls) this.active.delete(p.name);
      this.ledger.settle(reserved.id, cost);
      if (cost === undefined)
        this.store.auditLog.refusal(`provider:${p.name}`, "gemini_api_reservation_kept", {
          why: "the call's cost is not known",
          model,
        });
      else if (cost > worst)
        this.store.auditLog.add("control", "gemini_api_cost_over_reservation", {
          provider: p.name,
          model,
          reserved_micro_usd: worst,
          cost_micro_usd: cost,
        });
      log(
        "gemini-api",
        "call settled",
        { provider: p.name, model, reserved_micro_usd: worst, cost_micro_usd: cost ?? worst },
        "debug",
      );
    }
  }
}

/** Two usages of one stream as one: each count that adds to the cost at its higher report. */
function highest(a: GeminiUsage, b: GeminiUsage): GeminiUsage {
  return {
    prompt: Math.max(a.prompt, b.prompt),
    // The cached part alone lowers a cost: the lower report counts.
    cached: Math.min(a.cached, b.cached),
    candidates: Math.max(a.candidates, b.candidates),
    thoughts: Math.max(a.thoughts, b.thoughts),
    toolUse: Math.max(a.toolUse, b.toolUse),
    total: Math.max(a.total, b.total),
  };
}

/** Whether a chunk ends the answer: a candidate's finish reason, or a prompt Google blocked. */
function ended(chunk: Record<string, unknown>): boolean {
  const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
  const blocked = (chunk.promptFeedback as { blockReason?: unknown } | null | undefined)
    ?.blockReason;
  return (
    typeof blocked === "string" ||
    candidates.some(
      (c) => typeof (c as { finishReason?: unknown } | null)?.finishReason === "string",
    )
  );
}
