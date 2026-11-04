import { log } from "../../common/log.ts";
import { AwayLane, type LaneAway } from "../agents/index.ts";
import type { FollowerLink } from "../judge/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { AgentLinks } from "./agents.ts";
import type { Follower } from "./judges.ts";

/**
 * Where each lane's trials run on a rig over several machines (goal 205, step 2): the lanes go to
 * the machines with workers' GPUs in turn, each as often as it has workers' GPUs, the leader's
 * first. The leader counts its development cards, or one when the judge shares its card or it
 * has none, unless its GPUs are all the judge's (THERMITE_LOCAL_LANES=0). With no follower that
 * has workers' GPUs, every lane is the leader's, as on a rig of one machine.
 */
export function lanesAway(o: {
  env: NodeJS.ProcessEnv;
  service: HarnessService;
  links: AgentLinks;
  followers: Follower[];
  link: FollowerLink | undefined;
  /** The leader's development cards. */
  devCards: number;
  /** The leader's own API, which answers its followers' trials' calls. */
  api: (req: Request) => Response | Promise<Response>;
}): ((lane: string) => LaneAway | undefined) | undefined {
  const { link, service, links } = o;
  const workers = o.followers.filter((f) => f.workers > 0);
  if (!link || !workers.length) return undefined;
  const here = o.env.THERMITE_LOCAL_LANES === "0" ? 0 : Math.max(1, o.devCards);
  const away = new Map(
    workers.map((f) => [
      f.machine,
      new AwayLane({
        machine: f.machine,
        link: link.to(f.machine),
        mirrorFor: (repo) => service.mirrorFor(repo),
        scratchDir: service.paths.scratchDir,
        modelFor: links.modelFor,
        trialLink: links.link,
        api: o.api,
        proxySaw: (trial, tokens) => service.ledger.trials.proxySaw(trial, tokens as never),
      }),
    ]),
  );
  // One place for each workers' GPU: undefined is the leader's own.
  const places: (string | undefined)[] = [
    ...Array.from({ length: here }, () => undefined),
    ...workers.flatMap((f) => Array.from({ length: f.workers }, () => f.machine)),
  ];
  log("harness", "lanes over the rig's machines", {
    places: places.map((p) => p ?? "leader"),
  });
  return (lane) => {
    const k = Number(/^lane-(\d+)$/.exec(lane)?.[1]);
    if (!Number.isInteger(k) || k < 1) return undefined;
    const at = places[(k - 1) % places.length];
    return at === undefined ? undefined : away.get(at);
  };
}
