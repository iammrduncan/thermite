import type { ChildProcess } from "node:child_process";
import { killScope, runSupervised, type SupervisedResult, type SupervisedRun } from "./process.ts";

/**
 * A kit's driver and the candidate it measures, run at once as two users (the owner's decision of
 * 2026-10-29): the driver's standard output is the candidate's standard input, and the candidate's
 * output the driver's input. The two pipes are the kernel's, between the two processes; the broker
 * keeps no end of either. The pair ends when the driver's command does, and the candidate's
 * processes end then. The candidate's user can't signal or trace the driver's processes, nor change
 * what they write.
 */

export interface PairOutcome {
  driver: SupervisedResult;
  candidate: SupervisedResult;
}

export async function runPairSupervised(
  driver: SupervisedRun,
  candidate: SupervisedRun,
): Promise<PairOutcome> {
  let first: ChildProcess | undefined;
  const driving = runSupervised({ ...driver, pair: "first", started: (c) => (first = c) });
  const ends = first as ChildProcess | undefined;
  if (!ends?.stdin || !ends.stdout) throw new Error("the kit's driver started without its pipes");
  let pgid: number | undefined;
  const measured = runSupervised({
    ...candidate,
    pair: { stdin: ends.stdout, stdout: ends.stdin },
    started: (c) => (pgid = c.pid),
  });
  // Each process holds its own ends now: closing these lets each see the other's end.
  ends.stdout.destroy();
  ends.stdin.destroy();
  const driven = await driving;
  killScope(candidate.uid !== undefined ? { uid: candidate.uid } : { pgid });
  return { driver: driven, candidate: await measured };
}
