import { appendFileSync } from "node:fs";
import type { Runner, RunOutcome, RunRequest } from "../../src/harness/broker/runner.ts";

/**
 * How a stand-in runner tells each agent program's own run (OpenCode, Claude Code, Codex) from the
 * other runs of its trial or call (its setup, Claude Code's prompt): by a word of its command line.
 * A trial's run writes its output to the events file the variable names; a one-prompt call's run
 * gives it as its standard output.
 */
const PROGRAMS = {
  opencode: { word: "run", events: "THERMITE_OPENCODE_EVENTS" },
  "claude-code": { word: "-p", events: "THERMITE_CLAUDE_EVENTS" },
  codex: { word: "exec", events: "THERMITE_CODEX_EVENTS" },
} as const;

export type Program = keyof typeof PROGRAMS;

const done = (): RunOutcome =>
  ({ exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" }) as RunOutcome;

/**
 * A stand-in runner for one program: every other run succeeds (`onSetup` sees each first); the
 * program's nth run (from 1) gives `lines`, or `lines(n, req)`, and ends 30 ms later as `outcome`
 * says, or, with `hang`, only once its role is killed. With `submit`, the agent has submitted by
 * the time a run ends. It records the folders handed over and removed.
 */
export function fakeProgramRunner(
  program: Program,
  lines: string[] | ((n: number, req: RunRequest) => string[]),
  o: {
    submit?: boolean;
    hang?: boolean;
    outcome?: Partial<RunOutcome>;
    onSetup?: (req: RunRequest) => void;
  } = {},
) {
  const { word, events } = PROGRAMS[program];
  const runs: RunRequest[] = [];
  const killed: string[] = [];
  const handed: { dir: string; role: string }[] = [];
  const removed: string[] = [];
  let submitted = false;
  let release: () => void = () => undefined;
  const programRuns = () => runs.filter((x) => x.argv.includes(word));
  const runner = {
    run: async (req: RunRequest): Promise<RunOutcome> => {
      runs.push(req);
      if (!req.argv.includes(word)) {
        o.onSetup?.(req);
        return done();
      }
      const out = (typeof lines === "function" ? lines(programRuns().length, req) : lines).join(
        "\n",
      );
      const file = req.env?.[events];
      if (file) appendFileSync(file, `${out}\n`);
      await new Promise<void>((r) => {
        release = r;
        if (!o.hang) setTimeout(r, 30);
      });
      if (o.submit) submitted = true;
      return { ...done(), ...(file ? {} : { stdout: out }), ...o.outcome };
    },
    killRole: async (role: string) => {
      killed.push(role);
      release();
      return 0;
    },
    handOver: async (dir: string, role: string) => {
      handed.push({ dir, role });
    },
    remove: async (dir: string) => {
      removed.push(dir);
    },
  } as unknown as Runner;
  return { runner, runs, killed, handed, removed, submitted: () => submitted, programRuns };
}
