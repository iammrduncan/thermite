/**
 * Whether a slot's network rules keep a rig's harness off the cluster; control refuses a slot
 * where they don't. In a slot the cluster's operators write the rules, not
 * control; the settled rule is that the harness reaches only DNS, the internet and its model.
 * NetworkPolicies add up: traffic is allowed if any policy that selects the pod allows it, and a
 * pod no egress policy selects may go anywhere. So the harness is kept off the cluster when some
 * egress policy selects it, and every egress rule of every policy that selects it reaches only
 * DNS, or only addresses outside the closed ranges.
 */

/**
 * The ranges a cluster harness never reaches, in the rules control writes and in the rules it
 * accepts in a slot: the private ranges of RFC 1918, the shared range of RFC 6598 (carrier-grade
 * NAT, some clusters' pod and service ranges, Tailscale's addresses), link-local addresses (a
 * cloud's instance metadata) and "this network".
 */
export const CLOSED_RANGES = [
  "10.0.0.0/8", // public-check: allow (a reserved range, not an address of any network)
  "172.16.0.0/12", // public-check: allow (a reserved range, not an address of any network)
  "192.168.0.0/16", // public-check: allow (a reserved range, not an address of any network)
  "100.64.0.0/10", // public-check: allow (a reserved range, not an address of any network)
  "169.254.0.0/16", // public-check: allow (a reserved range, not an address of any network)
  "0.0.0.0/8",
];

type Selector = {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
};
type Peer = {
  ipBlock?: { cidr?: string; except?: string[] };
  podSelector?: unknown;
  namespaceSelector?: unknown;
};
type Policy = {
  metadata?: { name?: string };
  spec?: {
    podSelector?: Selector;
    policyTypes?: string[];
    egress?: { to?: Peer[]; ports?: { port?: number | string; protocol?: string }[] }[];
  };
};

/** Whether a label selector selects a pod with these labels. */
export function selects(sel: Selector | undefined, labels: Record<string, string>): boolean {
  if (!sel) return true;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = e.key in labels;
    const v = labels[e.key];
    const values = e.values ?? [];
    if (e.operator === "In" && !(has && values.includes(v as string))) return false;
    if (e.operator === "NotIn" && has && values.includes(v as string)) return false;
    if (e.operator === "Exists" && !has) return false;
    if (e.operator === "DoesNotExist" && has) return false;
  }
  return true;
}

const ip4 = (cidr: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!m) return undefined;
  const n =
    (((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4])) >>>
    0;
  const bits = Number(m[5]);
  const size = bits === 0 ? 2 ** 32 : 2 ** (32 - bits);
  return { start: n - (n % size), end: n - (n % size) + size - 1 };
};

/** Whether `cidr` minus `except` still reaches any address in the closed ranges. */
export function reachesClosed(cidr: string, except: string[] = []): boolean {
  const c = ip4(cidr);
  if (!c) return true; // IPv6 or unreadable: assume it may reach the cluster
  const holes = except.map(ip4).filter((x): x is NonNullable<typeof x> => x !== undefined);
  return CLOSED_RANGES.map(ip4).some((p) => {
    if (!p || p.end < c.start || p.start > c.end) return false;
    // Covered only if one exception holds the whole overlap.
    const lo = Math.max(p.start, c.start);
    const hi = Math.min(p.end, c.end);
    return !holes.some((h) => h.start <= lo && h.end >= hi);
  });
}

/** The slot's verdict, in words. */
export function harnessKeptOffCluster(
  policies: Policy[],
  harnessLabels: Record<string, string>,
): { ok: boolean; why: string } {
  const egress = policies.filter(
    (p) =>
      (p.spec?.policyTypes ?? (p.spec?.egress ? ["Egress"] : [])).includes("Egress") &&
      selects(p.spec?.podSelector, harnessLabels),
  );
  if (!egress.length)
    return { ok: false, why: "no network rule in the slot limits where the harness may connect" };
  for (const p of egress) {
    const name = p.metadata?.name ?? "?";
    for (const rule of p.spec?.egress ?? []) {
      const dnsOnly =
        (rule.ports ?? []).length > 0 && (rule.ports ?? []).every((x) => Number(x.port) === 53);
      if (dnsOnly) continue;
      const to = rule.to ?? [];
      if (!to.length)
        return {
          ok: false,
          why: `the rule "${name}" lets the harness connect anywhere, the cluster included`,
        };
      for (const peer of to) {
        if (peer.podSelector || peer.namespaceSelector)
          return {
            ok: false,
            why: `the rule "${name}" lets the harness connect to pods in the cluster`,
          };
        if (peer.ipBlock?.cidr && reachesClosed(peer.ipBlock.cidr, peer.ipBlock.except))
          return {
            ok: false,
            why: `the rule "${name}" lets the harness reach private, shared or link-local addresses (${peer.ipBlock.cidr})`,
          };
      }
    }
  }
  return {
    ok: true,
    why: "the slot's network rules keep the harness to DNS and addresses outside the cluster",
  };
}
