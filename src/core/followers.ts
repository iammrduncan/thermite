/**
 * A rig over several machines (goal 205): each machine's GPUs in the judge's pool or the
 * workers', as control sets them and the harness reads them. The leader's harness gets
 * `THERMITE_FOLLOWERS`, `<machine>=<judge GPUs>[+<workers' GPUs>]` for each follower
 * (harness/controller/judges.ts reads it), and `THERMITE_LOCAL_JUDGE=0` or `THERMITE_LOCAL_LANES=0`
 * for its own GPUs' pool; a follower's harness gets its GPUs as its container numbers them, the
 * judge's first.
 */

/** Whose the leader's own GPUs are: both pools, the workers' only, or the judge's only. */
export type LeaderPool = "shared" | "workers" | "judge";

/** A follower's GPUs by pool; with none, whose its CPUs are (the judge's unless said). */
export interface FollowerPools {
  judge: number;
  workers: number;
  cpu?: "judge" | "workers" | undefined;
}

/** What a follower serves, in GPUs (a follower with none serves one pool on its CPUs). */
function served(p: FollowerPools): { judge: number; workers: number } {
  if (p.judge + p.workers) return { judge: p.judge, workers: p.workers };
  return p.cpu === "workers" ? { judge: 0, workers: 1 } : { judge: 1, workers: 0 };
}

/** The leader harness's settings for its followers and its own GPUs' pool. */
export function leaderEnv(
  followers: { machine: string; pools: FollowerPools }[],
  leader: LeaderPool,
): Record<string, string> {
  if (!followers.length) return {};
  return {
    THERMITE_FOLLOWERS: followers
      .map((f) => {
        const s = served(f.pools);
        return `${f.machine}=${s.judge}${s.workers ? `+${s.workers}` : ""}`;
      })
      .join(","),
    ...(leader === "workers" ? { THERMITE_LOCAL_JUDGE: "0" } : {}),
    ...(leader === "judge" ? { THERMITE_LOCAL_LANES: "0" } : {}),
  };
}

/**
 * A follower harness's GPUs as its container numbers them, the judge's first: with both pools,
 * the workers' are its development cards; with one, all are the broker's shared or judge cards.
 */
export function followerGpuEnv(p: FollowerPools): Record<string, string> {
  const n = p.judge + p.workers;
  const list = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => from + i).join(",");
  if (!n) return {};
  if (!p.judge || !p.workers) return { THERMITE_GPU_INDEX: list(0, n) };
  return { THERMITE_GPU_INDEX: list(0, p.judge), THERMITE_DEV_GPU_INDEX: list(p.judge, n) };
}

/**
 * Why a rig's pools can't be, in words; undefined when they can: a follower whose GPUs are all
 * the workers' gives them one GPU for now (a dev run takes its shared card), the judge needs a
 * place to measure, and the lanes a place to work.
 */
export function poolsRefusal(
  leader: LeaderPool,
  followers: { machine: string; pools: FollowerPools }[],
): string | undefined {
  for (const f of followers)
    if (!f.pools.judge && f.pools.workers > 1)
      return `${f.machine} gives the workers ${f.pools.workers} GPUs and the judge none: a follower with no judge GPU gives the workers one GPU for now.`;
  const all = followers.map((f) => served(f.pools));
  if (leader === "workers" && !all.some((s) => s.judge))
    return "The leader's GPUs are the workers' only, so give the judge a follower's GPU: it measures only on the judge's.";
  if (leader === "judge" && !all.some((s) => s.workers))
    return "The leader's GPUs are the judge's only, so give the workers a follower's GPU: the lanes need somewhere to work.";
  return undefined;
}
