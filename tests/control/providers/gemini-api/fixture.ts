import assert from "node:assert/strict";
import { GeminiApiKeys } from "../../../../src/control/providers/gemini-api/index.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import { ControlStore } from "../../../../src/control/store/index.ts";
import type { GoogleGenerateBody } from "../../../../src/core/google-gemini.ts";
import { startGeminiStandIn } from "../../../stand-ins/gemini-api/server.ts";

/**
 * What the Gemini API key tests share: control's store, the keys on a clock the test sets, and the
 * loopback stand-in for Google (no network, no real key).
 */

/** A made-up value in a key's shape: not a key of any service. */
export const KEY = "not-a-real-gemini-api-key-fixture";
export const NAME = "gemini-api";
export const MODEL = "gemini-3.5-flash-lite";
/** The monthly cap the fixture's owner sets, in US dollars and in micro-dollars. */
export const CAP_USD = 10;
export const CAP = CAP_USD * 1e6;
export const BODY: GoogleGenerateBody = {
  contents: [{ role: "user", parts: [{ text: "fresh fixture" }] }],
};

/** `cap: null` leaves the cap unset, as on a control whose owner has set none. */
export async function keysFixture(
  o: { store?: ControlStore; start?: string; cap?: number | null } = {},
) {
  const google = await startGeminiStandIn();
  const store = o.store ?? new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  const clock = { now: new Date(o.start ?? "2026-11-16T12:00:00Z") };
  const make = (on: ControlStore = store) =>
    new GeminiApiKeys(on, secrets, "http://localhost:8800", google.fetch, () => clock.now);
  const keys = make();
  if (o.cap !== null) keys.setCap(o.cap ?? CAP_USD, "owner:ui");
  const provider = (name = NAME) => {
    const p = store.modelProviders.get(name);
    assert.ok(p, `provider ${name} exists`);
    return p;
  };
  const ledger = (from: GeminiApiKeys = keys) => {
    const l = from.status().ledger;
    assert.ok(l, "the ledger reads");
    return l;
  };
  /** A whole call: its chunks, or the error it ended with. */
  const call = async (
    from: GeminiApiKeys = keys,
    body: GoogleGenerateBody = BODY,
    model = MODEL,
    name = NAME,
  ) => {
    const chunks: Record<string, unknown>[] = [];
    try {
      for await (const chunk of from.generate(
        provider(name),
        model,
        body,
        new AbortController().signal,
      ))
        chunks.push(chunk);
      return { chunks, error: undefined };
    } catch (error) {
      return { chunks, error };
    }
  };
  return {
    google,
    store,
    secrets,
    clock,
    keys,
    make,
    provider,
    ledger,
    call,
    async close() {
      await google.close();
      if (!o.store) store.db.close();
    },
  };
}

export type KeysFixture = Awaited<ReturnType<typeof keysFixture>>;
