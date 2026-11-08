import type { HillClimbContract, OwnersAcceptance, RunAcceptance } from "../core/contract.ts";
import type { Ledger } from "./ledger/index.ts";

/**
 * A running run's acceptance changed in place by the owner (goal 233): the newest
 * `acceptance_set` event holds what is in force over the contract's, and the judge's next screen
 * or confirmation takes it, as do the agents' next briefs. The contract and its hash stay as they
 * were.
 */

/** The owner's acceptance in force on a run; empty: the contract's own. */
export function ownersAcceptance(ledger: Ledger, run: string): OwnersAcceptance {
  return ledger.events.newest("acceptance_set", { subject: run })?.body.acceptance ?? {};
}

/** The owner's acceptance merged with a change: a value sets one, null goes back to the contract's. */
export function mergedAcceptance(now: OwnersAcceptance, change: RunAcceptance): OwnersAcceptance {
  const out: OwnersAcceptance = { ...now };
  if (change.min_effects) {
    const m = { ...out.min_effects };
    for (const [k, v] of Object.entries(change.min_effects)) {
      if (v === null) delete m[k];
      else m[k] = v;
    }
    if (Object.keys(m).length) out.min_effects = m;
    else delete out.min_effects;
  }
  for (const k of ["confirm_blocks", "futility"] as const) {
    const v = change[k];
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A hill climb's contract with the owner's acceptance over its own. */
export function withOwnersAcceptance(
  contract: HillClimbContract,
  own: OwnersAcceptance,
): HillClimbContract {
  if (!Object.keys(own).length) return contract;
  const a = contract.acceptance;
  return {
    ...contract,
    acceptance: {
      ...a,
      ...(own.confirm_blocks !== undefined ? { confirm_blocks: own.confirm_blocks } : {}),
      ...(own.futility !== undefined ? { futility: own.futility } : {}),
      ...(own.min_effects ? { min_effects: { ...a.min_effects, ...own.min_effects } } : {}),
    },
  };
}

/** The owner's acceptance in words: what each of its values sets. */
function acceptanceWords(own: OwnersAcceptance): string {
  const pct = (x: number) => `${+(x * 100).toFixed(3)}%`;
  const parts = [
    ...Object.entries(own.min_effects ?? {}).map(([m, v]) => `${m}'s minimum effect ${pct(v)}`),
    ...(own.confirm_blocks !== undefined ? [`a confirmation of ${own.confirm_blocks} blocks`] : []),
    ...(own.futility !== undefined ? [`the early stop at a confidence of ${own.futility}`] : []),
  ];
  return parts.length ? parts.join(", ") : "the contract's own";
}

/**
 * What a change of a running run's acceptance would set and reach (goal 233), with nothing
 * changed: the acceptance in force after it, and the judge's jobs it reaches.
 */
export function acceptancePreview(ledger: Ledger, run: string, own: OwnersAcceptance) {
  const attempts = ledger.attempts.newest(run, 1000).map((a) => String(a.id));
  const open = ledger.jobs.openOf(attempts);
  const leased = open.filter((j) => j.state === "leased").map((j) => `job ${j.id} (${j.kind})`);
  return {
    run,
    preview: true,
    acceptance: own,
    words: `The run's acceptance would be ${acceptanceWords(own)}, from the judge's next screen or confirmation: ${open.length} of the run's jobs wait or run${leased.length ? `, of which ${leased.join(", ")} run now and keep what they started with` : ""}. Nothing changed.`,
  };
}
