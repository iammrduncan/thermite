import { z } from "zod";
import type { Route } from "../route.ts";

/**
 * Control's API for the dashboard's own screens (goal 243): the owner's session, and the reads of
 * Home and of a run's Overview. The dashboard is a web app that reaches control through these and
 * the other routes of this folder, and through nothing else. The owner's routes: the session's
 * cookie, or the owner's token.
 *
 * Every word a screen shows of a state, a verdict or an event is in these answers: control words
 * them, and the app shows them.
 */

/**
 * The header a signed-in page sends its session's token in with every change (any method but GET
 * and HEAD). A request another site made the browser send can't carry it.
 */
export const SESSION_TOKEN_HEADER = "x-thermite-session-token";

/** Where the app is served, until it replaces the pages at /ui (goal 253). */
export const APP_PATH = "/next";

/** Which of the four state colours a thing takes; `none` is grey. */
export const Tone = z.enum(["good", "needs", "wrong", "working", "none"]);
export type Tone = z.infer<typeof Tone>;

/** A state as a screen shows it: control's word for it, and its colour. */
export const StateWord = z.looseObject({ word: z.string(), tone: Tone });
export type StateWord = z.infer<typeof StateWord>;

const SessionAnswer = z.looseObject({
  signed_in: z.boolean(),
  /** The session's token for changes (SESSION_TOKEN_HEADER); none when not signed in. */
  token: z.string().optional(),
  /** Days a session lasts without use. */
  session_days: z.number(),
  /** Control's own build. */
  control: z.looseObject({ version: z.string(), commit: z.string().nullable() }),
});
export type SessionAnswer = z.infer<typeof SessionAnswer>;

/** Whether this browser is signed in, with the session's token for changes. Needs no sign-in. */
export const SESSION = {
  method: "GET",
  path: "/v1/session",
  what: "the dashboard's session",
  answer: SessionAnswer,
} as const satisfies Route;

/** Signs in with the owner's token: the answer sets the session's cookie. */
export const SESSION_START = {
  method: "POST",
  path: "/v1/session",
  what: "the sign-in",
  body: z.strictObject({ token: z.string().min(1).max(512) }),
  answer: SessionAnswer,
  maxBytes: 8 * 1024,
} as const satisfies Route;

/** Signs out: the session ends on control. */
export const SESSION_END = {
  method: "DELETE",
  path: "/v1/session",
  what: "the sign-out",
  answer: z.looseObject({ ok: z.literal(true) }),
} as const satisfies Route;

/** Where a thing is: each part it has, by name. */
const Where = z.looseObject({
  campaign: z.string().nullable(),
  run: z.string().nullable(),
  rig: z.string().nullable(),
  lane: z.string().nullable(),
  attempt: z.string().nullable(),
});

/** Something that waits for the owner, as one row. */
const NeedRow = z.looseObject({
  key: z.string(),
  kind: z.string(),
  tone: Tone,
  /** One or two words for the kind of decision. */
  label: z.string(),
  /** What it is about, in one sentence. */
  headline: z.string(),
  /** Why it waits for the owner. */
  why: z.string(),
  where: Where,
  /** Since when it waits; none when control does not know. */
  since: z.string().nullable(),
  /** Its page on the dashboard at /ui, until its own page is built in the app (goal 246). */
  page: z.string(),
});
export type NeedRow = z.infer<typeof NeedRow>;

/** What one agent of a run does now. */
const NowLine = z.looseObject({
  /** Who: a lane, the judge, the planner, the writer. */
  who: z.string(),
  text: z.string(),
  /** Since when; none for an agent that waits. */
  since: z.string().nullable(),
  /** True when it is at work; false when it waits or is idle. */
  busy: z.boolean(),
  tone: Tone,
});
export type NowLine = z.infer<typeof NowLine>;

/** A run's result so far, as its mode counts it. */
const Figure = z.looseObject({
  /** The headline: "+23.7%", "4/9 goals", "112 verified claims"; none before the first result. */
  text: z.string().nullable(),
  /** A hill climb's champions, oldest first: each one's gain over the starting point. */
  steps: z.array(z.looseObject({ seq: z.number(), at: z.string(), gain: z.number() })),
  /** A goal run's goals, in the contract's order. */
  goals: z.array(z.looseObject({ goal: z.string(), state: StateWord, reasons: z.string() })),
});
export type Figure = z.infer<typeof Figure>;

