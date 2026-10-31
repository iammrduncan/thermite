import type { ReachEntry } from "../../../core/reach.ts";
import type { ClusterRig } from "../../store/index.ts";
import { esc } from "../components/index.ts";
import { listText } from "../words/index.ts";

/**
 * A cluster rig's network on its page, in words: what its harness reaches beside the internet
 * (the list of addresses cluster rigs may reach, also in Settings), and, in a slot, a warning when
 * the slot's rules let more than the rig's supervisor connect to the harness. Plain text but where
 * a name says HTML.
 */

/** "port 8000", "ports 8000 and 8443". */
export const portsWords = (ports: number[]) =>
  `port${ports.length === 1 ? "" : "s"} ${listText(ports.map(String))}`;

/** "fd7a:115c:a1e0::7 on port 8000 (the model server)". */
export const reachEntryWords = (e: { address: string; ports: number[]; note?: string }) =>
  `${e.address} on ${portsWords(e.ports)}${e.note ? ` (${e.note})` : ""}`;

/**
 * What a cluster rig's harness reaches beside DNS and the internet, as HTML: in a namespace
 * control made, the list as it is now, which control writes into its network rules; in a slot,
 * what of the list the slot's rules opened when control added the rig.
 */
export function rigReachHtml(r: ClusterRig, list: ReachEntry[]): string {
  const settings = `<a href="/ui/settings#reach">the list in Settings</a>`;
  if (r.placement === "slot") {
    const open = r.spec.openings ?? [];
    return open.length
      ? `DNS, the internet, and what the slot's rules open of ${settings}: ${esc(listText(open.map((o) => `${reachEntryWords(o)}, by the rule "${o.rule}"`)))}`
      : "DNS and the internet, as the slot's rules say";
  }
  return list.length
    ? `DNS, the internet, and ${settings}: ${esc(listText(list.map(reachEntryWords)))}`
    : `DNS and the internet; ${settings} is empty`;
}

/** The rule that lets only a slot rig's supervisor connect to its harness, as its operators apply it. */
export const supervisorOnlyRule = (
  rig: string,
  namespace: string,
) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: thermite-${rig}-harness-in
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/instance: ${rig}
      app.kubernetes.io/component: harness
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/instance: ${rig}
              app.kubernetes.io/component: supervisor
      ports:
        - { port: 8700, protocol: TCP }
`;

/**
 * The warning a slot rig's page shows when its slot's rules let more than its supervisor connect
 * to its harness, with the rule that would close it (HTML); nothing otherwise. The rig works
 * either way.
 */
export function slotIngressWarning(r: ClusterRig): string {
  const i = r.spec.ingress;
  if (r.placement !== "slot" || !i || i.ok) return "";
  return `<div class="card warn" style="margin-top:10px" data-part="slot-ingress"><b class="warn">Other pods can connect to this rig's harness.</b> <span class="small">In the slot ${esc(r.namespace)}, ${esc(i.why)}. The rig works: its harness asks for a token on every route but its health. To let only the rig's supervisor in, ask the cluster's operators to apply this rule, and to take out or narrow the rule named above: rules add up, so a rule that lets other pods in still does. Then press Check again on the cluster in Settings.</span><pre class="mono small" style="margin:8px 0 0">${esc(supervisorOnlyRule(r.rig, r.namespace))}</pre></div>`;
}
