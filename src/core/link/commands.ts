import type { ConsumerConfig, StreamConfig } from "@nats-io/jetstream";
import { z } from "zod";
import { COMMAND_MAX_BYTES, type SignedCommand } from "../commands.ts";
import { RIG_ID } from "../ids.ts";

/**
 * The link's second contract (goal 168, step 1): control's commands to a rig on the message bus.
 * A message is one command exactly as control signed and recorded it. Control publishes it to the
 * rig's subject; the rig's supervisor takes it from its own consumer, delivers it to its harness,
 * and acks it once control has the outcome. The signer is control's key, which the harness checks
 * (verifyCommand in core/commands.ts): the supervisor can neither sign nor change a command.
 * Control's store stays the record, and a command's status there the truth.
 */

/** The stream that holds each rig's commands until the rig takes them. */
export const COMMAND_STREAM = "COMMANDS";
/** Every rig's command subject: the stream takes these. */
export const COMMAND_SUBJECTS = "thermite.rig.*.cmd";

/** The subject a rig's commands go on. A rig whose name is not a rig's name has none. */
export function commandSubject(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a command subject: ${rig}`);
  return `thermite.rig.${rig}.cmd`;
}

/** Room kept above the largest command for a message's headers: its id. */
const HEADER_ROOM = 4096;
/** The largest command message, its headers included: the largest signed command, and its id. */
export const COMMAND_MAX_MESSAGE_BYTES = COMMAND_MAX_BYTES + HEADER_ROOM;

/** A command's message id: the command's own, so that a command published twice is kept once. */
export function commandMessageId(cmd: Pick<SignedCommand, "envelope">): string {
  return cmd.envelope.id;
}

/**
 * How many of a rig's commands the stream holds. A full queue refuses the next one, which stays
 * pending on control: the supervisor's poll over HTTP fetches it.
 */
export const COMMAND_QUEUE_MAX = 100;
/**
 * How long the stream holds a command its rig has not taken: a week, the longest life control
 * gives a command. One still pending on control after that reaches the rig over HTTP.
 */
const MAX_AGE_NS = 7 * 24 * 3600 * 1e9;
/**
 * How long the bus remembers a message id, in nanoseconds: as long as it holds a command. Control
 * publishes its pending commands again as it starts, and the stream keeps one message for each
 * command id it knows: one it holds, or one its rig took, is not kept twice.
 */
const DUPLICATE_WINDOW_NS = MAX_AGE_NS;

/**
 * The stream's settings: a work queue, so a command acked by its rig's supervisor is gone. Each
 * rig's queue is limited, and a full one refuses new commands rather than drop old ones.
 */
export const COMMAND_STREAM_CONFIG = {
  name: COMMAND_STREAM,
  subjects: [COMMAND_SUBJECTS],
  description: "Each rig's signed commands, until the rig takes them",
  retention: "workqueue",
  storage: "file",
  max_msgs: -1,
  max_bytes: -1,
  max_age: MAX_AGE_NS,
  max_msgs_per_subject: COMMAND_QUEUE_MAX,
  max_msg_size: COMMAND_MAX_MESSAGE_BYTES,
  discard: "new",
  discard_new_per_subject: true,
  duplicate_window: DUPLICATE_WINDOW_NS,
  num_replicas: 1,
} satisfies Partial<StreamConfig> & { name: string };

/**
 * How long a supervisor may hold a command before the stream hands it again, in nanoseconds:
 * five minutes, for its content to be staged and the harness to answer.
 */
const ACK_WAIT_NS = 5 * 60 * 1e9;

/** The durable consumer a rig's supervisor takes the rig's commands with. */
export function commandConsumerName(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a command consumer: ${rig}`);
  return `rig-${rig}-commands`;
}

/**
 * A rig's consumer: its subject alone, from the first command, in order. A command is acked once
 * control has its outcome; one that waits (its sources still stage) is handed again later, while
 * the commands after it go on, up to as many as the rig's queue holds. Control makes it, for each
 * rig with a user on the bus; the rig's user may only read it and take from it (users.ts).
 */
export function commandConsumerConfig(rig: string) {
  return {
    durable_name: commandConsumerName(rig),
    filter_subject: commandSubject(rig),
    ack_policy: "explicit",
    deliver_policy: "all",
    max_ack_pending: COMMAND_QUEUE_MAX,
    ack_wait: ACK_WAIT_NS,
    max_deliver: -1,
  } satisfies Partial<ConsumerConfig> & { durable_name: string };
}

/** What the supervisor reads of a command: its id, its rig, its kind and when it expires. */
const CommandOnBus = z.looseObject({
  envelope: z.looseObject({
    id: z.uuid(),
    rig: z.string().min(1),
    kind: z.string().min(1),
    expires_at: z.iso.datetime(),
  }),
  signature: z.string().min(1),
});

/**
 * A command from the bus, as the supervisor reads it: the fields it reads are checked, and the
 * command goes on to the harness exactly as it came, a field this build does not know included,
 * since the harness checks control's signature over all of it. Throws when it is not a command.
 */
export function readCommand(data: Uint8Array): SignedCommand {
  const raw: unknown = JSON.parse(new TextDecoder().decode(data));
  CommandOnBus.parse(raw);
  return raw as SignedCommand;
}
