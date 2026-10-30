import { ApiError } from "../../common/api/call.ts";
import { harnessClient } from "../../common/api/harness.ts";
import { buildInfo } from "../../common/build-info.ts";
import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { COMMAND_UNSTAGED, COMMANDS, SNAPSHOT } from "../../core/api/harness/supervisor.ts";
import type { SignedCommand } from "../../core/commands.ts";
import {
  REPORT_MAX_BYTES,
  ReportPlace,
  reportFits,
  reportMessageId,
  reportSubject,
} from "../../core/link/report.ts";
import { buildHeaders } from "../../core/version.ts";

export { followCommands } from "./commands.ts";
export { BUS_KEY_FILE, busKey, busKeyFigure, SEAL_KEY_FILE } from "./key.ts";

/**
 * The supervisor's deterministic relay: the harness's new events go to control's reports stream on
 * the message bus, and control's signed commands, from the bus, go to the harness. It never
 * creates or alters commands; it has no signing key.
 */

/** What the relay needs of the message bus: a publish that waits for the ack, and an ask of control. */
export type RelayBus = Pick<Bus, "publish" | "request">;

export interface RelayConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
  /** Content a command brings: relay it, wait for it, or report that it could not be had. */
  stage?: ((cmd: SignedCommand) => Promise<"ready" | "wait" | { failed: string }>) | undefined;
  /** Told about each relayed command's outcome (a full reset's wipe acts on it). */
  onDelivered?: ((kind: string, accepted: boolean) => void) | undefined;
  /**
   * The commands taken from the bus and not delivered yet, by id, each in the newest form control
   * gave: signed again with a later expiry while its sources stage (relay/commands.ts).
   */
  held?: Map<string, SignedCommand> | undefined;
  /** Of those, the ones whose sources are still being fetched. */
  staging?: Set<string> | undefined;
  /**
   * The ids of the commands whose outcome the harness has, newest last, DELIVERED_KEPT at most: one
   * the message bus hands again is not delivered twice.
   */
  delivered?: Set<string> | undefined;
  /** Turns for delivering commands, one at a time (oneAtATime): never two at the harness at once. */
  turn?: Turn | undefined;
  /** The message bus (goal 168): reports go there, commands come from there. */
  bus: RelayBus;
}

export interface RelayState {
  cursor: number;
  /** The harness ledger the cursor belongs to. A new ledger id means start again at 0. */
  ledgerId?: string | undefined;
  /** Events per report page; halved when a page is too large for the bus. */
  pageLimit?: number | undefined;
  /**
   * The ledger and cursor at the supervisor's last call to control with its figures. The pages
   * before it have had a whole round to reach control (healCursor).
   */
  atLastCall?: { ledgerId: string; cursor: number } | undefined;
  /**
   * Going back after a page control refused (healCursor). One page a round is sent until control's
   * answer shows it took it.
   */
  healing?: boolean | undefined;
}

/** Runs one piece of work after the one before it has ended. */
export type Turn = <T>(work: () => Promise<T>) => Promise<T>;

/** A turn for each piece of work, one at a time, in the order asked. */
export function oneAtATime(): Turn {
  let last: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = last.then(work);
    last = next.catch(() => undefined);
    return next;
  };
}

/** How many delivered commands' ids the supervisor remembers (RelayConfig.delivered). */
const DELIVERED_KEPT = 1000;

/** The events a report page holds when the bus takes them. */
const REPORT_PAGE = 1000;

/** A call that failed, in the relay's words for its log: the route, the status and the answer. */
function inWords(what: string, err: unknown): unknown {
  return err instanceof ApiError && err.status !== undefined
    ? new Error(`${what} -> ${err.status}: ${err.text.slice(0, 300)}`)
    : err;
}

/** The relay's client of its harness's API. */
function harnessOf(cfg: RelayConfig) {
  return harnessClient({ url: cfg.harnessUrl, token: cfg.harnessToken, fetchImpl: cfg.fetchImpl });
}

/** A relay round whose reporting failed; its state still carries any progress made. */
export class RelayError extends Error {
  readonly state: RelayState;

  constructor(message: string, state: RelayState) {
    super(message);
    this.state = state;
  }
}

/**
 * One relay round: the harness's new events, a page at a time, published to the rig's report
 * subject. The cursor advances once the bus's server has a page.
 */
export async function relayOnce(cfg: RelayConfig, state: RelayState): Promise<RelayState> {
  const harness = harnessOf(cfg);
  let cursor = state.cursor;
  let ledgerId = state.ledgerId;
  let pageLimit = state.pageLimit ?? REPORT_PAGE;
  let reportError: unknown;
  const page = (from: number) =>
    harness
      .call(SNAPSHOT, { query: { cursor: from, limit: pageLimit } })
      .catch((err: unknown) => Promise.reject(inWords("snapshot", err)));
  try {
    for (let pages = 0; pages < 10_000; pages++) {
      let snap = await page(cursor);
      if (ledgerId !== undefined && snap.ledger_id !== ledgerId && cursor !== 0) {
        // The harness ledger was reset or replaced: its events are numbered from 1 again.
        log("supervisor", "harness ledger changed; restarting the cursor", {
          from: ledgerId,
          to: snap.ledger_id,
        });
        cursor = 0;
        snap = await page(0);
      }
      ledgerId = snap.ledger_id;
      // A harness signing as another rig is a deployment mistake: say so, never report it on.
      if (typeof snap.rig === "string" && snap.rig !== cfg.rig)
        throw new Error(
          `the harness reports as rig ${snap.rig}, but this supervisor is ${cfg.rig}`,
        );
      // Passed through untouched: the supervisor cannot sign for the harness.
      const body = JSON.stringify(snap);
      if (!reportFits(Buffer.byteLength(body))) {
        const n = snap.events.length;
        if (n <= 1)
          throw new Error(`a report of ${n} events is over the bus's ${REPORT_MAX_BYTES} bytes`);
        pageLimit = Math.floor(n / 2);
        log("supervisor", "report page too large for the bus; halving it", { page: pageLimit });
        continue;
      }
      const id = reportMessageId(snap);
      const ack = await cfg.bus.publish(reportSubject(cfg.rig), body, {
        id,
        headers: buildHeaders(buildInfo()),
      });
      if (ack.duplicate) log("supervisor", "the bus had this report already", { id });
      cursor = snap.next;
      // Sent again from control's place: one page a round, until control has it.
      if (state.healing || snap.events.length < pageLimit) break;
    }
  } catch (err) {
    reportError = err;
  }
  const next: RelayState = { cursor, ledgerId, pageLimit };
  if (state.atLastCall) next.atLastCall = state.atLastCall;
  if (state.healing) next.healing = true;
  if (reportError) throw new RelayError(String(reportError), next);
  return next;
}

