import type { Hono } from "hono";
import { errorText } from "../../common/errors.ts";
import { COMMAND_KINDS, type CommandKind } from "../../core/commands.ts";
import {
  checkProgress,
  checkRow,
  checkRows,
  clockUtc,
  commandFollowUrl,
  commandProgress,
  notSent,
  type Progress,
} from "../command-progress.ts";
import { issueWaking } from "../issue/index.ts";
import { formPayload } from "../ui/commands/index.ts";
import { EXPORT_WHERE, exportForm } from "../ui/exports.ts";
import { checkFollowUrl } from "../ui/rigs/checks.ts";
import { backTo, type Dashboard, wantsJson } from "./context.ts";

/**
 * A command from any of the dashboard's command forms (cmdForm): checked, signed and sent to
 * its rig, then followed by the page's script, or the page again with what was sent.
 */
export function commandRoutes(app: Hono, dash: Dashboard): void {
  const { opts, store } = dash;

  app.post("/ui/commands", async (c) => {
    const f = await c.req.parseBody();
    const kind = String(f.kind) as CommandKind;
    if (!COMMAND_KINDS.includes(kind)) return c.text("unknown command", 400);
    const run = String(f.run ?? "");
    // Kinds the rig's harness doesn't know yet are refused above (COMMAND_KINDS).
    const payload = formPayload(kind, f);
    // The page's script sends the form with fetch and follows the command (goal 080): it takes
    // JSON. A plain form post gets the page again, which says "Sent".
    const json = wantsJson(c);
    if (payload === undefined) {
      const why = "this command is not available from the dashboard";
      return json ? c.json(notSent(why), 400) : c.text(why, 400);
    }
    // Close run (goal 087) takes the owner's reason and the typed words, as its form asks.
    const closing =
      kind === "invalidate_evidence"
        ? String(f.reason ?? "").trim()
          ? ""
          : "write why you withdraw it first"
        : kind === "hypothesis_status"
          ? String(f.reason ?? "").trim()
            ? ""
            : "write why you change the hypothesis first"
          : kind !== "close_run"
            ? ""
            : !String(f.reason ?? "").trim()
              ? "write why you close the run first"
              : String(f.confirm ?? "").trim() !== `close ${run}`
                ? `type close ${run} to confirm`
                : "";
    if (closing) return json ? c.json(notSent(closing), 400) : c.text(`refused: ${closing}`, 400);
    let woke: string | null;
    let id: string;
    try {
      // A run resumed on a stopped RunPod pod starts the pod first.
      ({ id, woke } = await issueWaking(store, opts.privateKeyPem, opts.runpodRigs, {
        rig: String(f.rig),
        kind,
        payload,
        issuedBy: "owner:ui",
        owner: true,
      }));
    } catch (err) {
      const why = errorText(err);
      return json ? c.json(notSent(why), 400) : c.text(`refused: ${why}`, 400);
    }
    const now = Date.now();
    const cmd = store.commands.row(id);
    // A check's row says how it stands itself; any other command says it beside its button.
    const check = kind === "rig_check" ? String(f.check ?? "") : "";
    const progress: Progress = check
      ? checkProgress(
          checkRows(store, String(f.rig), now)[check] ?? checkRow(check, undefined, cmd, now),
        )
      : cmd
        ? commandProgress(cmd, now)
        : { state: "sent", final: false, said: "", tone: "" };
    if (json)
      return c.json({
        ...progress,
        said: [woke ?? "", progress.said].filter(Boolean).join(" "),
        follow: check ? checkFollowUrl(String(f.rig), check) : commandFollowUrl(id),
      });
    // The page says the command went; the rig's answer shows where the command was given.
    const to = backTo(f, `/ui/rigs/${encodeURIComponent(String(f.rig))}`);
    const [path, hash] = to.split("#");
    const sent = `${woke ? `${woke} ` : ""}Sent to ${String(f.rig)} at ${clockUtc(cmd?.issued_at ?? new Date(now).toISOString())}.${kind === "export_now" ? ` ${exportForm(f).asked} ${EXPORT_WHERE}` : ""}`;
    return c.redirect(
      `${path}${path?.includes("?") ? "&" : "?"}sent=${encodeURIComponent(sent)}${hash ? `#${hash}` : ""}`,
      303,
    );
  });
}
