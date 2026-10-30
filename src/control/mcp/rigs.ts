import { z } from "zod";
import {
  bringBackRig,
  type RigSettingsBody,
  rigSettingsAnswer,
  rigSettingsFields,
  rigSettingsRead,
  setRigSettings,
} from "../rigs/index.ts";
import type { ToolContext } from "./context.ts";

/**
 * The rest of Edit rig (goal 029), beside each agent's model (mcp/rig-models.ts): the settings a
 * rig reports, and their changes.
 */
export function registerRigSettings(tools: ToolContext): void {
  const { server, store, opts, actor, role, canCommand, audited } = tools;

  // The rest of Edit rig (goal 029): the settings a rig reports, read by every token but the
  // agent's, as rig_models; changed by the owner's token and an operator's, through the same
  // checks as Save changes. The promotion rule and the GPU split stay the owner's: the rule
  // decides whether a win waits for the owner, and a new split restarts the rig's harness.
  server.registerTool(
    "rig_settings",
    {
      title: "A rig's settings",
      description:
        "The settings a rig reports, as Edit rig shows them. Returns {rig, settings, gpu_split}. settings holds each part on or off (judge, workers, planner, teachers, auditor, review for the review panel, exports), lanes (workers at a time), trial_minutes (how long one trial lasts when the campaign sets no limit; null: no limit), max_turns (turns per trial; null: no limit), quiet_minutes (after how many minutes without a line a trial asks the owner under Needs you; null: never), program_mode (terminal: Claude Code, Codex and OpenCode run each trial in their own terminal, and a worker in Pi in its Pi view; headless: one command for each turn), promotion (auto or owner_approval) and judge_gpus (the judge's share the rig keeps; null: its default); settings is null for a rig whose harness is older and reports none. gpu_split is {set, judge}, the rig's GPU set and the judge's share now, or null for a rig with no GPU set to split. Change them with set_rig_settings; each agent's model is rig_models'.",
      inputSchema: { rig: z.string().min(1) },
    },
    audited("rig_settings", (a: { rig: string }) => {
      const read = rigSettingsRead(store, a.rig);
      if (!read) throw new Error(`no rig ${a.rig}`);
      return read;
    }),
  );
  if (canCommand) {
    const owner = role === "owner";
    server.registerTool(
      "set_rig_settings",
      {
        title: "Change a rig's settings",
        description: `As Save changes on a rig's Edit rig page does, with the same checks and refusals in words: switch the rig's parts on or off (judge, workers, planner, teachers, auditor, review for the review panel, exports), and set lanes (workers at a time), trial_minutes, max_turns, quiet_minutes, program_mode, promotion and judge_gpus; each agent's model is set_rig_model's. Give only what to change; a field left out stays as the rig has it. Control compares each field with what the rig reports (rig_settings) and sends only what differs, as one signed rig_settings command, which the rig takes within a minute; a part turned off keeps all its data. Nothing differing sends nothing: said is "Nothing changed." and id null. judge_gpus is for a rig set up with its set of GPUs (gpu_split in rig_settings): 1 to min(8, set - 1) for the judge, the rest the agents', at most 8; a new split restarts the rig's harness, so running trials and judge jobs start again, and restarts is true. Returns {rig, id, sent, restarts, said}: id, the command's (follow it with command_status); sent, the fields sent. Refused in words: no such rig, a rig whose harness is older and reports no settings, a judge's share out of range or on a rig with no GPU set, and a value the rig_settings command refuses (such as lanes above 16).${owner ? "" : " promotion and judge_gpus are the owner's alone: a change to either is refused."}`,
        inputSchema: { rig: z.string().min(1), ...rigSettingsFields },
      },
      audited("set_rig_settings", (a: RigSettingsBody & { rig: string }) => {
        const { rig, ...body } = a;
        const out = setRigSettings(store, opts.privateKeyPem, rig, body, actor, owner);
        if (out.state === "refused") throw new Error(out.error);
        return rigSettingsAnswer(rig, out);
      }),
    );
  }
}

/** Retiring a rig that is gone, and bringing it back: the owner's, as on the dashboard. */
export function registerRetire(tools: ToolContext): void {
  const { server, store, actor, role, audited } = tools;

  if (role === "owner") {
    server.registerTool(
      "retire_rig",
      {
        title: "Retire a rig",
        description:
          "For a rig that is gone: it leaves the rig lists and the owner's queue, and control refuses its reports until it is brought back. Its runs stay readable by their names, as earlier runs (get_run reads them). A token control made for it ends. Its records stay. It stops nothing on the machine. The owner's token only.",
        inputSchema: {
          rig: z.string().min(1),
          confirm: z.string().describe('"retire <rig>", as on the dashboard'),
        },
      },
      audited("retire_rig", (a: { rig: string; confirm: string }) => {
        if (a.confirm.trim() !== `retire ${a.rig}`)
          throw new Error(`confirm with "retire ${a.rig}"`);
        if (!store.reportedRigs.list().some((u) => u.id === a.rig))
          throw new Error(`no rig ${a.rig}`);
        store.retired.add(a.rig, actor);
        return { rig: a.rig, retired: true };
      }),
    );
    server.registerTool(
      "bring_back_rig",
      {
        title: "Bring a retired rig back",
        description:
          "A retired rig shows again and its reports are taken again. A token control made for it stays ended. The owner's token only.",
        inputSchema: { rig: z.string().min(1) },
      },
      audited("bring_back_rig", async (a: { rig: string }) => {
        if (!(await bringBackRig(store, a.rig, actor))) throw new Error(`${a.rig} is not retired`);
        return { rig: a.rig, retired: false };
      }),
    );
  }
}
