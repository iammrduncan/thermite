import type { z } from "zod";
import type { SupervisorFigures } from "../../core/api/control/rigs.ts";
import { modelSteps } from "../model-steps.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * A rig's supervisor's figures (unsigned: the supervisor reports itself), as control keeps them:
 * from the registration of its keys over HTTPS, then from its regular call on the message bus. A
 * model download that starts or ends is a step in the rig's history. Its keys are kept apart from
 * the figures, which pages show.
 */
export function takeFigures(
  store: ControlStore,
  rig: string,
  figures: Omit<z.output<typeof SupervisorFigures>, "bus_key" | "bus_seal_key">,
): void {
  const before = store.reportedRigs.supervisor(rig)?.models;
  store.reportedRigs.setSupervisor(rig, figures);
  for (const s of modelSteps(before, figures.models))
    store.rigHistory.add(rig, s.step, s.ok, s.detail);
}
