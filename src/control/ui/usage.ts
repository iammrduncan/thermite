import { PLAN_PROVIDER_TYPES } from "../../core/agents.ts";
import {
  isFree,
  type ModelPrice,
  startOfDay,
  sumUsage,
  type UsageCost,
  type UsageReport,
  type UsageRow,
  type UsageSums,
} from "../../core/usage.ts";
import { HARNESS_NAMES } from "../rigs/index.ts";
import type { Harness, ProviderModel } from "../store/index.ts";
import { esc, icon, infoLabel, modeAvatar } from "./components/index.ts";
import { campaignHref } from "./urls.ts";

/**
 * Model use and cost on the dashboard (goal 075, as the owner approved the mockup `v010-usage`):
 * at the top of a run's page (one line and two cards) with the details on its Stats tab, in a
 * campaign page's sidebar, on the Metrics page, and one table of model prices in Settings ›
 * Providers. Every number comes from control's sums of the records that code made at each call
 * (control/usage.ts); a figure no record reports says "not reported", a cost with no price known
 * says "no price", and a subscription's calls "on a plan": never 0.
 */

// ---------------------------------------------------------------- words and numbers

/** Tokens in few figures: 846, 8.4k, 846k, 41.6M, 120M. */
export const tok = (n: number) =>
  n >= 1e8
    ? `${Math.round(n / 1e6)}M`
    : n >= 0.9995e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e4
        ? `${Math.round(n / 1e3)}k`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)}k`
          : `${Math.round(n)}`;
/** US dollars with cents; an amount under half a cent is "<$0.01", never $0.00. */
export const usd = (x: number) =>
  x > 0 && x < 0.005
    ? "<$0.01"
    : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pc = (x: number) => (x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
/** A time in calls: 40 s, 12 m, 5 h 36 m, 140 h. */
export const dur = (ms: number) => {
  const s = ms / 1000;
  const m = Math.round(s / 60);
  if (m < 1) return `${Math.round(s)} s`;
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return h < 100 ? `${h} h ${m % 60} m` : `${h} h`;
};
const ii = (tip: string) => `<i class="ii" tabindex="0" data-tip="${esc(tip)}">i</i>`;
const NR = `<span class="nr">not reported</span>`;
const list = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

const TIP = {
  use: "Every model call of the agents, counted by code at the call: the rig's harness for the work, the supervisor for the advisors. Agents can't change these numbers. “not reported”: the harness does not give that number. REST and MCP give the same numbers.",
  in: "Tokens sent to the model. Cached: the provider read them from its cache. Not cached: the provider read them again. Not reported: the harness does not say which.",
  out: "Tokens the model wrote, with its reasoning. Under it: the reasoning tokens, where the provider counts them.",
  inOut:
    "In: tokens sent to the model. Cached: the provider read them from its cache. Not cached: the provider read them again. Not reported: the harness does not say which. Out: tokens the model wrote, with its reasoning. Each model's are on the Stats tab.",
  speed:
    "Tokens out a second over each call's whole time, from the request to the last token. The big number is the median of the calls. p10–p90: 8 of 10 calls are in this range. Each model's own speed is in the table.",
  time: "All calls added together, from the request to the last token. Calls at the same time each count. Under it: the median time to the first token.",
  model: "The model, then the harness that ran it and the provider that served it.",
  tin: "Tokens in: all that was sent to the model.",
  cached: "Tokens in that the provider read from its cache.",
  notCached: "Tokens in that the provider read again.",
  tout: "Tokens out, with reasoning.",
  tps: "Tokens out a second: the median of the calls. Under it: p10–p90.",
  share: "This line's tokens in and out, as a part of all of them.",
  cshare:
    "The part of tokens in that the provider read from its cache. Where a harness does not report it, the part is of the tokens that were reported; the i says how many were not.",
  cost: "Tokens times the model's price. “on a plan”: a subscription. “no price”: none is known. An i says what the number leaves out or adds.",
  clock:
    "Trials done, rounds, the run's time since it started (to its end, once it is finished), and the time in model calls. The time in calls adds all calls together, from the request to the last token: calls at the same time each count. Code counts every call; agents can't change these numbers. REST and MCP give the same numbers.",
  runSpeed:
    "Tokens out a second over each call's whole time, from the request to the last token. The big number is the median of the calls. p10–p90: 8 of 10 calls are in this range. Each model's own speed is on the Stats tab.",
};
const costTip = (gpu: string) =>
  `Tokens times each model's price for a million tokens: in, cached in, out. Prices: Settings › Providers. “on a plan”: a subscription; its tokens are counted, not priced. “no price”: none is known, so it is never $0. GPU time on RunPod: ${gpu}.`;

/**
 * Each agent in words (goal 074), and the line under it: the teachers' merged by model, and the
 * synthesizer's answer cards (goal 117).
 */
const AGENT: Record<string, [string, string]> = {
  workers: ["Workers", ""],
  planner: ["Planner", ""],
  teachers: ["Teachers", ""],
  merged_by: ["Teachers", "merged by"],
  auditor: ["Auditor", ""],
  review_panel: ["Review panel", ""],
  synthesizer: ["Synthesizer", "answer cards"],
  final_writer: ["Final writer", "research paper"],
};
const WORK = new Set(["workers", "planner"]);
export const harnessWord = (h: string) => HARNESS_NAMES[h as Harness] ?? h;
/** A model's line under its name: the harness and the provider (none: the rig's own settings). */
const routeLine = (harness: string, provider: string | null) =>
  provider ? `${harnessWord(harness)} · ${provider}` : harnessWord(harness);

