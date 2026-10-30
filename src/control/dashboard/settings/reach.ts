import type { Hono } from "hono";
import { canonicalAddress, REACH_MAX_PORTS, REACH_NOTE_MAX } from "../../../core/reach.ts";
import { setReachableAddresses } from "../../clusters/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { ago, esc } from "../../ui/components/index.ts";
import { portsWords } from "../../ui/rigs/reach.ts";
import type { Dashboard } from "../context.ts";

/**
 * Settings › Addresses cluster rigs may reach: the owner's list of addresses, each with its TCP
 * ports and a note, that cluster rigs' harnesses reach beside DNS and the internet
 * (clusters/reach.ts); a row for each, with Remove, and the form that adds one or changes one.
 */

/** Back to Settings, with what happened said in this block (at=reach). */
const reachUrl = (k: "ok" | "error", m: string) =>
  `/ui/settings?${k}=${encodeURIComponent(m)}&at=reach#reach`;

const ADDRESS_TIP =
  "One IPv4 or IPv6 address in the private, shared or link-local ranges, such as a model server on your own network or a Tailscale address. One host, never a range: the harness reaches no neighbour of it.";
const PORTS_TIP = `The TCP ports the harness reaches it on, such as 8000, separated by commas or spaces: at most ${REACH_MAX_PORTS}. Nothing else of it opens.`;
const NOTE_TIP = `What it is, for whoever reads the list and the rigs' pages later, such as "the model server". At most ${REACH_NOTE_MAX} characters.`;

/** The block, with what its last form did when the page came back to it. */
export function reachBlock(
  store: ControlStore,
  t: string,
  now: number,
  q: (k: string) => string | undefined,
): string {
  const list = store.reachable.list();
  const said = q("at") === "reach" ? (q("error") ?? q("ok")) : undefined;
  const note = said
    ? q("error")
      ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not done.</b> ${esc(said)}</div>`
      : `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(said)}</b></div>`
    : "";
  const rows = list
    .map(
      (e) =>
        `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><code>${esc(e.address)}</code><span class="small">on ${esc(portsWords(e.ports))}${e.note ? ` · ${esc(e.note)}` : ""}</span><span class="grow"></span><span class="muted xs">set by ${esc(e.set_by)} ${esc(ago(e.set_at, now))} ago</span><form class="inline" method="post" action="/ui/settings/reach/remove"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="address" value="${esc(e.address)}"><button class="sm ghost">Remove</button></form></div>`,
    )
    .join("");
  return `<div class="block" id="reach"><div class="head"><h2>Addresses cluster rigs may reach</h2><span class="n">${list.length}</span><span class="right">beside DNS and the internet, for rigs on Kubernetes clusters</span></div>${note}<div class="card">
<p class="small" style="margin-top:0">A cluster rig's harness reaches DNS and the internet, and no address in the private, shared or link-local ranges, where the cluster and your own network are. Each address here opens one host in those ranges to every cluster rig's harness, on its TCP ports only: a model server or a measurement target on your own network or on a Tailscale address. Code that a lane runs reaches it too, so list only what the rigs need. Control writes the list into the network rules of each rig in a namespace it created, at once. A joined rig has the list as it was when its join command ran. In a slot, the cluster's operators write the rules, and control accepts a rule that opens an address of this list on its ports, and nothing wider.</p>
${rows || `<div class="empty">No address: cluster rigs' harnesses reach DNS and the internet only.</div>`}
<form method="post" action="/ui/settings/reach" class="form-grid" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("Address", ADDRESS_TIP)}<input name="address" required maxlength="64" placeholder="fd7a:115c:a1e0::7" class="mono"></label>
<label>${infoLabel("TCP ports", PORTS_TIP)}<input name="ports" required maxlength="120" placeholder="8000"></label>
<label style="grid-column:1/-1">${infoLabel("What it is", NOTE_TIP)}<input name="note" maxlength="${REACH_NOTE_MAX}" placeholder="the model server"></label>
<div class="form-end"><span class="muted small">An address already in the list takes these ports and this note in place of its own.</span><button>Save the address</button></div></form></div></div>`;
}

/** The ports as the form gives them; why not, in words. */
function portsOf(text: string): number[] | string {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return "Give at least one TCP port, such as 8000.";
  const bad = parts.find((p) => !/^\d{1,5}$/.test(p));
  return bad
    ? `"${bad}" is not a TCP port: give numbers from 1 to 65535, such as 8000.`
    : parts.map(Number);
}

/** The block's two forms: save an address (new, or in place of the same one), and remove one. */
export function reachRoutes(app: Hono, dash: Dashboard): void {
  const { parts, store } = dash;
  const current = () =>
    store.reachable.list().map(({ address, ports, note }) => ({ address, ports, note }));
  const save = (list: unknown) => {
    const r = setReachableAddresses(parts, list, "owner:ui");
    return reachUrl("error" in r ? "error" : "ok", "error" in r ? r.error : r.ok);
  };

  app.post("/ui/settings/reach", async (c) => {
    const f = await c.req.parseBody();
    const address = String(f.address ?? "").trim();
    const ports = portsOf(String(f.ports ?? ""));
    if (typeof ports === "string") return c.redirect(reachUrl("error", ports), 303);
    const entry = { address, ports, note: String(f.note ?? "") };
    const same = canonicalAddress(address) ?? address;
    const others = current().filter((e) => e.address !== same);
    return c.redirect(save([...others, entry]), 303);
  });
  app.post("/ui/settings/reach/remove", async (c) => {
    const f = await c.req.parseBody();
    const address = String(f.address ?? "");
    const list = current();
    if (!list.some((e) => e.address === address))
      return c.redirect(reachUrl("error", `${address} is not in the list.`), 303);
    return c.redirect(save(list.filter((e) => e.address !== address)), 303);
  });
}
