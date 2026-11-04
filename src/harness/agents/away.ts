import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleLater, ConsoleNow, TrialConsole } from "../../agents/cli/index.ts";
import type { ModelConfig } from "../../agents/model/index.ts";
import { errorText } from "../../common/errors.ts";
import { log } from "../../common/log.ts";
import {
  LANE_CALL_MAX_BYTES,
  LANE_WAIT_MAX_MS,
  type LaneEvent,
  LaneWaitAnswer,
} from "../../core/api/harness/lanes.ts";
import type { TerminalInput } from "../../core/terminal-input.ts";
import type { CallUsage } from "../../core/usage.ts";
import { type DeviceLink, sendCommit } from "../judge/index.ts";
import { LedgerError } from "../ledger/index.ts";
import type { TrialLink } from "./programs.ts";
import type { LaneAway } from "./scheduler/index.ts";
import { TrialResult, type TrialSpec } from "./worker/index.ts";

/**
 * A lane whose trials run on a follower (goal 205, step 2): the leader's side. It sends the
 * parent commit, starts the trial there with its route, and waits for it, again and again: each
 * answer brings what the trial's program reported, which goes to the same TrialLink a trial on
 * the leader's own machine reports to, and the trial's calls for the leader's API, which are
 * passed to that API with the trial's own token and answered. Each wait carries the owner's
 * messages waiting for the trial, whether the rig drains, and a renewed key. A stop is passed on;
 * a follower that stops answering ends the trial, interrupted, and its experiment goes back to
 * the queue. A trial in its own terminal there has a console here whose screens, inputs and keys
 * go to the follower (AwayConsole).
 */

/** How long the follower may give no answer to the waits before the trial ends, interrupted. */
const FOLLOWER_GONE_MS = 5 * 60_000;
/** How long a stopped trial's end may take to come back before the leader gives it up. */
const STOP_MS = 2 * 60_000;

interface AwayOptions {
  machine: string;
  link: DeviceLink;
  /** The leader's mirror of a repository, by its name, and its scratch for bundles. */
  mirrorFor: (repo: string) => string;
  scratchDir: string;
  /** A run's workers' route now. */
  modelFor: (run: string) => ModelConfig | undefined;
  /** What a trial gives the harness, as for a trial on the leader's own machine. */
  trialLink: (
    spec: { trialId: string; run: string; lane: string },
    m: ModelConfig | undefined,
    signal: AbortSignal,
  ) => TrialLink;
  /** The leader's own API, which answers the trial's calls. */
  api: (req: Request) => Response | Promise<Response>;
  /** The tokens the follower's model proxy saw in the provider's answers to the trial. */
  proxySaw: (trial: string, tokens: unknown) => void;
  /** How long the follower may not answer before its trial ends (tests shorten it). */
  goneMs?: number | undefined;
}

/** A terminal's screen, as the follower's terminal host gives it. */
type Screen = { cols: number; rows: number; data: string };

/**
 * The owner's console into a trial's terminal on a follower (step 2e), as the leader's consoles
 * hold it: each screen, input and key is an ask of the follower, whose own console answers; what
 * its last screen said of the usage limit, the inputs waiting and a held line is kept for the
 * live view. An input that waits for the reset is told its outcome when the follower reports it.
 */
class AwayConsole {
  queued = 0;
  held: string | undefined;
  /** Its screen is a worker's Pi view. */
  piView = false;
  private shown: { resetsAt?: string | undefined } | undefined;
  private last: Screen | undefined;
  private readonly laters = new Map<string, ConsoleLater>();
  private readonly link: DeviceLink;
  private readonly trial: string;

  constructor(link: DeviceLink, trial: string) {
    this.link = link;
    this.trial = trial;
  }

  async input(
    i: Pick<TerminalInput, "text" | "keys" | "wait" | "follow_up">,
    later: ConsoleLater,
  ): Promise<ConsoleNow> {
    const id = randomUUID();
    this.laters.set(id, later);
    try {
      const r = (await this.link.ask({
        op: "trial_input",
        trial: this.trial,
        id,
        input: {
          ...(i.text !== undefined ? { text: i.text } : {}),
          ...(i.keys ? { keys: [...i.keys] } : {}),
          ...(i.follow_up ? { follow_up: true as const } : {}),
          wait: i.wait,
        },
      })) as { outcome?: string; until?: string };
      if (r.outcome === "queued") return { outcome: "queued", until: r.until };
      this.laters.delete(id);
      return { outcome: "typed" };
    } catch (err) {
      this.laters.delete(id);
      throw err;
    }
  }