const tokensOf = (s: UsageSums) => s.tokens_in + s.tokens_out;
/** Tokens in of the records that do not report the cache. */
const unreported = (s: UsageSums) => s.tokens_in - (s.cached_in ?? 0) - (s.uncached_in ?? 0);
/** The harnesses of the lines whose records leave a figure out, by their words. */
const harnessesWhere = (
  lines: readonly ({ harness: string } & UsageSums)[],
  test: (s: UsageSums) => boolean,
) => [...new Set(lines.filter(test).map((l) => harnessWord(l.harness)))];

// ---------------------------------------------------------------- cells

/** Tokens in, cached or not cached; with an i when some records do not report the cache. */
function cacheCell(s: UsageSums, part: "cached_in" | "uncached_in"): string {
  const v = s[part];
  if (v === null) return NR;
  const u = unreported(s);
  return u > 0
    ? `${ii(`${tok(u)} of ${tok(s.tokens_in)} tokens in: not reported, so not in this number.`)}${tok(v)}`
    : tok(v);
}

/** The part of tokens in that was cached; where some were not reported, the part of the rest. */
function cachedShareCell(s: UsageSums, by: string[]): string {
  const u = unreported(s);
  const rep = s.tokens_in - u;
  if (s.cached_in === null || rep <= 0) return NR;
  const p = pc(s.cached_in / rep);
  if (!u) return p;
  // The i goes before the number, so the numbers stay in line.
  return `${ii(`${tok(u)} of ${tok(s.tokens_in)} tokens in: not reported by ${list(by) || "a harness"}. Of the rest, ${p} was cached.`)}${u > rep ? NR : p}`;
}

/** Calls; "not reported" where no record says, and an i where some do not. */
function callsCell(s: UsageSums): string {
  if (s.records && s.calls_not_reported === s.records) return NR;
  return s.calls_not_reported
    ? `${ii(`${int(s.calls_not_reported)} records do not say how many calls they cover (a Codex turn): counted as none.`)}${int(s.calls)}`
    : int(s.calls);
}

function speedCell(s: UsageSums): string {
  const v = s.out_per_s;
  return v
    ? `${Math.round(v.median)}<span class="us">${Math.round(v.p10)}–${Math.round(v.p90)}</span>`
    : NR;
}

const shareCell = (x: number) =>
  `<span class="ush"><span>${pc(x)}</span><i><b style="width:${Math.max(1, x * 100).toFixed(1)}%"></b></i></span>`;

/** What a cost leaves out or adds, for its i. */
function costNotes(c: UsageCost, guessBy: string[]): string[] {
  return [
    c.pod_usd ? `With ${usd(c.pod_usd)} of GPU time on RunPod.` : "",
    c.priced_as_not_cached
      ? `${tok(c.priced_as_not_cached)} tokens in priced as not cached: ${list(guessBy) || "the harness"} ${guessBy.length > 1 ? "do" : "does"} not report cached tokens.`
      : "",
    c.on_plan ? `Not in it: ${tok(c.on_plan_tokens)} tokens on a plan.` : "",
    c.no_price ? `Not in it: ${tok(c.no_price_tokens)} tokens with no price.` : "",
    c.free ? `${tok(c.free_tokens)} tokens free.` : "",
  ].filter(Boolean);
}
const WORD = { none: "no price", plan: "on a plan", free: "free" } as const;
/** The dollars of a cost, and whether it has any to show (a price, even of 0 tokens, or a pod). */
const paidOf = (c: UsageCost) => {
  const paid = c.input_usd + c.cached_input_usd + c.output_usd + (c.pod_usd ?? 0);
  return { paid, shown: paid > 0 || c.priced > c.free || c.pod_usd !== null };
};
/** The one word for a cost with no dollars: no price first, then on a plan, then free. */
const kindsOf = (c: UsageCost) =>
  (["none", "plan", "free"] as const).filter(
    (k) => (k === "none" ? c.no_price : k === "plan" ? c.on_plan : c.free) > 0,
  );

/** A cost cell: dollars, or one word where nothing has dollars. An i, before it, says what it leaves out. */
export function costCell(c: UsageCost, guessBy: string[] = []): string {
  const { paid, shown } = paidOf(c);
  const notes = costNotes(c, guessBy);
  if (shown) return notes.length ? `${ii(notes.join(" "))}${usd(paid)}` : usd(paid);
  const kinds = kindsOf(c);
  const word = `<span class="nr">${WORD[kinds[0] ?? "none"]}</span>`;
  return kinds.length > 1 ? `${ii(notes.join(" "))}${word}` : word;
}

/**
 * The cost tile's body: dollars, split into in, cached in, out and GPU time; then the tokens with
 * no dollars, except on a card that stays brief (the owner, 2026-10-25: the detail is on Stats).
 */
