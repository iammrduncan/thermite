import type { GitAuth } from "../../common/git-auth.ts";
import type { RigConfig } from "./bus.ts";

/**
 * A Git access for a private repository, from the rig's config on the message bus (goal 168, step
 * 5c): control puts there the accesses the rig's live assignments name, sealed to the rig, and
 * takes one out when its assignment ends. The supervisor uses one only to stage a project, and for
 * its host only.
 */

/**
 * How long staging waits for an access the config does not hold yet: control writes it within a
 * few seconds of the assignment that names it, which may reach the rig first.
 */
export const GIT_ACCESS_WAIT_MS = 120_000;
/** How often staging looks again meanwhile. */
const LOOK_MS = 1_000;

/**
 * The access by name, with the host it is for, once the config holds it. Throws in words when it
 * did not come within `waitMs`.
 */
export async function gitAccessFrom(
  known: RigConfig,
  name: string,
  waitMs = GIT_ACCESS_WAIT_MS,
): Promise<{ auth: GitAuth; host: string }> {
  const until = Date.now() + waitMs;
  for (;;) {
    const g = known.get("git-access")?.accesses.find((a) => a.name === name);
    if (g?.kind === "ssh")
      return { auth: { kind: "ssh", privateKey: g.private_key }, host: g.host };
    if (g?.kind === "token")
      return { auth: { kind: "token", token: g.token, username: g.username }, host: g.host };
    if (Date.now() >= until)
      throw new Error(
        `Git access ${name}: control gave this rig none in its config on the message bus. Control gives an access only while a live assignment of the rig names it, and only when it can open it`,
      );
    await new Promise((r) => setTimeout(r, LOOK_MS));
  }
}
