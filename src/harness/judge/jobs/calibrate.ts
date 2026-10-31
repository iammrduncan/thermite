import { meanInterval, toFraction } from "../../../core/stats.ts";
import type { JobRow } from "../../ledger/index.ts";
import { runBlocks } from "../blocks.ts";
import type { Finish, JudgeContext } from "../context.ts";
import type { Arm } from "../measure.ts";

/**
 * The calibrate job: A/A blocks, the champion against itself, to measure the rig's noise. Each
 * judge card calibrates for itself.
 */

const pct = (x: number) => `${(toFraction(x) * 100).toFixed(2)}%`;

export async function calibrate(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const run = String(judge.spec(job).run);
  const contract = judge.hillClimb(run);
  const champion = judge.ledger.champions.current(run);
  const k = await judge.kitFor(contract);
  const champ = await judge.armFor("champion", run, champion.commit_sha, k);
  const ctx = judge.context(k, job);
  const twin: Arm = { ...champ, name: "twin" };
  const blocks = await runBlocks(judge, {
    job,
    ctx,
    arms: [twin, champ],
    cells: contract.cells,
    count: judge.o.calibrationBlocks,
    runsPerCell: contract.acceptance.runs_per_cell,
  });
  const { metric, direction } = contract.objective.primary;
  const effects = blocks.map((b) => {
    const logs = contract.cells.map((cell) => {
      const x = b.candidate[metric]?.[cell] as number;
      const y = b.reference[metric]?.[cell] as number;
      return direction === "max" ? Math.log(x / y) : Math.log(y / x);
    });
    return logs.reduce((s, v) => s + v, 0) / logs.length;
  });
  const i = meanInterval(effects, contract.acceptance.alpha_screen);
  const sd = Math.sqrt(
    effects.reduce((s, e) => s + (e - i.estimate) ** 2, 0) / (effects.length - 1),
  );
  const result = {
    run,
    champion_seq: champion.seq,
    blocks: effects.length,
    sigma: sd,
    mean: i.estimate,
    ci: [i.low, i.high],
    summary: `A/A ${pct(i.estimate)} [${pct(i.low)}, ${pct(i.high)}], block sigma ${(sd * 100).toFixed(3)}%`,
    ...(judge.cards > 1 && judge.o.card
      ? { card: judge.o.card.uuid, card_index: judge.o.card.index }
      : {}),
  };
  return { result, events: [{ kind: "calibration" as const, subject: run, body: result }] };
}