  async keystrokes(data: string, typed: (line: string) => void): Promise<void> {
    try {
      const r = (await this.link.ask({ op: "trial_keys", trial: this.trial, data })) as {
        lines?: string[];
      };
      for (const line of r.lines ?? []) typed(line);
    } catch (err) {
      throw new LedgerError("conflict", errorText(err));
    }
  }

  async screen(): Promise<Screen | undefined> {
    const r = (await this.link.ask(
      { op: "trial_screen", trial: this.trial },
      { answerMs: 20_000 },
    )) as {
      screen?: Screen | null;
      limit?: { resetsAt?: string } | null;
      queued?: number;
      held?: string | null;
      pi_view?: boolean;
    };
    this.shown = r.limit ?? undefined;
    this.queued = r.queued ?? 0;
    this.held = r.held ?? undefined;
    this.piView = r.pi_view === true;
    if (r.screen) this.last = r.screen;
    return r.screen ?? undefined;
  }

  limit(): { resetsAt?: string | undefined } | undefined {
    return this.shown;
  }

  lastScreen(): Screen | undefined {
    return this.last;
  }

  /** The follower said what became of an input that waited. */
  later(id: string, outcome: "typed_after_reset" | "dropped", why?: string): void {
    this.laters.get(id)?.(outcome, why);
    this.laters.delete(id);
  }

  /** The trial ended there: its last screen, and nothing still waits for its outcome. */
  ended(screen: Screen | undefined): void {
    if (screen) this.last = screen;
    for (const later of this.laters.values()) later("dropped", "the trial has ended");
    this.laters.clear();
  }
}

/** A route as the follower takes it: with its key now, and nothing that is code. */
function routeOut(m: ModelConfig | undefined): Record<string, unknown> | undefined {
  if (!m) return undefined;
  const { keyNow, ...rest } = m;
  return { ...rest, apiKey: keyNow?.() ?? m.apiKey };
}

export class AwayLane implements LaneAway {
  readonly machine: string;
  private readonly o: AwayOptions;

  constructor(o: AwayOptions) {
    this.o = o;
    this.machine = o.machine;
  }

