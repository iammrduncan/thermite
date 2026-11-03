import { listText } from "../../../core/words.ts";
import type { StoredEvent } from "../../views/index.ts";
import type { Sentence, SentenceContext } from "./context.ts";
import { clip } from "./shared.ts";

const COMMAND: Record<string, string> = {
  approve_promotion: "approve a promotion",
  message_agent: "message an agent",
  pause_run: "pause the run",
  resume_run: "resume the run",
  close_run: "close the run",
  reset_workers: "reset the workers",
  redirect: "steer the planner",
  accept_review: "decide a review",
  conclude: 'decide a "not possible" proposal',
  export_now: "export now",
  rig_check: "check the rig",
  decline_promotion: "decline a promotion",
  assign_campaign: "assign a campaign",
  propagate: "import another rig's champion",
  wipe_state: "wipe the rig's state",
  invalidate_evidence: "withdraw evidence",
  end_wait: "end the agents' wait for the provider",
  terminal_input: "type into an agent's terminal",
};
export const commandText = (kind: string) => COMMAND[kind] ?? kind.replace(/_/g, " ");

/**
 * The rig and its agents, in words: its settings, other rigs' champions, the owner's commands,
 * the rig's checks, the agents' model and their MCP servers.
 */
export function rigSentence(w: SentenceContext, e: StoredEvent): Sentence | null {
  const { b, who, s } = w;
  switch (e.kind) {
    case "rig_settings_changed": {
      const said = settingsText((b.change ?? {}) as Record<string, unknown>);
      return s(`${who(e.actor)} changed the rig's settings${said ? `: ${said}` : ""}.`);
    }
    case "propagation_received":
      return s(
        `Champion #${String(b.source_seq)} arrived from ${String(b.source_rig)} to be judged here.`,
        "",
        { run: String(e.subject) },
      );
    case "propagation_accepted":
      return s("Another rig's champion held up here too.", "ok", { run: String(e.subject) });
    case "propagation_rejected":
      return s(
        `Another rig's champion did not hold up here (${String(b.verdict ?? "").replace(/_/g, " ")}).`,
        "bad",
        { run: String(e.subject) },
      );
    case "command":
      return s(
        `Your command "${commandText(String(b.kind ?? ""))}" was ${b.accepted === false ? "refused" : "applied"}.`,
        b.accepted === false ? "bad" : "",
      );
    case "rig_check_started":
      return s(
        `The ${checkName(String(b.check ?? ""))} check started${b.force ? " (forced)" : ""}.`,
      );
    // The model provider decides when agents can work (goal 079).
    case "agents_stopped":
      return s(
        `The agents stopped: ${String(b.said ?? b.kind ?? "the provider refuses")} (${clip(String(b.words ?? ""), 200)}). No trial starts until a model check passes.`,
        "bad",
        { run: String(e.subject) },
      );
    case "agents_resumed":
      return s(`The agents go on: ${String(b.why ?? "a model check passed")}.`, "ok", {
        run: String(e.subject),
      });
    case "agents_wait_for_limit":
      return s(
        `The agents wait for the provider's limit until ${String(b.until ?? "?")
          .replace("T", " ")
          .slice(0, 16)} UTC${b.reason ? ` (${clip(String(b.reason), 160)})` : ""}.`,
        "warn",
        { run: String(e.subject) },
      );
    case "agents_wait_ended":
      return s(
        `${who(e.actor)} ended the agents' wait for the provider's limit, which was to last until ${String(
          b.until ?? "?",
        )
          .replace("T", " ")
          .slice(0, 16)} UTC: new trials and plans start again.`,
        "ok",
        { run: String(e.subject) },
      );
    case "model_route_set":
      return s(
        `The agents now use model route "${String(b.name ?? "?")}" (${String(b.model ?? "?")}, version ${String(b.version ?? "?")}).`,
        "ok",
      );
    case "model_route_cleared":
      return s(
        b.source === "none"
          ? "The agents have no model route now: they wait for one."
          : `The agents are back on the rig's own model settings${b.model ? ` (${String(b.model)})` : ""}.`,
        b.source === "none" ? "warn" : "",
      );
    case "rig_check_finished":
      return s(
        `The ${checkName(String(b.check ?? ""))} check ${b.ok === true ? "passed" : "FAILED"}: ${String(b.summary ?? "")}`,
        b.ok === true ? "ok" : "bad",
      );
    case "command_rejected":
      return s(
        `A command${b.kind ? ` ("${commandText(String(b.kind))}")` : ""}${b.id ? `, ${String(b.id).slice(0, 8)},` : ""} was refused: ${String(b.reason ?? "")}.`,
        "bad",
      );
    // The MCP servers a run's kit names (goal 068): which agents get each, and when one fails.
    case "mcp_servers": {
      const servers = Array.isArray(b.servers)
        ? (b.servers as { name?: string; agents?: string[] }[])
        : [];
      return s(
        `The run's agents can use ${servers.length === 1 ? "an MCP server" : "MCP servers"}: ${servers.map((x) => `${String(x.name)} for ${listText((x.agents ?? []).map((a) => `the ${a}`))}`).join("; ")}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "mcp_server_failed":
      return s(
        `The MCP server ${String(b.server)} failed for the ${String(b.agents)}${b.error ? `: ${clip(String(b.error), 200)}` : ""}. The run goes on without it.`,
        "warn",
        { run: String(e.subject) },
      );
    case "mcp_server_back":
      return s(
        `The MCP server ${String(b.server)} works again for the ${String(b.agents)}.`,
        "ok",
        {
          run: String(e.subject),
        },
      );
    // The run's first plan or trial on the rig waited for its MCP servers (goal 068).
    case "mcp_servers_wait": {
      const missing = Array.isArray(b.missing)
        ? (b.missing as { name?: string; why?: string }[])
        : [];
      const waited = Number(b.waited_s ?? 0);
      const after = waited > 0 ? `, after waiting ${waited} s for them` : "";
      return missing.length
        ? s(
            `The run's work started without the MCP ${missing.length === 1 ? "server" : "servers"} ${missing.map((m) => `${String(m.name)} (${clip(String(m.why ?? ""), 200)})`).join("; ")}${after}. A later trial gets each one once the rig has it.`,
            "warn",
            { run: String(e.subject) },
          )
        : s(
            `The run's work waited ${waited} s for its MCP servers to reach the rig, then started with them.`,
            "",
            { run: String(e.subject) },
          );
    }
    // An event of v0.1.0 the bus can't carry as it was, moved at control's upgrade (move.ts).
    case "legacy": {
      const size = typeof b.bytes === "number" ? b.bytes : undefined;
      return s(
        `An event of v0.1.0, kept under the kind legacy because the message bus can't carry it as it was: its own kind is "${clip(String(b.kind), 80)}".${size === undefined ? "" : ` It was ${size} bytes, more than a message holds, so its body is only in the copy of control's store kept at the upgrade.`}`,
      );
    }
    default:
      return null;
  }
}

