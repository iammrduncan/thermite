import type { Bus, BusRequest } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { filterInTurn } from "../../common/in-turn.ts";
import {
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
 * supervisor's figures, the screens of the trials watched, its daily report, a command's newest
 * form, what it keeps of the kinds a retention policy may remove there, and which of the knowledge
 * base's files it put control holds. Each ask comes on the rig's own subject, which only its user
 * may publish to, and is answered at the rig's own inbox alone. A refusal is an answer in words.
 */

/** What answering needs of control: its store, its build, its signing key, the screens watched. */
export interface RigAsksDeps {
  store: ControlStore;
  control: BuildInfo;
  privateKeyPem: string;
  screens: Screens;
}

type Answer = object;

/** Control's answer to one ask of a rig, a refusal in words included. `raw` is its body. */
export async function answerRigAsk(
  d: RigAsksDeps,
  rig: string,
  kind: RigAskKind,
  raw: unknown,
): Promise<Answer | RigAskRefusal> {
  const read = RIG_ASKS[kind].body.safeParse(raw);
  if (!read.success)
    return {
      refused: `the ${kind} is not one control takes: ${read.error.issues.map((i) => `${i.path.join(".") || kind}: ${i.message}`).join("; ")}`,
    };
  const { store } = d;
  // Refused while the rig's recorded builds and control's do not meet, as its reports are; its
  // figures are not taken then, but answered with control's place in its reports, where a page
  // control refused meanwhile goes again once the rig runs a build control works with.
  const refused = await checkRig(store, rig, d.control);
  if (refused) {
    await store.refusals.countCall(rig);
    return kind === "figures" ? { reports: await reportPlace(store, rig) } : { refused };
  }
  switch (kind) {
    case "figures": {
      await takeFigures(store, rig, RIG_ASKS.figures.body.parse(raw));
      return { ok: true, reports: await reportPlace(store, rig) };
    }
    case "screens": {
      const { frames } = RIG_ASKS.screens.body.parse(raw);
      d.screens.take(rig, frames);
      // With the keys the owner pressed since (goal 187), and, while the owner types, a sooner ask.
      const keys = d.screens.takeKeys(rig);
      return {
        watch: d.screens.watched(rig),
        ...(keys.length ? { keys } : {}),
        ...(d.screens.typing(rig) ? { soon: true } : {}),
      };
    }
    case "daily": {
      const b = RIG_ASKS.daily.body.parse(raw);
      return { id: await store.rigReports.add(rig, b.kind, b.body) };
    }
    case "renew": {
      const b = RIG_ASKS.renew.body.parse(raw);
      return renewCommand(store, d.privateKeyPem, rig, b.id);
    }
    case "space": {
      await store.retention.takeSpace(rig, RIG_ASKS.space.body.parse(raw));
      return { ok: true };
    }
    case "kb-files": {
      // The files of those asked that control keeps, each checked against its SHA-256 as it was
      // kept (control/kb/files.ts), and named by an item it stored: the harness removes them from
      // the rig's outbox. A file whose item has not come yet stays there, as an orphan control may
      // remove (the knowledge base's settings) would otherwise be lost to the item that names it.
      const { files } = RIG_ASKS["kb-files"].body.parse(raw);
      const kb = store.kb();
      return {
        held: await filterInTurn(
          files,
          async (f) => (await kb.files.has(f)) && (await kb.files.named(f)),
        ),
      };
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
export async function answerStaysWithRig(
  store: ControlStore,
  rig: string,
  reply: string | undefined,
): Promise<boolean> {
  if (!reply) return false;
  if (reply.startsWith(`${rigInboxPrefix(rig)}.`)) return true;
  return (
    reply.startsWith(SERVICE_IMPORT_REPLY) && (await leafRigsOf(store)).some((l) => l.rig === rig)
  );
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
    if (!(await answerStaysWithRig(d.store, at.rig, r.reply))) {
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
      return JSON.stringify(await answerRigAsk(d, at.rig, at.kind, body));
    } catch (err) {
      const what = { rig: at.rig, kind: at.kind, error: errorText(err) };
      log("control", "a rig's ask failed on control", what, "error");
      return JSON.stringify({
        refused: `control failed to answer the ${at.kind}: ${errorText(err)}`,
      });
    }
  });
}
