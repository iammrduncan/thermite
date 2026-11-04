import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { MessageInbox, TurnDelivery } from "../../agents/cli/index.ts";
import {
  type ModelConfig,
  type ProviderErrorAnswer,
  stallWords,
} from "../../agents/model/index.ts";
import { errorText } from "../../common/errors.ts";
import { log } from "../../common/log.ts";
import type { InTurn } from "../../core/agents.ts";
import type { LaneAsk, LaneEvent, LaneWaitAnswer } from "../../core/api/harness/lanes.ts";
import {
  laneCacheEnv,
  prepareWorkspace,
  type SubmitOutcome,
  type TrialLink,
  type TrialResult,
  type TrialSpec,
} from "../agents/index.ts";
import type { Role, Runner } from "../broker/index.ts";
import { ProviderAnswers } from "../service/index.ts";

/**
 * The trials of the lanes a follower holds (goal 205, step 2): the leader starts each here, with
 * its spec, its route and the parent commit it sent first. The follower makes the workspace, runs
 * the program headless as the lane's users with its own runner and dev runs, and keeps what the
 * program reports, in order, for the leader's next wait (core/api/harness/lanes.ts). A call of the
 * trial that needs the run's records waits here too until a wait takes it, and the leader's answer
 * comes back as an ask of its own. A trial whose leader stops asking ends, interrupted.
 */

/** How long a trial's call waits for the leader's answer before it fails. */
const CALL_MS = 10 * 60_000;
/** How long a running trial goes on without a wait from the leader before it is stopped. */
const LEADER_GONE_MS = 10 * 60_000;
/** How long an ended trial's end is kept for a wait whose answer was lost. */
const ENDED_KEPT_MS = 10 * 60_000;
/** The most bytes of one file of a trial's session log sent to the leader. */
const SESSION_FILE_MAX = 16 * 1024 * 1024;

/** What a call of the trial comes back with: the leader's API's answer. */
interface CallAnswer {
  status: number;
  type: string;
  body: Buffer;
}

type NewEvent = LaneEvent extends infer E ? (E extends LaneEvent ? Omit<E, "seq"> : never) : never;

/** One trial on the follower, from its start until the leader has its end. */
export interface Hosted {
  spec: Omit<TrialSpec, "workspace" | "workspaceRoot">;
  repo: string;
  /** The trial's route, with its key now; a renewed key replaces it. */
  route: ModelConfig | undefined;
  /** The workspace's folder once made: the lane's commands run only inside it. */
  root?: string | undefined;
  events: LaneEvent[];
  seq: number;
  calls: Map<string, { resolve: (a: CallAnswer) => void; timer: NodeJS.Timeout }>;
  /** The owner's messages waiting for the trial, as the leader's last wait said. */
  messages: { id: number; text: string }[];
  given: Set<number>;
  draining: boolean;
  submitted?: SubmitOutcome | undefined;
  turn?: TurnDelivery | undefined;
  session: { name: string; base64: string }[];
  ended?: { result: TrialResult; session: { name: string; base64: string }[] } | undefined;
  endedAt?: number | undefined;
  abort: AbortController;
  lastWait: number;
  wakers: (() => void)[];
}

interface LaneHostOptions {
  runner: Runner;
  scratchDir: string;
  /** The follower's mirror of a repository the leader sent commits for. */
  mirror(repo: string): string;
  /** The follower's API's port, which the trial's processes reach on loopback. */
  port: number;
  /** The program's run of a trial (agents/programs.ts); tests give their own. */
  runTrial(spec: TrialSpec, link: TrialLink): Promise<TrialResult>;
  /** The follower's dev runs, settled when a trial ends. */
  devRuns?: { settle(lane: string): Promise<void> } | undefined;
}

export class LaneHost {
  private readonly o: LaneHostOptions;
  private readonly trials = new Map<string, Hosted>();
  private readonly answers = new ProviderAnswers();
  private readonly watchdog: NodeJS.Timeout;

  constructor(o: LaneHostOptions) {
    this.o = o;
    // A trial whose leader stopped asking ends; an ended one is forgotten after a while.
    this.watchdog = setInterval(() => this.sweep(), 30_000);
    this.watchdog.unref?.();
  }