const SETTING_PART: Record<string, string> = {
  judge: "the judge",
  workers: "the workers",
  planner: "the planner",
  auditor: "the auditor",
  teachers: "the teachers",
  review: "the review panel",
  exports: "exports",
};

/** A change to a rig's settings (Edit rig) in words: "the planner off, 3 lanes". */
function settingsText(change: Record<string, unknown>): string {
  return Object.entries(change)
    .map(([k, v]) => {
      const n = Number(v);
      if (k in SETTING_PART) return `${SETTING_PART[k]} ${v === false ? "off" : "on"}`;
      if (k === "lanes") return `${n} lane${n === 1 ? "" : "s"}`;
      if (k === "trial_minutes") return `trials of ${n} min`;
      if (k === "max_turns") return v === null ? "no turn limit" : `at most ${n} turns a trial`;
      if (k === "quiet_minutes")
        return v === null
          ? "a quiet trial asks you nothing"
          : `a trial quiet for ${n} min asks you`;
      if (k === "program_mode")
        return v === "terminal"
          ? "agent programs in their own terminal"
          : "agent programs headless";
      if (k === "promotion")
        return v === "auto" ? "confirmed wins kept at once" : "confirmed wins wait for you";
      if (k === "judge_gpus")
        return v === null
          ? "the judge's usual share of GPUs"
          : `${n} GPU${n === 1 ? "" : "s"} for the judge`;
      return `${k.replace(/_/g, " ")} ${String(v)}`;
    })
    .join(", ");
}

/** A rig check's name in words. */
export function checkName(check: string): string {
  return { model: "model route", isolation: "isolation", smoke: "smoke" }[check] ?? check;
}