function costParts(c: UsageCost, guessBy: string[], brief = false): string {
  const { paid, shown } = paidOf(c);
  const pod = c.pod_usd ?? 0;
  const seg = (cls: string, v: number) =>
    v > 0 ? `<i class="${cls}" style="width:${((v / paid) * 100).toFixed(2)}%"></i>` : "";
  const lg = (cls: string, v: number, word: string) =>
    v > 0 ? `<span><i class="${cls}"></i><b>${usd(v)}</b>${word}</span>` : "";
  const left = [
    c.on_plan ? `${tok(c.on_plan_tokens)} tokens on a plan` : "",
    c.no_price ? `${tok(c.no_price_tokens)} no price` : "",
    c.free ? `${tok(c.free_tokens)} free` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const guess = c.priced_as_not_cached
    ? ii(
        `${tok(c.priced_as_not_cached)} tokens in priced as not cached: ${list(guessBy) || "the harness"} ${guessBy.length > 1 ? "do" : "does"} not report cached tokens.`,
      )
    : "";
  const v = shown ? usd(paid) : `<span class="nr">${WORD[kindsOf(c)[0] ?? "none"]}</span>`;
  return `<div class="v">${v}</div>${
    paid > 0
      ? `<div class="usplit">${seg("n", c.input_usd)}${seg("c", c.cached_input_usd)}${seg("o", c.output_usd)}${seg("g", pod)}</div><div class="ulg">${lg("n", c.input_usd, "in")}${lg("c", c.cached_input_usd, "cached in")}${lg("o", c.output_usd, "out")}${lg("g", pod, "GPU time on RunPod")}</div>`
      : ""
  }${!brief && (left || guess) ? `<div class="s">${guess}${left}</div>` : ""}`;
}

// ---------------------------------------------------------------- the six numbers

interface Calls {
  tip: string;
  sub: string;
  bars: number[];
}

/** Cost, tokens in with their split, tokens out, calls with a bar for each round, hour or day, speed, time. */
function tiles(
  t: UsageSums,
  o: { costTip: string; guessBy: string[]; unrepBy: string[]; calls: Calls },
): string {
  const cached = t.cached_in ?? 0;
  const notCached = t.uncached_in ?? 0;
  const unrep = unreported(t);
  const seg = (cls: string, v: number) =>
    v > 0 && t.tokens_in > 0
      ? `<i class="${cls}" style="width:${((v / t.tokens_in) * 100).toFixed(2)}%"></i>`
      : "";
  const lg = (cls: string, v: number, word: string) =>
    v > 0 ? `<span><i class="${cls}"></i><b>${tok(v)}</b>${word}</span>` : "";
  const max = Math.max(...o.calls.bars, 1);
  const speed = t.out_per_s;
  const timeNote =
    t.call_ms !== null && t.not_reported.time
      ? ii(`${int(t.not_reported.time)} records do not report their time: not in this number.`)
      : "";
  return `<div class="ufacts">
<div class="fact uf-wide uf-cost"><div class="k">${infoLabel("Cost", o.costTip)}</div>${costParts(t.cost, o.guessBy)}</div>
<div class="fact uf-wide uf-in"><div class="k">${infoLabel("Tokens in", TIP.in)}</div><div class="v">${tok(t.tokens_in)}</div><div class="usplit">${seg("c", cached)}${seg("n", notCached)}${seg("r", unrep)}</div><div class="ulg">${lg("c", cached, "cached")}${lg("n", notCached, "not cached")}${lg("r", unrep, `not reported${o.unrepBy.length ? ` by ${list(o.unrepBy)}` : ""}`)}</div></div>
<div class="fact"><div class="k">${infoLabel("Tokens out", TIP.out)}</div><div class="v">${tok(t.tokens_out)}</div><div class="s">${t.reasoning ? `${tok(t.reasoning)} reasoning` : "&nbsp;"}</div></div>
<div class="fact"><div class="k">${infoLabel("Calls", o.calls.tip)}</div><div class="v">${t.records && t.calls_not_reported === t.records ? NR : int(t.calls)}</div><div class="s">${t.calls_not_reported && t.calls_not_reported < t.records ? ii(`${int(t.calls_not_reported)} records do not say how many calls they cover (a Codex turn): counted as none.`) : ""}${o.calls.sub || "&nbsp;"}</div>${o.calls.bars.length > 1 ? `<div class="uspark" aria-hidden="true">${o.calls.bars.map((b) => `<i style="height:${b > 0 ? Math.max(8, (b / max) * 100).toFixed(0) : 0}%"></i>`).join("")}</div>` : ""}</div>
<div class="fact"><div class="k">${infoLabel("Output speed", TIP.speed)}</div><div class="v">${speed ? `${Math.round(speed.median)}<span class="u"> tok/s</span>` : NR}</div><div class="s">${speed ? `p10–p90 ${Math.round(speed.p10)}–${Math.round(speed.p90)}` : "&nbsp;"}</div></div>
<div class="fact"><div class="k">${infoLabel("Time in calls", TIP.time)}</div><div class="v">${t.call_ms === null ? NR : dur(t.call_ms)}</div><div class="s">${timeNote}${t.first_token_ms === null ? "&nbsp;" : `first token ${(t.first_token_ms / 1000).toFixed(1)} s`}</div></div>
</div>`;
}

const th = (text: string, tip = "", cls = "") =>
  `<th${cls ? ` class="${cls}"` : ""}>${tip ? infoLabel(text, tip) : esc(text)}</th>`;

// ---------------------------------------------------------------- bars

/** Calls in each span that starts at an edge (ascending, ms); a record before the first goes to the first. */
export function bars(rows: readonly Pick<UsageRow, "at" | "calls">[], edges: number[]): number[] {
  const out = edges.map(() => 0);
  if (!edges.length) return out;
  for (const r of rows) {
    const t = Date.parse(r.at);
    let lo = 0;
    let hi = edges.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((edges[mid] as number) <= t) lo = mid;
      else hi = mid - 1;
    }
    // A record that does not say how many calls it covers (a Codex turn) counts as one.
    out[lo] = (out[lo] as number) + (r.calls ?? 1);
  }
  return out;
}

