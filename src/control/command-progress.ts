import { harnessConfirmed } from "./issue/index.ts";
import { sameModel } from "./providers/index.ts";
import type { CommandRow, ControlStore } from "./store/index.ts";
import { type RigCheckView, type RigModelView, readModelInfo, rigChecks } from "./views/index.ts";

/**
 * What became of an owner's action that control sent to a rig, in words (goal 080). The
 * dashboard's buttons say at once that a click took, then follow the action to its outcome with a
 * small poll: each follow route answers a Progress. A new `state` means the page has something
 * new to show; `final` means nothing more will come, and the button comes back.
 */
export interface Progress {
  state: string;
  final: boolean;
  /** One line in words for beside the button; "" when the page shows the state itself. */
  said: string;
  tone: "" | "ok" | "bad";
  /** At the end, the page loads again: a run that started opens its own page there. */
  reload?: boolean;
}

/** An export_now's payload in words (goal 103): what was asked for, and what the rig made. */
export function exportWords(p: { full?: unknown; run?: unknown }) {
  const run = typeof p.run === "string" ? p.run : undefined;
  const full = p.full === true;
  return {
    asked: run
      ? `An export of ${run} alone was asked for.`
      : full
        ? "A full export was asked for."
        : "An export was asked for.",
    made: (name: string) =>
      `It made ${run ? `the export of ${run}` : full ? "the full export" : "export"} ${name}.`,
  };
}

/** Where an export the owner asked for shows, in words (after "Sent", and once the rig did it). */
export const EXPORT_WHERE =
  "When all its files reach control, it shows on the Exports page, ready to download. A rig with a results repository pushes it there instead.";

/** A time of day as the dashboard writes it: "03:41 UTC". */
export const clockUtc = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/**
 * How long something has run, as a running check's chip says it: "45 s", "1 m 12 s", "2 h 5 m".
 * The page script counts on with the same words (ui/commands/client.ts, fwElapsed).
 */
export function elapsedWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

/** A sentence ends with a stop, and starts with a capital: the rig's own words may not. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where the dashboard's script follows a command it sent (GET, with the owner's session). */
export const commandFollowUrl = (id: string): string =>
  `/ui/commands/${encodeURIComponent(id)}.json`;

/** Control refused to send an action: its words, as the script shows them, and the button back. */
export const notSent = (why: string): Progress => ({
  state: "refused",
  final: true,
  tone: "bad",
  said: `Not sent: ${sentence(capital(why.trim() || "control refused it"))}`,
});

/** A command the rig never took: its signature ran out first. */
export const commandExpired = (cmd: CommandRow, now: number): boolean =>
  cmd.status === "expired" || (cmd.status === "pending" && Date.parse(cmd.expires_at) < now);

/**
 * Why the rig did not do a command, in words, or null when it did it or has not answered. Each
 * place the reason can come from: the harness's answer, the supervisor's staging, the rig's
 * refusal of the signature, or the owner who withdrew it.
 */
export function refusalOf(cmd: CommandRow): string | null {
  const o = (cmd.outcome ?? {}) as {
    accepted?: boolean;
    error?: unknown;
    reason?: unknown;
    cancelled_by?: unknown;
    result?: { error?: unknown };
  };
  const failed = cmd.status === "failed" || cmd.status === "rejected" || o.accepted === false;
  if (!failed) return null;
  if (typeof o.cancelled_by === "string") return "it was cancelled before the rig took it";
  const why = o.result?.error ?? o.error ?? o.reason;
  return typeof why === "string" && why.trim() ? why.trim() : `the rig answered ${cmd.status}`;
}

/** The id of the check the rig started for a rig_check command, from its answer. */
const startedId = (cmd: CommandRow): string | null => {
  const id = (cmd.outcome as { result?: { id?: unknown } } | null)?.result?.id;
  return typeof id === "string" ? id : null;
};

/**
 * A command's progress: sent, taken (the rig did it; its report with the change is still to
 * come), done (that report reached control: the page shows the change), refused or expired. A
 * started run (assign_campaign) loads its page again when done: the run's page opens.
 */
