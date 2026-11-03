/**
 * The owner's retention policies on control (goal 125, T12; core/retention/ holds what control,
 * the harness and the supervisor share): policies.ts makes, changes and previews them, run.ts runs
 * them at their time or by hand and takes what rigs removed, items.ts reads what each acts on.
 */
export { controlItems, itemsOf, knownRig, rigsOf } from "./items.ts";
export {
  createPolicy,
  deletePolicy,
  type PolicyPreview,
  type PolicyView,
  policyOf,
  policyView,
  policyViews,
  previewOf,
  retentionKinds,
  setPolicyOn,
  specOf,
  updatePolicy,
} from "./policies.ts";
export { RETENTION_LOOK_MS, retentionTick, runPolicy, takeRigRemoval } from "./run.ts";