  async run(
    t: { spec: Omit<TrialSpec, "workspace" | "workspaceRoot">; repo: string },
    signal: AbortSignal,
  ): Promise<TrialResult> {
    const { spec, repo } = t;
    const trial = spec.trialId;
    const m = this.o.modelFor(spec.run);
    const link = this.o.trialLink(spec, m, signal);
    const none: TrialResult = {
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    // Its program in its own terminal there, as the rig says now, or headless (step 2e).
    const terminal = link.terminal === true;
    try {
      await sendCommit(this.o, repo, spec.parentCommit);
      const route = routeOut(m);
      await this.o.link.ask({
        op: "trial_start",
        spec: spec as never,
        repo,
        ...(route ? { route: route as never } : {}),
        terminal,
      });
    } catch (err) {
      return { ...none, error: `the trial could not start on ${this.machine}: ${errorText(err)}` };
    }
    const owner = terminal ? new AwayConsole(this.o.link, trial) : undefined;
    // The leader's consoles hold it as a trial's own console (its shape is the one they use).
    link.console?.(owner ? (owner as unknown as TrialConsole) : "headless");
    let seen = 0;
    let key = m?.keyNow?.() ?? m?.apiKey;
    let failingSince: number | undefined;
    let stoppedAt: number | undefined;
    const closers: (() => void)[] = [];
    const stop = () => {
      stoppedAt = Date.now();
      void this.o.link.ask({ op: "trial_stop", trial }).catch(() => undefined);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        if (stoppedAt !== undefined && Date.now() - stoppedAt > STOP_MS)
          return { ...none, stopped: "interrupted", error: `${this.machine} did not end it` };
        let answer: LaneWaitAnswer;
        try {
          const now = m?.keyNow?.() ?? m?.apiKey;
          const renewed = now !== key ? routeOut(m) : undefined;
          const raw = await this.o.link.ask(
            {
              op: "trial_wait",
              trial,
              seen,
              wait_ms: LANE_WAIT_MAX_MS,
              messages: (link.messages?.waiting() ?? []).slice(0, 200),
              draining: link.draining?.() ?? false,
              ...(renewed ? { route: renewed as never } : {}),
            },
            { answerMs: LANE_WAIT_MAX_MS + 60_000 },
          );
          if (renewed) key = now;
          answer = LaneWaitAnswer.parse(raw);
          failingSince = undefined;
        } catch (err) {
          failingSince ??= Date.now();
          if (Date.now() - failingSince > (this.o.goneMs ?? FOLLOWER_GONE_MS))
            return {
              ...none,
              stopped: "interrupted",
              error: `${this.machine} stopped answering: ${errorText(err)}`,
            };
          await new Promise((r) => setTimeout(r, Math.min(5000, this.o.goneMs ?? 5000)));
          continue;
        }
        for (const e of answer.events) {
          if (e.seq <= seen) continue;
          seen = e.seq;
          if (e.kind === "input_later") owner?.later(e.id, e.outcome, e.why);
          else this.apply(e, spec, link, closers);
        }
        if (answer.ended) {
          owner?.ended(answer.ended.screen);
          this.keepSession(spec, answer.ended.session, link);
          const r = TrialResult.safeParse(answer.ended.result);
          return r.success
            ? r.data
            : { ...none, error: `${this.machine} gave an end that is not a trial's` };
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      for (const close of closers) close();
    }
  }

  /** One report of the trial's program, given to the trial's link here. */
  private apply(
    e: LaneEvent,
    spec: Omit<TrialSpec, "workspace" | "workspaceRoot">,
    link: TrialLink,
    closers: (() => void)[],
  ): void {
    switch (e.kind) {
      case "live":
        link.live(e.entries);
        return;
      case "progress":
        link.progress(e.progress);
        return;
      case "wait":
        link.waiting?.(e.wait as Parameters<NonNullable<TrialLink["waiting"]>>[0]);
        return;
      case "given":
        link.messages?.given(e.ids, e.how as never);
        return;
      case "windows":
        link.usage?.(e.windows as never);
        return;
      case "model_usage":
        link.modelUsage?.(e.usage as CallUsage);
        return;
      case "sent":
        link.sent?.(e.prompt as never);
        return;
      case "compacted":
        link.compacted?.(e.harness as never, e.compaction as never);
        return;
      case "through_proxy":
        link.throughProxy?.();
        return;
      case "proxy_saw":
        this.o.proxySaw(spec.trialId, e.tokens);
        return;
      case "hand_over":
        closers.push(link.handOver(e.harness as never));
        return;
      case "call":
        void this.answer(spec, e);
        return;
      case "input_later":
        return;
    }
  }

  /** A call of the trial, passed to the leader's API with its own token, and its answer sent. */
  private async answer(
    spec: Omit<TrialSpec, "workspace" | "workspaceRoot">,
    e: Extract<LaneEvent, { kind: "call" }>,
  ): Promise<void> {
    let status = 502;
    let type = "application/json";
    let body = Buffer.from(JSON.stringify({ error: "the rig's leader could not answer" }));
    try {
      // Only the trial's own token: a follower calls for no other trial.
      if (e.auth !== `Bearer trial.${spec.token}`) {
        status = 401;
        body = Buffer.from(JSON.stringify({ error: "unauthorized" }));
      } else {
        const res = await this.o.api(
          new Request(`http://harness${e.path}${e.search}`, {
            method: e.method,
            headers: { authorization: e.auth, ...(e.type ? { "content-type": e.type } : {}) },
            ...(e.method === "GET" ? {} : { body: Buffer.from(e.body, "base64") }),
          }),
        );
        const got = Buffer.from(await res.arrayBuffer());
        if (got.length > LANE_CALL_MAX_BYTES)
          body = Buffer.from(JSON.stringify({ error: "the answer is too long for a follower" }));
        else {
          status = res.status;
          type = res.headers.get("content-type") ?? "";
          body = got;
        }
      }
    } catch (err) {
      log("harness", "a follower's trial call failed here", {
        machine: this.machine,
        trial: spec.trialId,
        path: e.path,
        error: errorText(err),
      });
    }
    await this.o.link
      .ask({
        op: "trial_answer",
        trial: spec.trialId,
        call: e.id,
        status,
        type,
        body: body.toString("base64"),
      })
      .catch((err) =>
        log("harness", "a trial call's answer did not reach its follower", {
          machine: this.machine,
          trial: spec.trialId,
          error: errorText(err),
        }),
      );
  }

  /** The trial's session log from the follower, kept here as a trial's own is. */
  private keepSession(
    spec: Omit<TrialSpec, "workspace" | "workspaceRoot">,
    files: { name: string; base64: string }[],
    link: TrialLink,
  ): void {
    if (!files.length || !link.keepSession) return;
    const dir = join(this.o.scratchDir, `session-${randomUUID()}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const kept = files.map((f, i) => {
        const path = join(dir, String(i));
        writeFileSync(path, Buffer.from(f.base64, "base64"), { mode: 0o600 });
        return { name: f.name, path };
      });
      link.keepSession(kept);
    } catch (err) {
      log("harness", "a follower's session log not kept", {
        trial: spec.trialId,
        error: errorText(err),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