export function commandProgress(cmd: CommandRow, now: number): Progress {
  const p = commandProgressOnly(cmd, now);
  if (p.tone === "bad") return p;
  // Withdraw evidence (goal 174): a preview's answer shows on the attempt's page, to confirm.
  if (cmd.kind === "invalidate_evidence" && p.state === "done")
    return {
      ...p,
      said: `${p.said} ${cmd.payload.preview === true ? "What it would reach is on the attempt's page: confirm it there." : "The evidence is withdrawn."}`,
    };
  if (cmd.kind !== "export_now") return p;
  // An export the owner asked for (goal 103): which kind, and where it will show.
  const words = exportWords(cmd.payload as { full?: unknown; run?: unknown });
  const made = (cmd.outcome as { result?: { export?: unknown } } | null)?.result?.export;
  const what = p.state === "done" && typeof made === "string" ? words.made(made) : words.asked;
  return { ...p, said: `${p.said} ${what} ${EXPORT_WHERE}` };
}

function commandProgressOnly(cmd: CommandRow, now: number): Progress {
  const rig = cmd.rig;
  if (commandExpired(cmd, now))
    return {
      state: "expired",
      final: true,
      tone: "bad",
      said: `${rig} did not take it before ${clockUtc(cmd.expires_at)}, so it expired.`,
    };
  if (cmd.status === "pending")
    return {
      state: "sent",
      final: false,
      tone: "",
      said: `Sent to ${rig} at ${clockUtc(cmd.issued_at)}. Waiting for the rig to take it.`,
    };
  const why = refusalOf(cmd);
  if (why !== null)
    return {
      state: "refused",
      final: true,
      tone: "bad",
      said: `${rig} refused it: ${sentence(why)}`,
    };
  const took = clockUtc(cmd.acked_at ?? cmd.issued_at);
  if (!harnessConfirmed(cmd.outcome))
    return {
      state: "taken",
      final: false,
      tone: "",
      said: `${rig} took it at ${took}. This page shows the change when the rig next reports.`,
    };
  return {
    state: "done",
    final: true,
    tone: "ok",
    said: `Done. ${rig} took it at ${took}.`,
    ...(cmd.kind === "assign_campaign" ? { reload: true } : {}),
  };
}

/** A rig check's row: its state now, from the rig's events and the owner's newest command. */
export interface CheckRow {
  state: "none" | "sent" | "running" | "passed" | "failed" | "refused" | "expired";
  /** The check's newest run that reached control, if any: its result shows when no other does. */
  last: RigCheckView | undefined;
  /** When it started (running): its chip counts the time from here. */
  since: string | null;
  /** Sent: when control queued it. Refused: when the rig answered. Expired: when it ran out. */
  at: string | null;
  /** Refused: the rig's reason, as a sentence. */
  why: string | null;
}

/**
 * A rig check's row on the rig's page (goal 080), from the check's newest run that reached
 * control (`last`) and the newest rig_check command for it (`cmd`):
 * - sent: control queued the command and the rig has not taken it;
 * - running: the rig took it (its answer names the check it started), or reported the start;
 * - passed or failed: the result of the newest run;
 * - refused or expired: the newest command did not run; the last result stays beside the reason.
 * A run of the check that started after the command was sent, or that still runs, is newer than
 * the command (the rig ran it by itself, or will refuse the command for it), and shows.
 */