/** The start of each day in a time zone, from the day of `from` to the day of `now`. */
export function dayEdges(from: number, now: number, tz: string): number[] {
  const out: number[] = [];
  let d = startOfDay(from, tz);
  // A day is 23 to 25 hours long: 26 hours after a day's start is always in the next day.
  while (d <= now && out.length < 10_000) {
    out.push(d);
    d = startOfDay(d + 26 * 3_600_000, tz);
  }
  return out;
}

// ---------------------------------------------------------------- a run: its top and its Stats tab

export interface RunUsage {
  report: UsageReport;
  rows: readonly UsageRow[];
  /** When each of its rounds started (ISO), oldest first. */
  roundStarts: readonly string[];
  /** Its finished trials and its rounds, as its run view counts them. */
  trials: number;
  rounds: number;
  /** The run's time: since it started, to now or to its end once it is finished; null: not known. */
  wallMs: number | null;
  rig: string;
  /** A RunPod rig's price an hour now (null: not known); none: not on RunPod. */
  pod?: { perHour: number | null } | undefined;
  /** For the teachers' lines: "teacher 1" or "teacher 2", from the rig's settings; "" when not known. */
  teacher: (provider: string | null, model: string) => string;
  /** A hill climb's champion card, left of Cost (goal 142); empty for another mode. */
  champion?: string | undefined;
}

/** Nothing to show yet: no record, and no pod spend. */
const noUse = (t: UsageSums) => !t.records && t.cost.pod_usd === null;

/** Tokens in (cached, not cached, not reported) and out together, and the output speed, in one card. */
function tokensCard(t: UsageSums, unrepBy: string[], speedTip: string): string {
  const cached = t.cached_in ?? 0;
  const notCached = t.uncached_in ?? 0;
  const unrep = unreported(t);
  const seg = (cls: string, v: number) =>
    v > 0 && t.tokens_in > 0
      ? `<i class="${cls}" style="width:${((v / t.tokens_in) * 100).toFixed(2)}%"></i>`
      : "";
  const lg = (cls: string, v: number, word: string) =>
    v > 0 ? `<span><i class="${cls}"></i><b>${tok(v)}</b>${word}</span>` : "";
  const speed = t.out_per_s;
  return `<div class="fact uf-tok"><div class="utok">
<div><div class="k">${infoLabel("Tokens", TIP.inOut)}</div><div class="v">${tok(t.tokens_in)}<span class="u"> in · </span>${tok(t.tokens_out)}<span class="u"> out</span></div><div class="usplit">${seg("c", cached)}${seg("n", notCached)}${seg("r", unrep)}</div><div class="ulg">${lg("c", cached, "cached")}${lg("n", notCached, "not cached")}${lg("r", unrep, `not reported${unrepBy.length ? ` by ${list(unrepBy)}` : ""}`)}</div></div>
<div><div class="k">${infoLabel("Output speed", speedTip)}</div><div class="v">${speed ? `${Math.round(speed.median)}<span class="u"> tok/s</span>` : NR}</div><div class="s">${speed ? `p10–p90 ${Math.round(speed.p10)}–${Math.round(speed.p90)}` : "&nbsp;"}</div></div>
</div></div>`;
}

/**
 * The top of a run's page, above its tabs (the owner, 2026-10-21: keep it small): one line with
 * its trials, rounds, time and time in calls, then two cards, Cost and the tokens; a hill climb's
 * champion card comes first (goal 142). The calls and
 * the table by agent and model are on its Stats tab.
 */
export function runUsageTop(u: RunUsage): string {
  const t = u.report.total;
  const lines = u.report.by_agent_model;
  const none = noUse(t);
  const calls = none
    ? "no model call yet"
    : t.call_ms !== null
      ? `${dur(t.call_ms)} in calls`
      : t.records
        ? "time in calls not reported"
        : "";
  const parts = [
    `${int(u.trials)} trial${u.trials === 1 ? "" : "s"}`,
    `${int(u.rounds)} round${u.rounds === 1 ? "" : "s"}`,
    u.wallMs === null ? "" : dur(u.wallMs),
    calls,
  ].filter(Boolean);
  const tip = `${TIP.clock}${t.call_ms !== null && t.not_reported.time ? ` ${int(t.not_reported.time)} records do not report their time: not in the time in calls.` : ""}`;
  const line = `<div class="u-clock">${icon.clock}<span>${parts.join(" · ")}</span>${ii(tip)}</div>`;
  const champ = u.champion ?? "";
  if (none)
    return `<div class="block" id="model-use">${line}${champ ? `<div class="u-two u-three">${champ}</div>` : ""}</div>`;
  const guessBy = harnessesWhere(lines, (s) => s.cost.priced_as_not_cached > 0);
  return `<div class="block" id="model-use">${line}
<div class="u-two${champ ? " u-three" : ""}">${champ}<div class="fact uf-cost"><div class="k">${infoLabel("Cost", costTip("the pod's spend while this run was at work"))}</div>${costParts(t.cost, guessBy, true)}</div>
${tokensCard(
  t,
  harnessesWhere(lines, (s) => unreported(s) > 0),
  TIP.runSpeed,
)}</div>
</div>`;
}

