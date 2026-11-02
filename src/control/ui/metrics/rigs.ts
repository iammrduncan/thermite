import type { PartUse } from "../../../core/hardware.ts";
import type { RigFigures } from "../../system/index.ts";
import { esc, infoLabel } from "../components/index.ts";
import { since, size } from "./common.ts";
import { cpuWords } from "./control.ts";
import { TIP } from "./words.ts";

const partCells = (u: PartUse | null) =>
  u
    ? `<td class="num">${esc(cpuWords(u.cpu, u.cpus).value)}</td><td class="num">${esc(size(u.memory_bytes))}</td><td class="num">${esc(size(u.memory_limit_bytes))}</td>`
    : `<td colspan="3" class="muted small">not reported: its image is older than control</td>`;

/** Metrics' Rigs tab: each rig's harness and supervisor, as they last reported. */
export function rigsTab(rigs: RigFigures[], now: number): string {
  if (!rigs.length)
    return `<div class="card"><div class="empty">No rig has reported yet.</div></div>`;
  const rows = rigs
    .map((r) => {
      const free = r.disks.length ? Math.min(...r.disks.map((d) => d.free_gib)) : null;
      const low = free !== null && r.disk_floor_gib !== null && free < r.disk_floor_gib;
      const bus =
        r.bus.state === "on"
          ? `<span class="chip ok">on the bus</span>`
          : `<span class="chip bad">off the bus</span>`;
      const state =
        r.state === "reporting" ? "" : ` <span class="chip warn">${esc(r.state)}</span>`;
      const head = `<td rowspan="2"><a href="/ui/rigs/${encodeURIComponent(r.rig)}"><b>${esc(r.rig)}</b></a>${state}<div class="muted small">last report ${esc(since(r.last_seen, now))} ago</div></td>`;
      const tail = `<td rowspan="2" class="num${low ? " bad" : ""}">${free === null ? "—" : `${free} GiB`}</td><td rowspan="2" class="num">${r.cpus ?? "—"}</td><td rowspan="2">${bus}</td>`;
      return `<tr>${head}<td>harness</td>${partCells(r.harness)}${tail}</tr><tr><td>supervisor</td>${partCells(r.supervisor)}</tr>`;
    })
    .join("");
  return `<div class="card flat"><div class="utw"><table class="sys-rigs"><thead><tr><th>Rig</th><th>Part</th><th class="num">${infoLabel("CPU", TIP.rigCpu)}</th><th class="num">${infoLabel("Memory", TIP.rigMemory)}</th><th class="num">Limit</th><th class="num">Disk free</th><th class="num">CPUs</th><th>Bus</th></tr></thead><tbody>${rows}</tbody></table></div></div>
<p class="muted small">Each rig's harness puts its container's CPU and memory in each report, and its supervisor in its figures; the rows are as of each rig's last report. Disk free is the place with the least room, against the rig's floor.</p>`;
}