export function checkRow(
  check: string,
  last: RigCheckView | undefined,
  cmd: CommandRow | undefined,
  now: number,
): CheckRow {
  const row = (state: CheckRow["state"], o: Partial<CheckRow> = {}): CheckRow => ({
    state,
    last,
    since: null,
    at: null,
    why: null,
    ...o,
  });
  const fromRig = (): CheckRow =>
    !last
      ? row("none")
      : last.finished_at === null
        ? row("running", { since: last.started_at })
        : row(last.ok ? "passed" : "failed");
  if (!cmd || cmd.payload.check !== check) return fromRig();
  const after = (iso: string) => Date.parse(iso) >= Date.parse(cmd.issued_at);
  if (cmd.status === "delivered" && refusalOf(cmd) === null) {
    const id = startedId(cmd);
    // The command's own run reached control (by its id; an older rig's answer has none), or a
    // run newer than the command did: the rig ran the check again by itself, after the command.
    if (last && ((id !== null && last.id === id) || after(last.started_at))) return fromRig();
    return row("running", { since: cmd.acked_at ?? cmd.issued_at });
  }
  if (last && (after(last.started_at) || last.finished_at === null)) return fromRig();
  if (commandExpired(cmd, now)) return row("expired", { at: cmd.expires_at });
  if (cmd.status === "pending") return row("sent", { at: cmd.issued_at });
  return row("refused", {
    at: cmd.acked_at ?? cmd.issued_at,
    why: sentence(capital(refusalOf(cmd) ?? "")),
  });
}

/** Whether a check's row waits for something more: the page follows it until it does not. */
export const checkWaits = (row: CheckRow): boolean =>
  row.state === "sent" || row.state === "running";

/**
 * Each rig check's row for one rig: its newest run on the rig's current ledger and the newest
 * command for it. Reads only the checks the rig's fold holds and the commands, so the rows can be
 * followed often without building the rig's whole view.
 */
export function checkRows(store: ControlStore, rig: string, now: number): Record<string, CheckRow> {
  return checkRowsOf(store, rig, rigChecks(store, rig), now);
}

/** The rows from the checks' runs a caller has already (the rig's view has them). */
export function checkRowsOf(
  store: ControlStore,
  rig: string,
  runs: Record<string, RigCheckView>,
  now: number,
): Record<string, CheckRow> {
  const newest: Record<string, CommandRow> = {};
  for (const c of store.commands.latest(rig, "rig_check")) {
    const k = String(c.payload.check ?? "");
    if (k && !newest[k]) newest[k] = c;
  }
  const out: Record<string, CheckRow> = {};
  for (const k of new Set(["model", "isolation", "smoke", ...Object.keys(runs)]))
    out[k] = checkRow(k, runs[k], newest[k], now);
  return out;
}

/**
 * A check's row as its follow route answers it: the page draws the row itself. While the check
 * runs, each report from the rig (its `cursor`) is a new state, so the page also shows what the
 * check does meanwhile, such as the smoke check's run under At work.
 */
export const checkProgress = (row: CheckRow, cursor?: number): Progress => ({
  state: row.state === "running" && cursor !== undefined ? `running:${cursor}` : row.state,
  final: !checkWaits(row),
  said: "",
  tone: "",
});

/**
 * Whether a rig's report shows another model for its workers than control gives it (Providers'
 * Use, Edit rig's Workers): the rig takes a new model route within a minute, then checks it.
 */
export function takingModel(
  m: RigModelView | null,
  want: { provider: string; model: string; harness: string } | undefined,
): boolean {
  if (!m) return false;
  if (!want) return m.source === "control";
  return !(
    m.source === "control" &&
    m.name === want.provider &&
    sameModel(m.model, want.model) &&
    m.harness === want.harness
  );
}

/** Where the page follows a rig taking a new model. */
export const modelFollowUrl = (rig: string): string =>
  `/ui/rigs/${encodeURIComponent(rig)}/model.json`;

/**
 * A rig's workers' model as the page follows it (goal 080): taking, until the rig's report names
 * the model control gives it; then its model check, which the rig runs by itself, to its result.
 */
export function modelProgress(store: ControlStore, rig: string, now: number): Progress {
  const r = store.reportedRigs.list().find((x) => x.id === rig);
  const m = readModelInfo((r?.summary as { model?: unknown } | null)?.model);
  if (takingModel(m, store.agentModels.byRig()[rig]))
    return { state: "taking", final: false, said: "", tone: "" };
  const chk = checkRows(store, rig, now).model;
  return {
    state: `taken:${chk?.state ?? "none"}`,
    final: !chk || !checkWaits(chk),
    said: "",
    tone: "",
  };
}
