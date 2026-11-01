import { SPACE_KINDS, SPACE_LOOK_MS, type SpaceUse } from "../../space.ts";
import { esc, infoLabel } from "../../ui/components/index.ts";
import { sizeWords } from "../../ui/exports.ts";

/**
 * Settings › Space: the space each kind of what control keeps takes (control/space.ts), each
 * label with what the kind is under its ⓘ. It only shows: control keeps every kind for good.
 */
export function spaceBlock(uses: SpaceUse[]): string {
  const known = uses.filter((u) => u.bytes !== null);
  const total = known.reduce((n, u) => n + (u.bytes ?? 0), 0);
  const rows = uses
    .map((u) => {
      const k = SPACE_KINDS[u.kind];
      const size =
        u.bytes === null
          ? `<span class="bad">not read: ${esc(u.error ?? "")}</span>`
          : esc(sizeWords(u.bytes));
      return `<tr data-space="${esc(u.kind)}"><td>${infoLabel(k.label, k.words)}</td><td class="num">${size}</td></tr>`;
    })
    .join("");
  return `<div class="block" id="space"><div class="head"><h2>Space</h2><span class="n">${esc(sizeWords(total))}</span><span class="right">what control keeps, by kind</span></div><div class="card">
<p class="small" style="margin-top:0">Control keeps each kind for good. These are the bytes each takes on control's disk, read at most once a minute (${SPACE_LOOK_MS / 1000} seconds).</p>
<table><thead><tr><th>Kind</th><th class="num">Space</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