/** A run's Stats tab: its calls (in each round, in a trial, the first token) and the table by agent and model. */
export function runStatsTab(u: RunUsage): string {
  const r = u.report;
  const t = r.total;
  if (noUse(t))
    return `<div class="card"><div class="empty">No model call recorded yet. Code counts each call of the agents when it ends.</div></div>`;
  const lines = r.by_agent_model;
  const all = tokensOf(t);
  const teachers = lines.filter((l) => l.agent === "teachers");
  const row = (l: (typeof lines)[number]) => {
    const [word, under] = AGENT[l.agent] ?? [l.name, ""];
    const sub = under || (teachers.length > 1 ? u.teacher(l.provider, l.model) : "");
    const by = [harnessWord(l.harness)];
    return `<tr><td><b>${esc(word)}</b>${sub ? `<span class="us">${esc(sub)}</span>` : ""}<span class="us u-ph">${esc(l.model)}</span></td><td class="u-opt"><span class="u-m">${esc(l.model)}</span><span class="us">${esc(routeLine(l.harness, l.provider))}</span></td><td class="num u-opt">${callsCell(l)}</td><td class="num">${tok(l.tokens_in)}</td><td class="num">${cacheCell(l, "cached_in")}</td><td class="num u-opt">${cacheCell(l, "uncached_in")}</td><td class="num">${tok(l.tokens_out)}</td><td class="num">${speedCell(l)}</td><td class="num">${costCell(l.cost, by)}</td><td class="num u-opt">${shareCell(all > 0 ? tokensOf(l) / all : 0)}</td></tr>`;
  };
  const grp = (name: string, rows: string) =>
    rows ? `<tr class="grp"><td colspan="10">${esc(name)}</td></tr>${rows}` : "";
  const podUsd = t.cost.pod_usd;
  const gpu =
    podUsd !== null
      ? (() => {
          const per = u.pod?.perHour ?? null;
          const line = per ? `${dur((podUsd / per) * 3_600_000)} at ${usd(per)}/h` : "";
          return `<tr class="u-gpu"><td><b>GPU time on RunPod</b><span class="us u-ph">${esc(u.rig)}</span></td><td class="u-opt"><span class="u-m">${esc(u.rig)}</span>${line ? `<span class="us">${esc(line)}</span>` : ""}</td><td class="num u-opt"></td><td class="num"></td><td class="num"></td><td class="num u-opt"></td><td class="num"></td><td class="num"></td><td class="num">${usd(podUsd)}</td><td class="num u-opt"></td></tr>`;
        })()
      : "";
  const table = `<div class="card flat"><div class="utw"><table class="ut"><thead><tr>${th("Agent")}${th("Model", TIP.model, "u-opt")}${th("Calls", "", "num u-opt")}${th("In", TIP.tin, "num")}${th("Cached", TIP.cached, "num")}${th("Not cached", TIP.notCached, "num u-opt")}${th("Out", TIP.tout, "num")}${th("tok/s", TIP.tps, "num")}${th("Cost", TIP.cost, "num")}${th("Share", TIP.share, "num u-opt")}</tr></thead><tbody>${grp(
    "The work",
    lines
      .filter((l) => WORK.has(l.agent))
      .map(row)
      .join(""),
  )}${grp(
    "The advisors",
    lines
      .filter((l) => !WORK.has(l.agent))
      .map(row)
      .join(""),
  )}${grp("The rig", gpu)}</tbody></table></div></div>`;
  // Calls in each round: each record goes to the round that had started when it was made.
  const edges = u.roundStarts.map((x) => Date.parse(x)).filter(Number.isFinite);
  const workers = u.rows.filter((x) => x.agent === "workers");
  const trials = new Set(workers.map((x) => x.trial).filter(Boolean)).size;
  const perTrial = trials
    ? Math.round(workers.reduce((n, x) => n + (x.calls ?? 0), 0) / trials)
    : 0;
  const perRound = edges.length > 1 ? bars(u.rows, edges) : [];
  const max = Math.max(...perRound, 1);
  const sub = [
    perTrial ? `${int(perTrial)} a trial` : "",
    t.first_token_ms === null ? "" : `first token ${(t.first_token_ms / 1000).toFixed(1)} s`,
  ].filter(Boolean);
  const callsTip = `Model calls by all agents of this run. Under it: the workers' calls in a trial, and the median time to the first token.${perRound.length ? " The bars: calls in each round." : ""}`;
  const callsCard = t.records
    ? `<div class="fact u-calls"><div><div class="k">${infoLabel("Calls", callsTip)}</div><div class="v">${t.calls_not_reported === t.records ? NR : int(t.calls)}</div><div class="s">${t.calls_not_reported && t.calls_not_reported < t.records ? ii(`${int(t.calls_not_reported)} records do not say how many calls they cover (a Codex turn): counted as none.`) : ""}${sub.join(" · ") || "&nbsp;"}</div></div>${
        perRound.length
          ? `<div><div class="uspark" aria-hidden="true">${perRound.map((b) => `<i style="height:${b > 0 ? Math.max(8, (b / max) * 100).toFixed(0) : 0}%"></i>`).join("")}</div><div class="u-axis"><span>round 1</span><span>round ${perRound.length}</span></div></div>`
          : ""
      }</div>`
    : "";
  return `<div id="run-stats">${callsCard}
<div class="u-h">By agent and model</div>
${table}
</div>`;
}

// ---------------------------------------------------------------- a campaign: in its page's sidebar

export interface CampaignUsage {
  report: UsageReport;
  /** Each run's page and state, by rig and run; none: control has no view of it now. */
  run: (rig: string, run: string) => { href: string; state: string } | undefined;
}

