import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ChatGPTLogins } from "../../../src/control/providers/chatgpt.ts";
import {
  CHATGPT_USAGE_URL,
  chatgptWindows,
  claudeUsage,
  type PlanUsage,
  PlanUsageReader,
  providersWithUsage,
} from "../../../src/control/providers/plan-usage.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlStore, type ModelProvider } from "../../../src/control/store/index.ts";
import { usageBlock, usageChips } from "../../../src/control/ui/providers/usage.ts";
import { CHATGPT_API } from "../../../src/core/agents.ts";

const NOW = Date.parse("2026-10-26T03:00:00.000Z");
const S = NOW / 1000;

/** A token shaped as OpenAI's, naming its ChatGPT account (no real signature). */
const jwt = (claims: object) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

function signedIn(answer: (url: string, init: RequestInit) => Response) {
  const store = new ControlStore(":memory:");
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fake = (async (url: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: init.headers as Record<string, string> });
    return answer(String(url), init);
  }) as typeof fetch;
  const chatgpt = new ChatGPTLogins(store, SecretBox.ephemeral(), fake);
  const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const sealed = chatgpt.seal({
    access,
    refresh: "r",
    expires: Date.now() + 3_600_000,
    earliest_refresh: null,
    client_id: "c",
    host_id: "h",
  });
  store.modelProviders.put({
    name: "codex-1",
    type: "chatgpt",
    base_url: CHATGPT_API,
    key: { sealed, hint: "…ab12" },
  });
  const p = store.modelProviders.get("codex-1") as ModelProvider;
  return { store, chatgpt, p, seen, access };
}

const WHAM = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3600,
      reset_at: S + 3600,
    },
    secondary_window: { used_percent: 81, limit_window_seconds: 604_800, reset_at: S + 86_400 },
  },
};