/** A run, as a row of a list. */
const RunRow = z.looseObject({
  campaign: z.string(),
  run: z.string(),
  rig: z.string(),
  mode: z.string().nullable(),
  /** The mode in words: "hill climb", "goal", "research". */
  mode_words: z.string(),
  state: StateWord,
  /** True for a run with no agents: the judge alone works on it. */
  judge_only: z.boolean(),
  figure: Figure,
  /** The current champion's number; none before the first. */
  champion: z.number().nullable(),
  started_at: z.string().nullable(),
  now: z.array(NowLine),
  /** How many things of this run wait for the owner. */
  needs: z.number(),
});
export type RunRow = z.infer<typeof RunRow>;

/** Something that happened, as one sentence. */
const EventRow = z.looseObject({
  at: z.string(),
  tone: Tone,
  text: z.string(),
  rig: z.string(),
  campaign: z.string().nullable(),
  run: z.string().nullable(),
  attempt: z.string().nullable(),
});
export type EventRow = z.infer<typeof EventRow>;

/** A campaign in the navigation. */
const NavCampaign = z.looseObject({
  name: z.string(),
  mode: z.string().nullable(),
  state: StateWord,
  /** The folder it is in; none at the top. */
  folder: z.string().nullable(),
  /** Its newest run, which its row opens; none for a campaign with no run. */
  run: z.string().nullable(),
});
export type NavCampaign = z.infer<typeof NavCampaign>;

const HomeAnswer = z.looseObject({
  at: z.string(),
  counts: z.looseObject({
    needs: z.number(),
    running: z.number(),
    judging: z.number(),
    queued: z.number(),
    rigs: z.number(),
    /** Rigs that should report and do not. */
    offline: z.number(),
  }),
  needs: z.array(NeedRow),
  at_work: z.array(RunRow),
  happened: z.array(EventRow),
  nav: z.looseObject({ campaigns: z.array(NavCampaign), folders: z.array(z.string()) }),
});
export type HomeAnswer = z.infer<typeof HomeAnswer>;

/**
 * Home, and what the navigation shows on every screen: what needs the owner, what is at work,
 * what happened, and the campaigns.
 */
export const HOME = {
  method: "GET",
  path: "/v1/home",
  what: "Home",
  answer: HomeAnswer,
} as const satisfies Route;

/** One fact of a run, as a label and its value in words. */
const Fact = z.looseObject({ label: z.string(), value: z.string() });

const RunOverviewAnswer = z.looseObject({
  at: z.string(),
  row: RunRow,
  /** The run's state in one or two sentences. */
  said: z.string(),
  /** Why nothing is at work, when the run is running and nothing is; none otherwise. */
  held: z.string().nullable(),
  needs: z.array(NeedRow),
  /** A hill climb's main metric: its name, its unit and which way is better. */
  metric: z
    .looseObject({ name: z.string(), unit: z.string().nullable(), better: z.string() })
    .nullable(),
  /** A research run's questions, each with its answer's state. */
  questions: z.array(
    z.looseObject({
      index: z.number(),
      question: z.string(),
      state: StateWord,
      answer: z.string(),
    }),
  ),
  facts: z.array(Fact),
  recent: z.array(EventRow),
  /** The run's page on the dashboard at /ui, for what is not built in the app yet. */
  page: z.string(),
});
export type RunOverviewAnswer = z.infer<typeof RunOverviewAnswer>;

/** A run's Overview: its state in words, its result, what each agent does now, what happened. */
export const RUN_OVERVIEW = {
  method: "GET",
  path: "/v1/runs/:run/overview",
  what: "a run's overview",
  answer: RunOverviewAnswer,
} as const satisfies Route;

/**
 * The stream of changes, as Server-Sent Events: `changed` each time what the screens read has
 * changed, so a screen reads again, and `beat` every STREAM_BEAT_MS, so a dropped stream shows.
 */
export const STREAM_PATH = "/v1/stream";
/** How often the stream says it is alive, in milliseconds. */
export const STREAM_BEAT_MS = 15_000;