/** A campaign's model use and cost, over all its runs: the totals and each run. */
export function campaignUsageBlock(u: CampaignUsage): string {
  const r = u.report;
  const t = r.total;
  const runs = r.by_run ?? [];
  const head = `<div class="head"><h2>Model use</h2>${ii(TIP.use)}<span class="right">${runs.length} run${runs.length === 1 ? "" : "s"}</span></div>`;
  if (!t.records && t.cost.pod_usd === null)
    return `<div class="block" id="camp-use">${head}<div class="card"><div class="empty">No model call recorded yet.</div></div></div>`;
  const mini = (k: string, tip: string, v: string, s: string) =>
    `<div><div class="k">${infoLabel(k, tip)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const unrepBy = harnessesWhere(r.by_model, (s) => unreported(s) > 0);
  const guessBy = harnessesWhere(r.by_model, (s) => s.cost.priced_as_not_cached > 0);
  const speed = t.out_per_s;
  const row = (x: (typeof runs)[number]) => {
    const v = u.run(x.rig, x.run);
    return `<tr><td>${v ? `<a href="${esc(v.href)}"><b>${esc(x.run)}</b></a>` : `<b>${esc(x.run)}</b>`}<span class="us">${esc(v ? `${v.state} · ${x.rig}` : `on ${x.rig}`)}</span></td><td class="num">${tok(x.tokens_in)}</td><td class="num">${tok(x.tokens_out)}</td><td class="num">${costCell(x.cost, guessBy)}</td></tr>`;
  };
  return `<div class="block" id="camp-use">${head}
<div class="card uside"><div class="uside-cost"><div class="k">${infoLabel("Cost", costTip("the pods' spend while its runs were at work"))}</div>${costParts(t.cost, guessBy, true)}</div>
<div class="umini">${mini("Tokens in", TIP.in, tok(t.tokens_in), `${cachedShareCell(t, unrepBy)} cached`)}${mini("Tokens out", TIP.out, tok(t.tokens_out), t.reasoning ? `${tok(t.reasoning)} reasoning` : "&nbsp;")}${mini("Calls", "Model calls by all agents of all its runs, on every rig. Under it: the time in calls, all added together.", t.records && t.calls_not_reported === t.records ? NR : int(t.calls), t.call_ms === null ? "&nbsp;" : `${dur(t.call_ms)} in calls`)}${mini("Output speed", TIP.speed, speed ? `${Math.round(speed.median)}<span class="u"> tok/s</span>` : NR, t.first_token_ms === null ? "&nbsp;" : `first token ${(t.first_token_ms / 1000).toFixed(1)} s`)}</div></div>
<div class="card flat u-runs"><table class="ut"><thead><tr>${th("Run")}${th("In", TIP.tin, "num")}${th("Out", TIP.tout, "num")}${th("Cost", TIP.cost, "num")}</tr></thead><tbody>${runs.map(row).join("")}</tbody></table></div>
<div class="u-more"><a href="/ui/metrics">By model, on Metrics ›</a></div>
</div>`;
}

// ---------------------------------------------------------------- the system: the Metrics page

export const METRICS_PERIODS = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["all", "All"],
] as const;

export interface MetricsInput {
  report: UsageReport;
  rows: readonly UsageRow[];
  /** The rigs whose pods spent in the period. */
  podRigs: string[];
  /** A campaign's mode, for its mark; null: not known. */
  mode: (campaign: string) => string | null;
  now: number;
}

/** The Metrics page's body: the period, the six numbers, by model and by campaign. */
export function metricsBody(m: MetricsInput): string {
  const r = m.report;
  const t = r.total;
  const tz = r.tz;
  const chips = METRICS_PERIODS.map(
    ([p, word]) =>
      `<a class="fchip${p === r.period ? " on" : ""}" href="/ui/metrics?period=${p}${tz !== "UTC" ? `&amp;tz=${encodeURIComponent(tz)}` : ""}">${esc(word)}</a>`,
  ).join("");
  const head = `<div class="head u-head"><h2>Model use</h2>${ii(TIP.use)}<span class="right u-per">${chips}</span></div>`;
  if (!t.records && t.cost.pod_usd === null)
    return `<div class="block">${head}<div class="card"><div class="empty">${r.period === "all" ? "No model call recorded yet. Code counts each call of the agents when it ends, on every rig." : "No model call in this period."}</div></div></div>`;
  const all = tokensOf(t);
  const unrepBy = harnessesWhere(r.by_model, (s) => unreported(s) > 0);
  const guessBy = harnessesWhere(r.by_model, (s) => s.cost.priced_as_not_cached > 0);
  // By model: each provider's model over every agent and harness that used it, summed from its
  // records (the report's by_model keeps each harness apart).
  const models = new Map<string, UsageRow[]>();
  for (const x of m.rows) {
    const k = JSON.stringify([x.provider, x.model]);
    const g = models.get(k);
    if (g) g.push(x);
    else models.set(k, [x]);
  }
  const byModel = [...models.values()]
    .map((rows) => ({ rows, s: sumUsage(rows) }))
    .sort((a, b) => tokensOf(b.s) - tokensOf(a.s))
    .map(({ rows, s }) => {
      const first = rows[0] as UsageRow;
      const harnesses = [...new Set(rows.map((x) => harnessWord(x.harness)))];
      const noCache = [
        ...new Set(rows.filter((x) => x.cached_in === null).map((x) => harnessWord(x.harness))),
      ];
      return `<tr><td><span class="u-m">${esc(first.model)}</span><span class="us">${esc([first.provider, harnesses.join(", ")].filter(Boolean).join(" · "))}</span></td><td class="num u-opt">${callsCell(s)}</td><td class="num">${tok(s.tokens_in)}</td><td class="num">${tok(s.tokens_out)}</td><td class="num">${cachedShareCell(s, noCache)}</td><td class="num">${speedCell(s)}</td><td class="num">${costCell(s.cost, noCache)}</td><td class="num u-opt">${shareCell(all > 0 ? tokensOf(s) / all : 0)}</td></tr>`;
    })
    .join("");
  const gpu =
    t.cost.pod_usd !== null
      ? `<tr class="u-gpu"><td><b>GPU time on RunPod</b><span class="us">${esc(m.podRigs.join(", "))}</span></td><td class="num u-opt"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num">${usd(t.cost.pod_usd)}</td><td class="num u-opt"></td></tr>`
      : "";
  // Each campaign's runs, from its records and its pods' spend.
  const runsOf = new Map<string, Set<string>>();
  for (const x of m.rows) {
    const k = String(x.campaign);
    const s = runsOf.get(k) ?? new Set<string>();
    s.add(JSON.stringify([x.rig, x.run]));
    runsOf.set(k, s);
  }
  const byCamp = (r.by_campaign ?? [])
    .map((c) => {
      const name = c.campaign;
      const runs = runsOf.get(String(name))?.size ?? 0;
      return `<tr><td>${name === null ? `<span class="muted">no campaign</span>` : `<a class="kname" href="${campaignHref(name)}">${modeAvatar(m.mode(name))}<b>${esc(name)}</b></a>`}</td><td class="num u-opt">${runs || ""}</td><td class="num u-opt">${callsCell(c)}</td><td class="num">${tok(c.tokens_in)}</td><td class="num">${tok(c.tokens_out)}</td><td class="num">${cachedShareCell(c, unrepBy)}</td><td class="num">${speedCell(c)}</td><td class="num">${costCell(c.cost, guessBy)}</td><td class="num u-opt">${shareCell(all > 0 ? tokensOf(c) / all : 0)}</td></tr>`;
    })
    .join("");
  // The bars: each hour of today, or each day (each week, past 62 days), in the viewer's zone.
  const hour = 3_600_000;
  let edges: number[] = [];
  let span = "";
  if (r.period === "today") {
    const from = Date.parse(String(r.since));
    for (let h = from; h <= m.now; h += hour) edges.push(h);
    span = `in each hour of today, from midnight in ${tz}`;
  } else {
    const first = r.since ? Date.parse(r.since) : Date.parse(m.rows[0]?.at ?? "");
    edges = Number.isFinite(first) ? dayEdges(first, m.now, tz) : [];
    span = `on each day, in ${tz}`;
    if (edges.length > 62) {
      edges = edges.filter((_, i) => i === 0 || (edges.length - 1 - i) % 7 === 6);
      span = `in each week, in ${tz}`;
    }
  }
  const campaigns = (r.by_campaign ?? []).length;
  const runs = new Set(m.rows.map((x) => JSON.stringify([x.rig, x.run]))).size;
  return `<div class="block">${head}
${tiles(t, {
  costTip: costTip(
    "the pods' spend in this period, also while no run was at work: that part is in no campaign",
  ),
  guessBy,
  unrepBy,
  calls: {
    tip: `Model calls by all agents of all runs.${edges.length > 1 ? ` The bars: calls ${span}.` : ""}`,
    sub: `${runs} run${runs === 1 ? "" : "s"} · ${campaigns} campaign${campaigns === 1 ? "" : "s"}`,
    bars: bars(m.rows, edges),
  },
})}
<div class="u-h">By model</div>
<div class="card flat"><div class="utw"><table class="ut"><thead><tr>${th("Model", TIP.model)}${th("Calls", "", "num u-opt")}${th("In", TIP.tin, "num")}${th("Out", TIP.tout, "num")}${th("Cached", TIP.cshare, "num")}${th("tok/s", TIP.tps, "num")}${th("Cost", TIP.cost, "num")}${th("Share", TIP.share, "num u-opt")}</tr></thead><tbody>${byModel}${gpu}</tbody></table></div></div>
${
  campaigns
    ? `<div class="u-h">By campaign</div>
<div class="card flat"><div class="utw"><table class="ut"><thead><tr>${th("Campaign")}${th("Runs", "", "num u-opt")}${th("Calls", "", "num u-opt")}${th("In", TIP.tin, "num")}${th("Out", TIP.tout, "num")}${th("Cached", TIP.cshare, "num")}${th("tok/s", TIP.tps, "num")}${th("Cost", TIP.cost, "num")}${th("Share", TIP.share, "num u-opt")}</tr></thead><tbody>${byCamp}</tbody></table></div></div>`
    : ""
}
</div>`;
}

