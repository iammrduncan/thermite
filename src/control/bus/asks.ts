import type { Bus, BusRequest } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  PAST_NO_RUN,
  PAST_NOT_ASSIGNED,
  PAST_PAGE_BYTES,
  RIG_ASK_SUBJECTS,
  RIG_ASKS,
  type RigAskKind,
  type RigAskRefusal,
  rigAskOf,
} from "../../core/link/asks.ts";
import { rigInboxPrefix } from "../../core/link/users.ts";
import type { BuildInfo } from "../../core/version.ts";
import { reportPlace } from "../ingest.ts";
import { renewCommand } from "../issue/index.ts";
import type { Screens } from "../live/index.ts";
import { takeFigures } from "../rigs/index.ts";
import type { ControlStore } from "../store/index.ts";
import { checkRig } from "../versions.ts";
import { leafRigsOf } from "./leaf.ts";

/**
 * Control's answers to what a rig asks of it on the message bus (core/link/asks.ts): its
 * supervisor's figures, the screens of the trials watched, its daily report, past research for one
 * of its runs, and a command's newest form. Each ask comes on the rig's own subject, which only its
 * user may publish to, and is answered at the rig's own inbox alone. A refusal is an answer in
 * words.
 */

/** What answering needs of control: its store, its build, its signing key, the screens watched. */
export interface RigAsksDeps {
  store: ControlStore;
  control: BuildInfo;
  privateKeyPem: string;
  screens: Screens;
}

type Answer = object;

/** Past research for a run, as the rig asks it: the page after its cursor, within PAST_PAGE_BYTES. */
function pastPage(store: ControlStore, rig: string, run: string, after: number): Answer {
  // Only a run control assigned to this rig, of the campaign control assigned: a rig cannot read
  // another campaign's collections by naming it in its own events.
  const assigned = store.runRegistry.assignedCampaigns(rig).get(run);
  if (!assigned)
    return { refused: `control did not assign run ${run} to ${rig}`, code: PAST_NOT_ASSIGNED };
  const sync = store.kb().sync(rig, run, after);
  if (!sync) return { refused: `${rig} has no run ${run} on control yet`, code: PAST_NO_RUN };
  if (sync.campaign !== assigned)
    return { refused: `run ${run} is not of the campaign control assigned` };
  return fitPage(sync, PAST_PAGE_BYTES);
}

/**
 * A page of past research within `maxBytes` of items, as JSON: it ends before an item that would
 * pass them, and then says more wait, from the last item it holds. One item always goes.
 */
export function fitPage<T extends { items: { seq: number }[]; next: number; more: boolean }>(
  page: T,
  maxBytes: number,
): T {
  let bytes = 0;
  let n = 0;
  for (const item of page.items) {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (n > 0 && bytes > maxBytes) break;
    n++;
  }
  if (n === page.items.length) return page;
  const items = page.items.slice(0, n);
  return { ...page, items, next: items.at(-1)?.seq ?? page.next, more: true };
}

/** Control's answer to one ask of a rig, a refusal in words included. `raw` is its body. */
export function answerRigAsk(
  d: RigAsksDeps,
  rig: string,
  kind: RigAskKind,
  raw: unknown,
): Answer | RigAskRefusal {
  const read = RIG_ASKS[kind].body.safeParse(raw);
  if (!read.success)
    return {
      refused: `the ${kind} is not one control takes: ${read.error.issues.map((i) => `${i.path.join(".") || kind}: ${i.message}`).join("; ")}`,
    };
  const { store } = d;
  // Refused while the rig's recorded builds and control's do not meet, as its reports are; its
  // figures are not taken then, but answered with control's place in its reports, where a page
  // control refused meanwhile goes again once the rig runs a build control works with.
  const refused = checkRig(store, rig, d.control);
  if (refused) {
    store.refusals.countCall(rig);
    return kind === "figures" ? { reports: reportPlace(store, rig) } : { refused };
  }
  switch (kind) {
    case "figures": {
      takeFigures(store, rig, RIG_ASKS.figures.body.parse(raw));
      return { ok: true, reports: reportPlace(store, rig) };
    }
    case "screens": {
      const { frames } = RIG_ASKS.screens.body.parse(raw);
      d.screens.take(rig, frames);
      return { watch: d.screens.watched(rig) };
    }
    case "daily": {
      const b = RIG_ASKS.daily.body.parse(raw);
      return { id: store.rigReports.add(rig, b.kind, b.body) };
    }
    case "past": {
      const b = RIG_ASKS.past.body.parse(raw);
      return pastPage(store, rig, b.run, b.after);
    }
    case "renew": {
      const b = RIG_ASKS.renew.body.parse(raw);
      return renewCommand(store, d.privateKeyPem, rig, b.id);
    }
  }
}

/** The start of a reply the server makes for a request that came through a service import. */
const SERVICE_IMPORT_REPLY = "_R_.";

/**
 * Whether control's answer to a rig's ask stays with that rig: at its own inbox, or, for a rig on a
 * leaf node (RunPod), at the reply the server made for the leaf account's service import, which
 * the server routes back to that account alone. A rig on control's own server can't take such a
 * reply, so it is refused there.
 */
export function answerStaysWithRig(
  store: ControlStore,
  rig: string,
  reply: string | undefined,
): boolean {
  if (!reply) return false;
  if (reply.startsWith(`${rigInboxPrefix(rig)}.`)) return true;
  return reply.startsWith(SERVICE_IMPORT_REPLY) && leafRigsOf(store).some((l) => l.rig === rig);
}

/**
 * Serves every rig's asks on the message bus until it closes. An ask is answered only at its own
 * rig's inbox (core/link/users.ts), where only that rig's user may read: an ask whose answer would
 * go anywhere else is answered nothing, with a line in control's log.
 */
export function serveRigAsks(bus: Pick<Bus, "serve">, d: RigAsksDeps): Promise<void> {
  return bus.serve(RIG_ASK_SUBJECTS, async (r: BusRequest) => {
    const at = rigAskOf(r.subject);
    if (!at) {
      log("control", "an ask on a subject that is no rig's", { subject: r.subject }, "warn");
      return undefined;
    }
    if (!answerStaysWithRig(d.store, at.rig, r.reply)) {
      const what = { rig: at.rig, kind: at.kind, reply: r.reply ?? null };
      log("control", "a rig's ask refused: its answer would leave its rig's inbox", what, "warn");
      return undefined;
    }
    // Each is answered at once, from control's store, before the next is taken.
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(r.data).toString("utf8"));
    } catch (err) {
      return JSON.stringify({ refused: `the ${at.kind} is not JSON: ${errorText(err)}` });
    }
    try {
      return JSON.stringify(answerRigAsk(d, at.rig, at.kind, body));
    } catch (err) {
      const what = { rig: at.rig, kind: at.kind, error: errorText(err) };
      log("control", "a rig's ask failed on control", what, "error");
      return JSON.stringify({
        refused: `control failed to answer the ${at.kind}: ${errorText(err)}`,
      });
    }
  });
}
