import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { COMMAND, ISSUE } from "../../core/api/control/owner.ts";
import type { InvalidationReach } from "../../core/invalidation.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite invalidate (goal 174): the owner withdraws bad evidence through control. It sends the
 * preview first and prints what it would reach; with --yes it then sends the withdrawal, naming
 * the preview's sha, so the rig does what was printed or refuses.
 */

/** How long it waits for the rig's answer to each command, and how often it asks control. */
const ANSWER_WAIT_MS = 10 * 60_000;
const ASK_EVERY_MS = 2_000;

/** The harness's answer to `invalidate_evidence`. */
interface Answer {
  sha: string;
  words: string[];
  reach: InvalidationReach;
  invalidation?: number;
}

/** The rig refused, or did not answer: the reason on standard error, and exit code 1. */
function refused(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const THEN: Record<string, string> = {
  withdrawn: "withdrawn for good",
  judged_again: "judged again",
  stays_withdrawn: "stays withdrawn",
};

/**
 * Sends one command and waits until the harness's signed report confirms its answer. A refusal,
 * an expiry or no answer within ANSWER_WAIT_MS ends the command line with the reason (exit 1).
 */
async function answered(control: ReturnType<typeof controlAt>, payload: unknown): Promise<Answer> {
  const sent = await orFail(
    control.call(ISSUE, { body: { kind: "invalidate_evidence", payload, ttl_minutes: 60 } }),
  );
  const id = String((sent as { id?: unknown }).id ?? "");
  const until = Date.now() + ANSWER_WAIT_MS;
  for (;;) {
    const c = await orFail(control.call(COMMAND, { params: { id } }));
    const o = (c.outcome ?? {}) as {
      source?: string;
      accepted?: boolean;
      result?: { error?: unknown };
      error?: unknown;
      reason?: unknown;
    };
    if (["failed", "rejected", "expired"].includes(c.status) || o.accepted === false)
      refused(
        `the rig refused it (command ${id}): ${String(o.result?.error ?? o.error ?? o.reason ?? c.status)}`,
      );
    if (o.source === "harness") return o.result as unknown as Answer;
    if (Date.now() > until)
      refused(`the rig did not answer command ${id} within ${ANSWER_WAIT_MS / 60_000} minutes`);
    await sleep(ASK_EVERY_MS);
  }
}

/** What an answer reaches, for a person: its words, then each attempt and what becomes of it. */
function print(a: Answer): void {
  const out = [...a.words, ""];
  for (const x of a.reach.attempts)
    out.push(
      `  ${x.attempt}  ${x.verdict?.verdict ?? "no verdict yet"}, ${x.lifecycle}  ->  ${THEN[x.then] ?? x.then}`,
    );
  if (a.reach.attempts_total > a.reach.attempts.length)
    out.push(`  and ${a.reach.attempts_total - a.reach.attempts.length} more`);
  process.stdout.write(`${out.join("\n")}\n`);
}

export async function thermiteInvalidate(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      run: { type: "string" },
      attempt: { type: "string" },
      job: { type: "string" },
      reason: { type: "string" },
      yes: { type: "boolean" },
    },
  });
  if (!values.control || !values["token-file"] || !values.run || !values.reason) fail(USAGE);
  if ((values.attempt === undefined) === (values.job === undefined))
    fail("give --attempt ID or --job N: one of them");
  const job = values.job === undefined ? undefined : Number(values.job);
  if (job !== undefined && !(Number.isInteger(job) && job > 0))
    fail("--job is a judge job's number");
  const control = controlAt(values.control, values["token-file"]);
  const subject = job === undefined ? { attempt: values.attempt } : { job };
  const base = { run: values.run, ...subject, reason: values.reason };
  const preview = await answered(control, { ...base, preview: true });
  process.stdout.write("What withdrawing it reaches:\n");
  print(preview);
  if (!values.yes) {
    process.stderr.write("Nothing was withdrawn. To withdraw it, run this again with --yes.\n");
    return;
  }
  const done = await answered(control, { ...base, reach: preview.sha });
  process.stdout.write(`Withdrawn: invalidation ${done.invalidation ?? "?"} on the rig.\n`);
}