/** A run's state in the campaign sidebar's words. */
export const runStateWord = (status: string) =>
  status === "running" ? "at work" : status === "paused" ? "paused" : "finished";

// ---------------------------------------------------------------- Model prices: Settings › Providers

/** A price field's number: empty, or dollars for a million tokens (up to 1,000,000). */
export const PRICE_NUMBER = /^(\d{1,7}(\.\d{0,6})?|\.\d{1,6})$/;

/** Why a row of prices can't be saved, in the same words on the page and from the server. */
export const PRICE_WORDS = {
  number: "a price is a number, such as 0.60.",
  pair: "set In and Out, or leave all three empty.",
} as const;

/** Provider types whose calls are on a plan: their models have no price. */
const PLAN_TYPES = new Set<string>(PLAN_PROVIDER_TYPES);

const MP_TIP = {
  model:
    "Each model of a provider with a model list. Subscriptions are not here: their calls are on a plan.",
  provider: "The provider that serves it, as in Providers above.",
  in: "Dollars for a million tokens in that the provider did not read from its cache.",
  cached:
    "Dollars for a million tokens in that the provider read from its cache. Empty: the In price.",
  out: "Dollars for a million tokens out, with reasoning.",
  from: "provider's list: the provider's model list gives it, and control keeps it up to date; it can't be changed here. yours: you set it, here or over REST or MCP. free: the list gives 0. no price: neither, so its calls show “no price”, never $0. A price you set or change costs the model's earlier calls too. To remove yours, empty its three fields.",
};