  /** Answers one of the leader's asks about a trial. */
  async ask(a: LaneAsk): Promise<object> {
    switch (a.op) {
      case "trial_start": {
        const id = a.spec.trialId;
        if (this.trials.has(id)) return { ok: true };
        if ([...this.trials.values()].some((t) => !t.ended && t.spec.lane === a.spec.lane))
          throw new LaneRefusal(`${a.spec.lane} already runs a trial here`);
        const h: Hosted = {
          spec: a.spec as unknown as Hosted["spec"],
          repo: a.repo,
          route: a.route as unknown as ModelConfig | undefined,
          events: [],
          seq: 0,
          calls: new Map(),
          messages: [],
          given: new Set(),
          draining: false,
          session: [],
          abort: new AbortController(),
          lastWait: Date.now(),
          wakers: [],
        };
        this.trials.set(id, h);
        void this.run(h);
        return { ok: true };
      }
      case "trial_wait": {
        const h = this.hosted(a.trial);
        h.lastWait = Date.now();
        h.messages = a.messages;
        h.draining = a.draining;
        if (a.route) h.route = a.route as unknown as ModelConfig;
        h.events = h.events.filter((e) => e.seq > a.seen);
        if (!h.events.length && !h.ended && a.wait_ms > 0)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, a.wait_ms);
            h.wakers.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        const answer: LaneWaitAnswer = {
          events: h.events,
          ...(h.ended ? { ended: { result: h.ended.result, session: h.ended.session } } : {}),
        };
        return answer;
      }
      case "trial_answer": {
        const h = this.hosted(a.trial);
        const c = h.calls.get(a.call);
        if (c) {
          h.calls.delete(a.call);
          clearTimeout(c.timer);
          c.resolve({ status: a.status, type: a.type, body: Buffer.from(a.body, "base64") });
        }
        return { ok: true };
      }
      case "trial_stop": {
        this.trials.get(a.trial)?.abort.abort();
        return { ok: true };
      }
    }
  }

  /** The open trial a token belongs to; undefined for any other. */
  byToken(token: string): Hosted | undefined {
    for (const h of this.trials.values()) if (!h.ended && h.spec.token === token) return h;
    return undefined;
  }

  /** Whether a trial still runs here (its dev runs start only then). */
  isOpen(trial: string): boolean {
    const h = this.trials.get(trial);
    return h !== undefined && !h.ended;
  }

  /**
   * A call of the trial for the leader's API: it waits for the leader's next wait, which takes
   * it, and for the leader's answer.
   */
  forward(
    h: Hosted,
    req: { method: string; path: string; search: string; type: string; auth: string; body: Buffer },
  ): Promise<CallAnswer> {
    if (h.ended) return Promise.resolve(refusal(409, "the trial has ended"));
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        h.calls.delete(id);
        resolve(refusal(504, "the rig's leader did not answer in time"));
      }, CALL_MS);
      timer.unref?.();
      h.calls.set(id, { resolve, timer });
      this.emit(h, {
        kind: "call",
        id,
        method: req.method as "GET",
        path: req.path,
        search: req.search,
        type: req.type,
        auth: req.auth,
        body: req.body.toString("base64"),
      });
    });
  }

  /** The leader took the trial's submission: the trial's program reads it from here. */
  submittedNow(h: Hosted, answer: unknown): void {
    const a = answer as Partial<SubmitOutcome> | undefined;
    if (a && typeof a.attempt === "string" && typeof a.lifecycle === "string")
      h.submitted = a as SubmitOutcome;
  }

  /** The owner's next message for the trial's hook or plugin, inside its turn. */
  turnOffer(h: Hosted, at: InTurn): { offer: string; text: string } | undefined {
    return h.turn?.offer(at);
  }

  turnTaken(h: Hosted, offer: string): number[] {
    return h.turn?.taken(offer) ?? [];
  }

  /** What the model proxy here saw of the trial's provider. */
  noteProviderAnswer(h: Hosted, a: ProviderErrorAnswer): void {
    this.answers.noteProviderAnswer(h.spec.trialId, a, Date.now());
  }

  noteStall(h: Hosted, ms: number): void {
    this.emit(h, {
      kind: "live",
      entries: [
        {
          kind: "status",
          text: `${stallWords(ms)}: retried. The harness broke the call off; the trial goes on in the same session.`,
        },
      ],
    });
  }

  proxySaw(h: Hosted, tokens: unknown): void {
    this.emit(h, { kind: "proxy_saw", tokens });
  }

  private hosted(trial: string): Hosted {
    const h = this.trials.get(trial);
    if (!h) throw new LaneRefusal(`no trial ${trial} on this follower`);
    return h;
  }

  private emit(h: Hosted, e: NewEvent): void {
    h.seq += 1;
    h.events.push({ ...e, seq: h.seq } as LaneEvent);
    for (const wake of h.wakers.splice(0)) wake();
  }

  /** The trial's run here: its workspace, its program, and everything it left removed. */
  private async run(h: Hosted): Promise<void> {
    const lane = h.spec.lane as Role;
    let ws: { dir: string; repo: string } | undefined;
    let result: TrialResult = {
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    try {
      ws = await prepareWorkspace({
        runner: this.o.runner,
        scratchDir: this.o.scratchDir,
        mirror: this.o.mirror(h.repo),
        commit: h.spec.parentCommit,
        lane,
      });
      h.root = ws.dir;
      log("harness", "a trial of the leader's runs here", {
        trial: h.spec.trialId,
        lane: h.spec.lane,
        run: h.spec.run,
      });
      if (h.abort.signal.aborted) throw new Error("stopped before the trial started");
      if (!h.route) throw new Error("this rig has no model for its agents");
      this.emit(h, {
        kind: "live",
        entries: [{ kind: "status", text: "a trial on a follower runs headless" }],
      });
      result = await this.o.runTrial(
        { ...h.spec, workspace: ws.repo, workspaceRoot: ws.dir } as TrialSpec,
        this.linkOf(h),
      );
    } catch (err) {
      result = { ...result, stopped: "error", error: errorText(err) };
    } finally {
      if (h.abort.signal.aborted && result.stopped !== "submitted")
        result = { ...result, stopped: "interrupted" };
      await this.o.runner.killRole(lane).catch(() => 0);
      await this.o.devRuns?.settle(lane).catch(() => undefined);
      await this.o.runner.killRole(lane).catch(() => 0);
      if (ws) await this.o.runner.remove(ws.dir).catch(() => undefined);
      h.ended = { result, session: h.session };
      h.endedAt = Date.now();
      for (const [id, c] of h.calls) {
        clearTimeout(c.timer);
        c.resolve(refusal(409, "the trial has ended"));
        h.calls.delete(id);
      }
      for (const wake of h.wakers.splice(0)) wake();
    }
  }

  /** What the trial's program takes from the harness here, each report kept for the leader. */
  private linkOf(h: Hosted): TrialLink {
    const m = h.route;
    const inbox: MessageInbox = {
      waiting: () => h.messages.filter((x) => !h.given.has(x.id)),
      given: (ids, how) => {
        for (const id of ids) h.given.add(id);
        this.emit(h, { kind: "given", ids, ...(how ? { how } : {}) });
      },
    };
    return {
      runner: this.o.runner,
      model: m,
      apiUrl: `http://127.0.0.1:${this.o.port}`,
      scratchDir: this.o.scratchDir,
      port: this.o.port,
      live: (entries) => {
        if (entries.length) this.emit(h, { kind: "live", entries });
      },
      progress: (progress) => this.emit(h, { kind: "progress", progress }),
      submitted: () => h.submitted,
      messages: inbox,
      inTurn: (d) => {
        h.turn = d;
      },
      console: () => undefined,
      usage: (windows) => this.emit(h, { kind: "windows", windows }),
      compacted: (harness, compaction) => this.emit(h, { kind: "compacted", harness, compaction }),
      keepSession: (files) => {
        for (const f of files) {
          try {
            if (statSync(f.path).size > SESSION_FILE_MAX) continue;
            h.session.push({ name: f.name, base64: readFileSync(f.path).toString("base64") });
          } catch {
            // A file the program did not write: none kept.
          }
        }
      },
      modelUsage: m ? (usage) => this.emit(h, { kind: "model_usage", usage }) : undefined,
      handOver: (harness) => {
        this.emit(h, { kind: "hand_over", harness });
        return () => undefined;
      },
      throughProxy: () => this.emit(h, { kind: "through_proxy" }),
      providerAnswer: (since) => this.answers.providerAnswerSince(h.spec.trialId, since),
      waiting: (wait) => this.emit(h, { kind: "wait", wait }),
      draining: () => h.draining,
      env: laneCacheEnv(this.o.scratchDir, h.spec.lane),
      terminal: false,
      sent: (prompt) => this.emit(h, { kind: "sent", prompt }),
      signal: h.abort.signal,
    };
  }

  private sweep(now = Date.now()): void {
    for (const [id, h] of this.trials) {
      if (h.ended) {
        if (now - (h.endedAt ?? now) > ENDED_KEPT_MS) this.trials.delete(id);
      } else if (now - h.lastWait > LEADER_GONE_MS && !h.abort.signal.aborted) {
        log("harness", "the rig's leader stopped asking: its trial here stops", {
          trial: id,
          lane: h.spec.lane,
        });
        h.abort.abort();
      }
    }
  }

  /** Stops the watchdog (tests). */
  close(): void {
    clearInterval(this.watchdog);
  }
}

/** A refused call's answer, in words. */
function refusal(status: number, error: string): CallAnswer {
  return { status, type: "application/json", body: Buffer.from(JSON.stringify({ error })) };
}

/** An ask about a trial the follower refuses: one it does not hold, or a lane already at work. */
export class LaneRefusal extends Error {}