describe("a subscription's usage on Providers (goal 151)", () => {
  test("ChatGPT's answer gives the plan and each window; the Codex app server's names read too", () => {
    const got = chatgptWindows(WHAM, NOW);
    assert.equal(got?.plan, "pro");
    assert.deepEqual(got?.windows, [
      {
        id: "primary",
        label: "5-hour",
        minutes: 300,
        used_percent: 42,
        resets_at: new Date((S + 3600) * 1000).toISOString(),
      },
      {
        id: "secondary",
        label: "Weekly",
        minutes: 10_080,
        used_percent: 81,
        resets_at: new Date((S + 86_400) * 1000).toISOString(),
      },
    ]);
    const app = chatgptWindows(
      { planType: "plus", rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300 } } },
      NOW,
    );
    assert.equal(app?.windows[0]?.label, "5-hour");
    assert.equal(app?.windows[0]?.resets_at, null);
    // Only the time to the reset: counted from now.
    const after = chatgptWindows(
      { rate_limit: { primary_window: { used_percent: 1, reset_after_seconds: 60 } } },
      NOW,
    );
    assert.equal(after?.windows[0]?.resets_at, new Date(NOW + 60_000).toISOString());
    assert.equal(chatgptWindows({ detail: "nope" }, NOW), undefined);
    assert.equal(chatgptWindows("<html>", NOW), undefined);
  });

  test("control asks ChatGPT with the sign-in's token and account, and says a refusal in words", async () => {
    let status = 200;
    const t = signedIn(() => Response.json(WHAM, { status }));
    const ok = await t.chatgpt.usage(t.p);
    assert.equal(ok.source, "openai");
    assert.equal(ok.windows.length, 2);
    assert.equal(ok.error, undefined);
    assert.equal(t.seen[0]?.url, CHATGPT_USAGE_URL);
    assert.equal(t.seen[0]?.headers.authorization, `Bearer ${t.access}`);
    assert.equal(t.seen[0]?.headers["chatgpt-account-id"], "acct-1");
    status = 403;
    const refused = await t.chatgpt.usage(t.p);
    assert.deepEqual(refused.windows, []);
    assert.equal(refused.error, "ChatGPT's usage endpoint refused this sign-in: HTTP 403");
    const odd = signedIn(() => new Response("<html>challenge</html>", { status: 200 }));
    assert.equal((await odd.chatgpt.usage(odd.p)).error, "its answer was not in a known shape");
    // The token went to OpenAI's usage endpoint only, and the answer keeps no token.
    assert.ok(t.seen.every((s) => s.url === CHATGPT_USAGE_URL));
    assert.ok(!JSON.stringify([ok, refused]).includes(t.access));
  });

  test("ChatGPT is asked at most once in 5 minutes; a slow answer leaves the page without it", async () => {
    let clock = NOW;
    let asked = 0;
    const answer: PlanUsage = {
      source: "openai",
      windows: [],
      at: new Date(NOW).toISOString(),
      error: "x",
    };
    const store = { reportedRigs: { list: () => [] } } as unknown as ControlStore;
    const reader = new PlanUsageReader(
      store,
      async () => {
        asked++;
        return answer;
      },
      () => clock,
    );
    const p = { name: "codex-1", type: "chatgpt" } as ModelProvider;
    assert.equal(await reader.of(p), answer);
    clock += 4 * 60_000;
    await reader.of(p);
    assert.equal(asked, 1);
    clock += 60_000;
    await reader.of(p);
    assert.equal(asked, 2);
    const slow = new PlanUsageReader(store, () => new Promise(() => {}));
    assert.equal(await slow.of(p, 20), undefined);
    assert.equal(await reader.of({ name: "or", type: "openai" } as ModelProvider), undefined);
  });

  test("a Claude subscription's windows come from the rig that reported them last", () => {
    const report = (provider: string, at: string, u: number) => ({
      subscription_usage: {
        provider,
        at,
        five_hour: { utilization: u, resets_at: "2026-10-26T05:00:00.000Z" },
        seven_day: { utilization: 0.9, resets_at: "2026-10-30T00:00:00.000Z" },
      },
    });
    const got = claudeUsage("claude-2", [
      { id: "rig-a", summary: report("claude-2", "2026-10-26T01:00:00.000Z", 0.1) },
      { id: "rig-b", summary: report("claude-2", "2026-10-26T02:00:00.000Z", 0.42) },
      { id: "rig-c", summary: report("other", "2026-10-26T02:30:00.000Z", 0.99) },
      { id: "rig-d", summary: null },
    ]);
    assert.equal(got?.rig, "rig-b");
    assert.deepEqual(
      got?.windows.map((w) => [w.label, w.used_percent]),
      [
        ["5-hour", 42],
        ["Weekly", 90],
      ],
    );
    assert.equal(claudeUsage("claude-2", [{ id: "rig-a", summary: {} }]), undefined);
  });

  test("the row: chips on its closed line, marked from 80%; in full, with its source or why none", () => {
    const u: PlanUsage = {
      source: "openai",
      plan: "pro",
      at: new Date(NOW - 60_000).toISOString(),
      ...(chatgptWindows(WHAM, NOW) as { windows: PlanUsage["windows"] }),
    };
    const chips = usageChips(u);
    assert.match(
      chips,
      /<span class="chip" title="5-hour window, resets [^"]+">5-hour 42%<\/span>/,
    );
    assert.match(chips, /<span class="chip warn" title="Weekly window[^"]*">Weekly 81%<\/span>/);
    assert.equal(usageChips(undefined), "");
    const open = usageBlock("chatgpt", u, NOW);
    assert.match(open, /<b>5-hour window<\/b> · 42% used · resets 2026-10-26 04:00 UTC/);
    assert.match(
      open,
      /As OpenAI answered control 1m ago \(plan: pro\); asked again after 5 minutes/,
    );
    const refused = usageBlock(
      "chatgpt",
      { source: "openai", windows: [], at: u.at, error: "refused: HTTP 403" },
      NOW,
    );
    assert.match(
      refused,
      /No usage from OpenAI: refused: HTTP 403\. See <a href="https:\/\/chatgpt\.com\/#settings\/Usage"/,
    );
    assert.match(usageBlock("chatgpt", undefined, NOW), /OpenAI has not answered yet/);
    assert.match(usageBlock("claude", undefined, NOW), /No usage reported yet/);
  });

  test("the providers tool gives each subscription's usage, never a key", async () => {
    const t = signedIn(() => Response.json(WHAM));
    const reader = new PlanUsageReader(t.store, (p) => t.chatgpt.usage(p));
    const listed = await providersWithUsage(t.store, (p) => reader.of(p));
    assert.equal(listed[0]?.name, "codex-1");
    assert.equal(listed[0]?.usage?.windows[1]?.used_percent, 81);
    assert.ok(!JSON.stringify(listed).includes(t.access));
    assert.equal((await providersWithUsage(t.store, undefined))[0]?.usage, null);
  });
});
