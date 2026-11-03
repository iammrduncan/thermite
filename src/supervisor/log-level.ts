import { setLogLevel } from "../common/log.ts";
import { CommandPayloads, type SignedCommand } from "../core/commands.ts";

/**
 * A `log_level` command for the supervisor, which its harness took (the guide's question 16): the
 * supervisor's own level from now on, until another changes it or the supervisor restarts
 * (core/log-levels.ts). The harness's part is the harness's own, and other kinds are not this.
 * Whether it set the level.
 */
export function onLogLevelTaken(cmd: SignedCommand): boolean {
  if (cmd.envelope.kind !== "log_level") return false;
  const read = CommandPayloads.log_level.safeParse(cmd.envelope.payload);
  if (!read.success || read.data.part !== "supervisor") return false;
  setLogLevel("supervisor", read.data.level, {
    by: `control:${cmd.envelope.issued_by}`,
    command: cmd.envelope.id,
  });
  return true;
}
