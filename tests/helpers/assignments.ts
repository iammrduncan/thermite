import type { ControlStore } from "../../src/control/store/index.ts";

/**
 * Control's own record that it assigned a run of a campaign to a rig (a delivered command, in
 * the run registry as control's signing puts it there), with any other fields of the assignment
 * a test needs (its MCP servers, say).
 */
export function assigned(
  store: ControlStore,
  rig: string,
  run: string,
  campaign: string,
  extra: Record<string, unknown> = {},
) {
  const id = `cmd-${rig}-${run}`;
  const at = new Date().toISOString();
  const payload = { run, contract: { campaign }, ...extra };
  // The run and the campaign in their columns too, as the store's enqueue writes them.
  store.db
    .prepare(
      "insert into command (id, rig, kind, signed, issued_by, issued_at, status, run, campaign) values (?, ?, 'assign_campaign', ?, 'owner:ui', ?, 'delivered', ?, ?)",
    )
    .run(id, rig, JSON.stringify({ envelope: { payload } }), at, run, campaign);
  store.runRegistry.registerAssignment({
    id,
    rig,
    kind: "assign_campaign",
    issued_at: at,
    payload,
  });
}