/**
 * The relay state after control's answer to the supervisor's figures, which names control's place
 * in the rig's events (ReportPlace). No answer to a page on the bus comes back, so a page control refused (a key that waits for the owner, a build it refuses, a clock
 * ahead) would leave every later page refused as a gap. When control is behind what the
 * supervisor had sent by its last call, a round ago, in the same ledger (at 0 in a ledger control
 * has none of yet), control is not still reading those pages: it refused one. The supervisor goes
 * back to control's cursor and sends again from there, one page a round, until control has taken
 * what it sent. An answer without a place, from an older control, changes nothing.
 */
export function healCursor(state: RelayState, answer: unknown): RelayState {
  const read = ReportPlace.safeParse((answer as { reports?: unknown } | null)?.reports);
  const ledgerId = state.ledgerId;
  if (!read.success || ledgerId === undefined) return state;
  const theirs = read.data.ledger_id === ledgerId ? read.data.cursor : 0;
  const last = state.atLastCall?.ledgerId === ledgerId ? state.atLastCall.cursor : 0;
  // While it heals, the one page it sent since: one control has not taken by now goes again.
  const due = state.healing ? state.cursor : last;
  if (theirs >= due) {
    if (!state.healing && last === state.cursor) return state;
    return { ...state, atLastCall: { ledgerId, cursor: state.cursor }, healing: false };
  }
  log(
    "supervisor",
    "control is behind this rig's reports on the bus; sending again from its cursor",
    { ledger: ledgerId, from: state.cursor, to: theirs },
    "warn",
  );
  return { ...state, cursor: theirs, atLastCall: { ledgerId, cursor: theirs }, healing: true };
}

/**
 * One command from the message bus: its content staged, then the command delivered to the harness,
 * in its turn. True once the harness has its outcome, which reaches control in its events: it
 * applied the command, refused it, or recorded it as not applied when its content could not be
 * staged. False while the command waits (its sources still stage, or the harness is applying it)
 * or a call failed: the bus hands it again. Each command on its own: one's failure never holds up
 * the others.
 */
export async function deliverCommand(cfg: RelayConfig, cmd: SignedCommand): Promise<boolean> {
  const turn = cfg.turn ?? ((work) => work());
  return await turn(() => deliverInTurn(cfg, cmd));
}

/** What the harness answered a command with; "in_progress" while another request applies it. */
type Delivered = "delivered" | "rejected" | "failed" | "in_progress";

/**
 * The harness's answer to a command, as the relay reads it. A refusal (403) is recorded by the
 * harness too, as a command_rejected event. Any other failure leaves nothing recorded: it throws.
 */
async function toHarness(
  call: () => Promise<{ status?: string | undefined; accepted?: boolean | undefined }>,
): Promise<Delivered> {
  try {
    const outcome = await call();
    if (outcome.status === "in_progress") return "in_progress";
    return outcome.accepted === false ? "failed" : "delivered";
  } catch (err) {
    if (err instanceof ApiError && err.code === "forbidden") return "rejected";
    throw err;
  }
}

async function deliverInTurn(cfg: RelayConfig, cmd: SignedCommand): Promise<boolean> {
  const id = cmd.envelope.id;
  if (cfg.delivered?.has(id)) return true;
  const harness = harnessOf(cfg);
  try {
    const staged = cfg.stage ? await cfg.stage(cmd) : "ready";
    if (staged === "wait") {
      cfg.staging?.add(id);
      return false;
    }
    cfg.staging?.delete(id);
    // The content never arrived: the harness records the command as not applied, with why.
    const status =
      staged === "ready"
        ? await toHarness(() => harness.call(COMMANDS, { body: cmd }))
        : await toHarness(() =>
            harness.call(COMMAND_UNSTAGED, { body: { command: cmd, reason: staged.failed } }),
          );
    // Another request is applying it right now: the bus hands it again.
    if (status === "in_progress") return false;
    if (staged === "ready") {
      log("supervisor", "relayed command", { id, kind: cmd.envelope.kind, status });
      cfg.onDelivered?.(cmd.envelope.kind, status === "delivered");
    } else log("supervisor", "command not relayed", { id, error: staged.failed, status });
    remember(cfg.delivered, id);
    cfg.held?.delete(id);
    return true;
  } catch (err) {
    log(
      "supervisor",
      "command relay error",
      { id, error: String(inWords("command", err)) },
      "error",
    );
    return false;
  }
}

/** Keeps a delivered command's id, and forgets the oldest past DELIVERED_KEPT. */
function remember(delivered: Set<string> | undefined, id: string): void {
  if (!delivered) return;
  delivered.add(id);
  for (const old of delivered) {
    if (delivered.size <= DELIVERED_KEPT) break;
    delivered.delete(old);
  }
}
