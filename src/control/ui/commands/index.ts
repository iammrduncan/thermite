import { ago, esc } from "../components/index.ts";

export { FOLLOW_JS } from "./client.ts";
export { formPayload } from "./forms.ts";

/** A command as the Commands page lists it. */
export interface ListedCommand {
  rig: string;
  kind: string;
  issued_by: string;
  issued_at: string;
  status: string;
  outcome: unknown;
}

/**
 * A command's status as a word and a chip's tone. A command the owner cancelled is stored as
 * `failed` with who cancelled it in its outcome: it shows as cancelled, in a neutral tone.
 */
export function commandStatus(x: Pick<ListedCommand, "status" | "outcome">): {
  word: string;
  tone: string;
} {
  const cancelled =
    x.status === "failed" &&
    typeof (x.outcome as { cancelled_by?: unknown } | null)?.cancelled_by === "string";
  if (cancelled) return { word: "cancelled", tone: "" };
  const tone =
    x.status === "delivered"
      ? "ok"
      : x.status === "pending"
        ? "info"
        : x.status === "expired"
          ? ""
          : "bad";
  return { word: x.status, tone };
}

/** One row of the Commands page: when, the rig, the kind, who, the status and the outcome. */
export function commandRow(x: ListedCommand, now: number): string {
  const s = commandStatus(x);
  return `<tr><td class="muted nowrap">${esc(ago(x.issued_at, now))} ago</td><td>${esc(x.rig)}</td><td><b>${esc(x.kind.replace(/_/g, " "))}</b></td><td class="muted">${esc(x.issued_by)}</td><td><span class="chip ${s.tone}">${esc(s.word)}</span></td><td class="clip"><code class="muted">${esc(JSON.stringify(x.outcome ?? "").slice(0, 200))}</code></td></tr>`;
}
