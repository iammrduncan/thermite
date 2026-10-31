import { canonicalAddress, isIpv6, type ReachEntry } from "../../core/reach.ts";

/**
 * Whether a slot's network rules keep a rig's harness off the cluster; control refuses a slot
 * where they don't. In a slot the cluster's operators write the rules, not
 * control; the settled rule is that the harness reaches only DNS, the internet and its model.
 * NetworkPolicies add up: traffic is allowed if any policy that selects the pod allows it, and a
 * pod no egress policy selects may go anywhere. So the harness is kept off the cluster when some
 * egress policy selects it, and every egress rule of every policy that selects it reaches only
 * DNS, only addresses outside the closed ranges, or exactly an address of the owner's list of
 * addresses rigs may reach (core/reach.ts) on its listed TCP ports.
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
    egress?: { to?: Peer[]; ports?: Port[] }[];
    ingress?: { from?: Peer[]; ports?: Port[] }[];
  };
};
type Port = { port?: number | string; protocol?: string; endPort?: number };

/** An address of the owner's list that a slot's rule opens, on these ports, and the rule's name. */
export interface SlotOpening {
  address: string;
  ports: number[];
  rule: string;
}

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

/**
 * The one listed address an ipBlock names, as /32 (IPv4) or /128 (IPv6) and nothing else; and
 * the ports of a rule that opens it, when every one is a TCP port of its entry. Why not, in words.
 */
function listedOpening(
  cidr: string,
  ports: Port[] | undefined,
  reach: ReachEntry[],
): { ports: number[]; address: string } | { why: string } | undefined {
  const [host, bits] = cidr.split("/");
  const address = canonicalAddress(host ?? "");
  const entry = reach.find((e) => e.address === address);
  if (!address || !entry || bits !== (isIpv6(address) ? "128" : "32")) return undefined;
  const listed = entry.ports.join(", ");
  if (!ports?.length)
    return { why: `opens every port of ${address}, which the list gives only ${listed}` };
  const open: number[] = [];
  for (const p of ports) {
    const n = typeof p.port === "number" ? p.port : Number.NaN;
    if ((p.protocol ?? "TCP") !== "TCP" || p.endPort !== undefined || !entry.ports.includes(n))
      return { why: `opens ${address} on more than its listed TCP ports (${listed})` };
    open.push(n);
  }
  return { address, ports: [...new Set(open)].sort((a, b) => a - b) };
}

/**
 * The slot's verdict, in words, and each address of the owner's list (`reach`) its rules open
 * inside the closed ranges.
 */
export function harnessKeptOffCluster(
  policies: Policy[],
  harnessLabels: Record<string, string>,
  reach: ReachEntry[] = [],
): { ok: boolean; why: string; openings: SlotOpening[] } {
  const openings: SlotOpening[] = [];
  const refused = (why: string) => ({ ok: false, why, openings: [] });
  const egress = policies.filter(
    (p) =>
      (p.spec?.policyTypes ?? (p.spec?.egress ? ["Egress"] : [])).includes("Egress") &&
      selects(p.spec?.podSelector, harnessLabels),
  );
  if (!egress.length)
    return refused("no network rule in the slot limits where the harness may connect");
  for (const p of egress) {
    const name = p.metadata?.name ?? "?";
    for (const rule of p.spec?.egress ?? []) {
      const dnsOnly =
        (rule.ports ?? []).length > 0 && (rule.ports ?? []).every((x) => Number(x.port) === 53);
      if (dnsOnly) continue;
      const to = rule.to ?? [];
      if (!to.length)
        return refused(
          `the rule "${name}" lets the harness connect anywhere, the cluster included`,
        );
      for (const peer of to) {
        if (peer.podSelector || peer.namespaceSelector)
          return refused(`the rule "${name}" lets the harness connect to pods in the cluster`);
        const cidr = peer.ipBlock?.cidr;
        if (!cidr || !reachesClosed(cidr, peer.ipBlock?.except)) continue;
        const listed = listedOpening(cidr, rule.ports, reach);
        if (listed && "why" in listed) return refused(`the rule "${name}" ${listed.why}`);
        if (!listed)
          return refused(
            `the rule "${name}" lets the harness reach private, shared or link-local addresses (${cidr})`,
          );
        openings.push({ ...listed, rule: name });
      }
    }
  }
  const listed = openings.length
    ? ` and ${openings.length === 1 ? "an address" : `${openings.length} addresses`} of the list of addresses rigs may reach`
    : "";
  return {
    ok: true,
    why: `the slot's network rules keep the harness to DNS, addresses outside the cluster${listed}`,
    openings,
  };
}

/**
 * The egress rules that open the owner's list to a harness, in the rules control writes: one for
 * each address, to it alone (/32 or /128), on its TCP ports.
 */
export function reachEgress(reach: ReachEntry[]): Record<string, unknown>[] {
  return reach.map((e) => ({
    to: [{ ipBlock: { cidr: `${e.address}/${isIpv6(e.address) ? 128 : 32}` } }],
    ports: e.ports.map((port) => ({ port, protocol: "TCP" })),
  }));
}

/** Whether the harness reaches an address without the list: an IPv4 address outside the closed ranges. */
export const reachedAnyway = (address: string) =>
  !isIpv6(address) && !reachesClosed(`${address}/32`);

/**
 * Whether a slot's rules let only the rig's supervisor connect to its harness, in words. A slot's
 * rules are its operators', and the harness's API asks for a token on every route but its health,
 * so control takes the slot either way and the rig's page warns when other pods or addresses can
 * connect. Rules add up, as for egress: none that limits the harness's ingress lets every pod in.
 * A peer is the rig's supervisor when it selects pods by the supervisor's component label, in the
 * slot itself.
 */
export function harnessIngress(
  policies: Policy[],
  harnessLabels: Record<string, string>,
): { ok: boolean; why: string } {
  const ingress = policies.filter(
    (p) =>
      (p.spec?.policyTypes ?? ["Ingress"]).includes("Ingress") &&
      selects(p.spec?.podSelector, harnessLabels),
  );
  if (!ingress.length)
    return {
      ok: false,
      why: "no network rule in the slot limits who may connect to the harness, so every pod in the cluster can reach its port 8700",
    };
  for (const p of ingress) {
    const name = p.metadata?.name ?? "?";
    for (const rule of p.spec?.ingress ?? []) {
      const from = rule.from ?? [];
      if (!from.length)
        return {
          ok: false,
          why: `the rule "${name}" lets any pod or address connect to the harness`,
        };
      for (const peer of from) {
        const supervisor =
          !peer.namespaceSelector &&
          !peer.ipBlock &&
          (peer.podSelector as Selector | undefined)?.matchLabels?.[
            "app.kubernetes.io/component"
          ] === "supervisor";
        if (!supervisor)
          return {
            ok: false,
            why: peer.ipBlock
              ? `the rule "${name}" lets addresses in ${peer.ipBlock.cidr ?? "a range"} connect to the harness`
              : peer.namespaceSelector
                ? `the rule "${name}" lets pods of other namespaces connect to the harness`
                : `the rule "${name}" lets pods other than the rig's supervisor connect to the harness`,
          };
      }
    }
  }
  return { ok: true, why: "only the rig's supervisor may connect to the harness" };
}
