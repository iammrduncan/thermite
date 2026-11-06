import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessClient } from "../../common/api/harness.ts";
import type { Bus } from "../../common/bus/index.ts";
import { errorText } from "../../common/errors.ts";
import { RUN, RUN_GIT, RunAsk } from "../../core/api/harness/runs.ts";
import {
  RUNNER_ASK_TIMEOUT_MS,
  RUNNER_PART_CHARS,
  type RunnerReply,
  RunnerRequest,
  runnerSubject,
} from "../../core/link/runners.ts";
import { downloadModel, ModelDownloads } from "../model-download.ts";
import { ModelFetches } from "./model-fetches.ts";

/**
 * A runner's supervisor answers its core's asks (goal 206): each request on the runner's own
 * subject (core/link/runners.ts) goes to its harness (RUN), and a git bundle's parts
 * are joined in a file and given to it whole (RUN_GIT). An answer longer than one message is
 * held, and its parts given as the core asks for them; a held answer or a bundle's parts left
 * for an hour go.
 */

/** How long a held answer or a bundle's parts wait for the rest, in milliseconds. */
const HELD_MS = 3_600_000;

interface Answerer {
  rig: string;
  runner: string;
  bus: Pick<Bus, "serve">;
  harness: Pick<HarnessClient, "call">;
  /** Where a bundle's parts are joined. */
  scratchDir: string;
  /** The inbox it shares with its harness, where model files land; none: it fetches none. */
  inboxDir?: string | undefined;
  /** A Hugging Face token for gated models, the supervisor's own; none: public models only. */
  hfToken?: string | undefined;
  /** Tests only: how model files are fetched, a local server's included. */
  fetchImpl?: typeof fetch | undefined;
}

/** Serves the core's asks on the runner's subject. */
export async function answerCoreAsks(o: Answerer): Promise<void> {
  const bundles = new Map<string, { file: string; next: number; at: number }>();
  const held = new Map<string, { parts: string[]; at: number }>();
  const asks = new Map<string, { parts: string[]; at: number }>();
  const forget = (now = Date.now()) => {
    for (const [id, b] of bundles)
      if (now - b.at > HELD_MS) {
        rmSync(b.file, { force: true });
        bundles.delete(id);
      }
    for (const [id, h] of held) if (now - h.at > HELD_MS) held.delete(id);
    for (const [id, a] of asks) if (now - a.at > HELD_MS) asks.delete(id);
  };
  // An answer as one reply, or its first part, the rest held.
  const reply = (out: RunnerReply): string => {
    const text = JSON.stringify(out);
    if (text.length <= RUNNER_PART_CHARS) return text;
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += RUNNER_PART_CHARS)
      parts.push(text.slice(i, i + RUNNER_PART_CHARS));
    const id = randomUUID();
    held.set(id, { parts, at: Date.now() });
    return JSON.stringify({ more: { id, parts: parts.length }, data: parts[0] });
  };
  // Model files fetched in turns (goal 213): one fetch for each file, however often it is asked.
  const fetches = o.inboxDir
    ? new ModelFetches({
        inboxDir: o.inboxDir,
        take: (file) =>
          o.harness.call(RUN, {
            body: { op: "models_take", models: [file] },
            timeoutMs: RUNNER_ASK_TIMEOUT_MS,
          }),
        hfToken: o.hfToken,
        fetchImpl: o.fetchImpl,
      })
    : undefined;
  const harnessSays = async (call: () => Promise<unknown>): Promise<RunnerReply> => {
    try {
      return { answer: await call() };
    } catch (err) {
      return { error: errorText(err).slice(0, 4000) };
    }
  };
  await o.bus.serve(runnerSubject(o.rig, o.runner), async (r) => {
    forget();
    let req: RunnerRequest;
    try {
      req = RunnerRequest.parse(JSON.parse(Buffer.from(r.data).toString("utf8")));
    } catch (err) {
      return JSON.stringify({ error: `not an ask this runner reads: ${errorText(err)}` });
    }
    const askHarness = async (ask: unknown) =>
      reply(
        await harnessSays(() =>
          o.harness.call(RUN, {
            body: RunAsk.parse(ask),
            timeoutMs: RUNNER_ASK_TIMEOUT_MS,
          }),
        ),
      );
    if (req.kind === "ask") return askHarness(req.ask);
    // A long ask's part, in order: the last gives the joined ask to the harness.
    if (req.kind === "ask_part") {
      const a = asks.get(req.id) ?? { parts: [], at: Date.now() };
      if (req.part !== a.parts.length)
        return JSON.stringify({
          error: `part ${req.part} of the ask came before ${a.parts.length}`,
        });
      a.parts.push(req.data);
      if (req.part < req.parts - 1) {
        asks.set(req.id, a);
        return JSON.stringify({ took: true });
      }
      asks.delete(req.id);
      let ask: unknown;
      try {
        ask = JSON.parse(a.parts.join(""));
      } catch (err) {
        return JSON.stringify({ error: `not an ask this runner reads: ${errorText(err)}` });
      }
      return askHarness(ask);
    }
    if (req.kind === "models") {
      const inbox = o.inboxDir;
      if (!inbox) return JSON.stringify({ error: "this runner fetches no model files" });
      if (req.poll && fetches) return reply({ answer: fetches.turn(req.models, req.poll) });
      // Each from its source into the inbox, landed only with its SHA-256, then taken in by the
      // harness, which checks it again.
      return reply(
        await harnessSays(async () => {
          const downloads = new ModelDownloads();
          for (const m of req.models)
            await downloadModel({
              url: m.url,
              sha256: m.sha256,
              target: join(inbox, m.path),
              path: m.path,
              name: m.name,
              hfToken: o.hfToken,
              downloads,
              fetchImpl: o.fetchImpl,
            });
          return o.harness.call(RUN, {
            body: {
              op: "models_take",
              models: req.models.map(({ path, sha256 }) => ({ path, sha256 })),
            },
            timeoutMs: RUNNER_ASK_TIMEOUT_MS,
          });
        }),
      );
    }
    if (req.kind === "more") {
      const part = held.get(req.id)?.parts[req.part];
      if (part === undefined) return JSON.stringify({ error: "no such part of an answer is held" });
      if (req.part === (held.get(req.id)?.parts.length ?? 0) - 1) held.delete(req.id);
      return JSON.stringify({ data: part });
    }
    // A bundle's part, in order: the last gives the joined bundle to the harness.
    const b = bundles.get(req.id) ?? {
      file: join(o.scratchDir, `bundle-${randomUUID()}`),
      next: 0,
      at: Date.now(),
    };
    if (req.part !== b.next)
      return JSON.stringify({ error: `part ${req.part} of the bundle came before ${b.next}` });
    const bytes = Buffer.from(req.data, "base64");
    if (req.part === 0) writeFileSync(b.file, bytes, { mode: 0o600 });
    else appendFileSync(b.file, bytes);
    b.next++;
    if (req.part < req.parts - 1) {
      bundles.set(req.id, b);
      return JSON.stringify({ took: true });
    }
    bundles.delete(req.id);
    try {
      return reply(
        await harnessSays(() =>
          o.harness.call(RUN_GIT, {
            params: { repo: req.repo, commit: req.commit },
            bytes: readFileSync(b.file),
            timeoutMs: RUNNER_ASK_TIMEOUT_MS,
          }),
        ),
      );
    } finally {
      rmSync(b.file, { force: true });
    }
  });
}
