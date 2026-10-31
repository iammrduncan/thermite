import { resolve } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ATTEMPT, ATTEMPTS } from "../../core/api/harness/proposer.ts";
import { laneLimits } from "../../core/contract.ts";
import { laneCacheEnv } from "../agents/index.ts";
import { type Role, RunRequest } from "../broker/index.ts";
import { LedgerError } from "../ledger/index.ts";
import { type ApiContext, allows, limitOf, trialToken, Unauthorized } from "./context.ts";

/**
 * The workers' work: a submission (a trial's, or a proposer's in development), a lane command in
 * the trial's workspace, a development run on the device, a research operation, and what an
 * attempt's submitter may see of it.
 */

const Strings = z.array(z.string().max(500)).max(50).default([]);

export function workRoutes(app: Hono, { service, tokens, extras, trialOf }: ApiContext): void {
  // Workers submit with their trial token (the trial decides run, lane and parent); the
  // proposer token is for the CLI and scripted proposers in development.
  app.post(ATTEMPTS.path, limitOf(ATTEMPTS), async (c) => {
    if (trialToken(c.req.header("authorization"))) {
      const { token } = trialOf(c.req.header("authorization"));
      const body = ATTEMPTS.body
        .pick({
          patch_base64: true,
          hypothesis: true,
          claim: true,
          known_flaws: true,
        })
        .parse(await c.req.json());
      return c.json(await service.submitForTrial(token, body), 201);
    }
    if (!allows(tokens, ["proposer"], c.req.header("authorization")))
      throw new Unauthorized("unauthorized");
    const req = ATTEMPTS.body.parse(await c.req.json());
    return c.json(await service.submitAttempt(req, "proposer"), 201);
  });

  // A worker's lane work: only in its own trial's workspace, as its lane's user, with the lane
  // tool or a shell command, within the limits of a lane's run.
  app.post("/v1/lane/run", bodyLimit({ maxSize: 9 * 1024 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const lanes = extras.lanes;
    const ws = service.trialWorkspaces.get(trial.id);
    if (!lanes || !ws) return c.json({ error: "no workspace for this trial" }, 404);
    const req = RunRequest.parse(await c.req.json());
    const inside = (p: string) => {
      const full = resolve(p);
      return full === ws.root || full.startsWith(`${ws.root}/`);
    };
    if (req.role !== trial.lane) throw new Unauthorized("not this trial's lane");
    if (req.gpu) throw new Unauthorized("device runs go through dev_run");
    if (!inside(req.cwd) || (req.disk && !inside(req.disk.path)))
      throw new Unauthorized("outside the trial's workspace");
    // The contract's lane limits bound every lane command: memory and disk always (defaults
    // when it sets none), time only when it sets one.
    const limits = laneLimits(service.contractFor(trial.run));
    const rssCap = limits.runRssMib * 1024 ** 2;
    const diskCap = limits.workspaceMib * 1024 ** 2;
    let argv: string[];
    if (req.argv[0] === "lanetool") argv = [...lanes.laneTool, ...req.argv.slice(1)];
    else if (req.argv.length === 3 && req.argv[0] === "sh" && req.argv[1] === "-c") argv = req.argv;
    else throw new Unauthorized("only the lane tool or a shell command");
    const r = await lanes.runner.run({
      role: trial.lane as Role,
      argv,
      cwd: req.cwd,
      env: laneCacheEnv(service.paths.scratchDir, trial.lane),
      ...timeLimit(req.timeoutMs, limits.runTimeoutS),
      rssLimitBytes: Math.min(req.rssLimitBytes ?? rssCap, rssCap),
      ...(req.disk
        ? { disk: { path: req.disk.path, limitBytes: Math.min(req.disk.limitBytes, diskCap) } }
        : {}),
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      // From the contract, never from the request.
      nproc: limits.processes,
      captureBytes: Math.min(req.captureBytes ?? 64 * 1024, 32 * 1024 * 1024),
      // As in a shell: what a command starts in the background runs on until the trial ends.
      keepBackground: true,
    });
    return c.json(r as object);
  });

  app.post("/v1/dev-runs", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!extras.devRuns) return c.json({ error: "dev runs are not available" }, 404);
    const body = z
      .object({ command: z.string(), timeout_s: z.number().optional(), cwd: z.string() })
      .parse(await c.req.json());
    const limits = laneLimits(service.contractFor(trial.run));
    return c.json(
      (await extras.devRuns.run(
        {
          ...body,
          ...(body.timeout_s !== undefined
            ? { timeout_s: Math.max(1, Math.trunc(body.timeout_s)) }
            : {}),
          lane: trial.lane,
        },
        trial.id,
        {
          rssMib: limits.devRunRssMib,
          diskMib: limits.workspaceMib,
          processes: limits.processes,
          ...(limits.devRunTimeoutS !== undefined ? { timeoutS: limits.devRunTimeoutS } : {}),
        },
      )) as object,
    );
  });

  app.post("/v1/research/:op", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const r = extras.research;
    if (!r) return c.json({ error: "research is not available" }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    // The trial decides where its work goes; run and lane in the body are ignored. A hill-climb
    // or goal trial records sources, claims and notes too (goal 065); the rest is research's.
    const { run, lane } = trial;
    r.requireRunning(run, c.req.param("op"));
    const s = (k: string) => String(body[k] ?? "");
    switch (c.req.param("op")) {
      case "fetch":
        return c.json(await r.fetch(run, lane, s("url")));
      case "read":
        return c.json(
          r.read(run, s("source"), Number(body.offset ?? 0), Number(body.length ?? 6000)),
        );
      case "search-corpus":
        return c.json(r.searchCorpus(run, s("text"), Number(body.skip ?? 0)));
      case "claim":
        return c.json(r.addClaim(run, lane, body));
      case "note":
        return c.json(r.addNote(run, lane, s("text"), Strings.parse(body.sources), trial.id));
      case "hypothesis":
        return c.json(r.proposeHypothesis(run, lane, body));
      case "revise-hypothesis":
        return c.json(r.reviseHypothesis(run, lane, body));
      case "finding":
        return c.json(r.addFinding(run, lane, body));
      case "section":
        return c.json(r.updateSection(run, lane, s("name"), s("body")));
      case "stats": {
        // Each question by its index, its words cut to fit a tool's answer (goal 117): a
        // question has no length limit, and the brief and INDEX.md have each one whole.
        const stats = r.stats(run);
        return c.json({
          ...stats,
          questions: stats.questions.map((q, index) => ({
            index,
            question:
              q.question.length > 300
                ? `${q.question.slice(0, 299)}… (cut: the whole question is in your brief and INDEX.md)`
                : q.question,
            verified: q.verified,
          })),
          clock: r.clock(run),
        });
      }
      default:
        return c.json({ error: "unknown research operation" }, 404);
    }
  });

  app.get(ATTEMPT.path, async (c) => {
    const id = c.req.param("id");
    if (trialToken(c.req.header("authorization"))) {
      // A worker reads any attempt of its own campaign on this rig: its lane's, another lane's
      // (a hand-out may name one), or an earlier run's (the knowledge base shows those). Its
      // brief still shows only its own lane's (goal 082).
      const { trial } = trialOf(c.req.header("authorization"));
      const a = service.ledger.attempts.get(id);
      const campaign = (run: unknown) => service.ledger.runs.get(String(run))?.campaign;
      if (!a || campaign(a.run) !== campaign(trial.run))
        throw new LedgerError("not_found", `no attempt ${id} in this campaign`);
      return c.json(service.attemptStatus(id) as object);
    }
    if (!allows(tokens, ["supervisor", "proposer"], c.req.header("authorization")))
      throw new Unauthorized("unauthorized");
    return c.json(service.attemptStatus(id) as object);
  });
}

/** A command's time limit: what it asked for, within the contract's limit if there is one. */
function timeLimit(
  askedMs: number | undefined,
  limitS: number | undefined,
): { timeoutMs?: number } {
  const capMs = limitS !== undefined ? limitS * 1000 : undefined;
  const ms =
    askedMs === undefined ? capMs : capMs === undefined ? askedMs : Math.min(askedMs, capMs);
  return ms !== undefined ? { timeoutMs: ms } : {};
}