/** A price as text or in a field: cents at least (0.60), more places only where it has them. */
const priceText = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "";
  const short = Number(n.toFixed(6));
  return Number.isInteger(Math.round(short * 1e6) / 1e4) ? short.toFixed(2) : String(short);
};

/**
 * Model prices, under the providers in Settings › Providers (the owner, 2026-10-21: one plain
 * table, nothing nested): one row for each model of each provider that is not a subscription, in
 * US dollars for a million tokens, and where its price comes from. A listed price is text; any
 * other has three fields. One Save prices posts every field to POST /ui/settings/prices; the
 * page's script holds it until a price changes, and says why a row can't be saved.
 */
export function modelPricesBlock(o: {
  providers: readonly { name: string; type: string; models: readonly ProviderModel[] }[];
  /** The owner's prices. */
  owner: readonly { provider: string; model: string; price: ModelPrice }[];
  csrf: string;
  /** What the last Save did: saved a change, changed nothing, or refused (with why). */
  flash?: { kind: "saved" | "same" } | { kind: "bad"; text: string } | undefined;
}): string {
  const owner = new Map(o.owner.map((x) => [JSON.stringify([x.provider, x.model]), x.price]));
  const models = o.providers
    .filter((p) => !PLAN_TYPES.has(p.type))
    .flatMap((p) => p.models.map((m) => ({ p: p.name, m })));
  if (!models.length) return "";
  const text = (v: number | null) =>
    `<td class="num">${v === null ? `<span class="muted">–</span>` : priceText(v)}</td>`;
  let n = 0;
  const rows = models
    .map(({ p, m }) => {
      // The model, with its provider under it on a phone, and the provider's own column.
      const name = (hidden = "") =>
        `<td>${hidden}<span class="u-m">${esc(m.id)}</span><span class="us u-ph">${esc(p)}</span></td><td class="u-opt">${esc(p)}</td>`;
      if (m.price)
        return `<tr>${name()}${text(m.price.input)}${text(m.price.cached_input)}${text(m.price.output)}<td><span class="chip">${isFree(m.price) ? "free" : "provider's list"}</span></td></tr>`;
      const own = owner.get(JSON.stringify([p, m.id])) ?? null;
      const i = n++;
      const field = (k: "in" | "cached" | "out", label: string, v: number | null | undefined) =>
        `<td class="num"><input inputmode="decimal" maxlength="12" name="${k}${i}" data-pk="${k}" aria-label="${esc(`${label}, ${m.id} of ${p}`)}" value="${esc(priceText(v))}" placeholder="–"></td>`;
      return `<tr data-mp="${esc(`${m.id} of ${p}`)}">${name(`<input type="hidden" name="p${i}" value="${esc(p)}"><input type="hidden" name="m${i}" value="${esc(m.id)}">`)}${field("in", "In", own?.input)}${field("cached", "Cached in", own?.cached_input)}${field("out", "Out", own?.output)}<td>${own ? `<span class="chip info">yours</span>` : `<span class="chip warn">no price</span>`}</td></tr>`;
    })
    .join("");
  const f = o.flash;
  const flash = !f
    ? ""
    : f.kind === "bad"
      ? `<b class="bad">Not saved.</b> ${esc(f.text)}`
      : f.kind === "saved"
        ? `<b class="ok">Saved.</b> Every cost follows.`
        : "Nothing changed.";
  const th = (t: string, tip: string, cls = "") =>
    `<th${cls ? ` class="${cls}"` : ""}>${infoLabel(t, tip)}</th>`;
  return `<div class="block" id="model-prices"><div class="head"><h2>Model prices</h2><span class="right">$ for a million tokens</span></div>
<form method="post" action="/ui/settings/prices" data-mp-form><input type="hidden" name="csrf" value="${esc(o.csrf)}"><div class="card flat"><div class="utw"><table class="ut mp-t"><thead><tr>${th("Model", MP_TIP.model)}${th("Provider", MP_TIP.provider, "u-opt")}${th("In", MP_TIP.in, "num")}${th("Cached in", MP_TIP.cached, "num")}${th("Out", MP_TIP.out, "num")}${th("Price from", MP_TIP.from)}</tr></thead><tbody>${rows}</tbody></table></div></div>
${n || flash ? `<div class="pr-act">${n ? `<button class="primary" data-mp-save>Save prices</button>` : ""}<span class="small" data-mp-flash>${flash}</span></div>` : ""}
</form></div>`;
}
