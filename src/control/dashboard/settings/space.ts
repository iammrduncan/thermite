import { type RetentionPolicy, STORE_COPIES_DEFAULT_WORDS } from "../../../core/retention/index.ts";
import { SPACE_LOOK_MS, type SpaceUse, spaceKindOf, spaceTotal } from "../../space.ts";
import { esc, infoLabel } from "../../ui/components/index.ts";
import { sizeWords } from "../../ui/exports.ts";

/**
 * Settings › Space: the space each kind of what Thermite keeps takes (control/space.ts), each label
 * with what the kind is under its ⓘ, where it is kept, and what removes it: the retention policies
 * of its kind, each on or off, the Exports page for exports, or nothing (kept for good).
 */
export function spaceBlock(uses: SpaceUse[], policies: readonly RetentionPolicy[] = []): string {
  const total = spaceTotal(uses);
  const rows = uses
    .map((u) => {
      const k = spaceKindOf(u.kind);
      const size =
        u.bytes === null
          ? `<span class="bad">not read: ${esc(u.error ?? "")}</span>`
          : `${esc(sizeWords(u.bytes))}${u.rigs !== undefined ? `<div class="muted xs">${u.rigs} rig${u.rigs === 1 ? "" : "s"} said</div>` : ""}`;
      const mine = k.policy ? policies.filter((p) => p.kind === k.policy) : [];
      const chips = mine
        .map(
          (p) =>
            `<span class="pill${p.on ? " ok" : ""}">${esc(p.name)}${p.on ? "" : " (off)"}</span>`,
        )
        .join(" ");
      // Control keeps the two newest copies of its store itself while no policy of them is on.
      const byDefault =
        k.policy === "store_copies" && !mine.some((p) => p.on)
          ? `<span class="muted">${esc(STORE_COPIES_DEFAULT_WORDS)}</span>`
          : "";
      const by = k.byHand
        ? `<span class="muted">By hand, on <a href="/ui/exports">Exports</a></span>`
        : byDefault || chips
          ? [byDefault, chips].filter(Boolean).join(" ")
          : `<span class="muted">Kept for good</span>`;
      return `<tr data-space="${esc(u.kind)}"><td>${infoLabel(k.label, k.words)}</td><td>${esc(k.on)}</td><td class="num">${size}</td><td>${by}</td></tr>`;
    })
    .join("");
  return `<div class="block" id="space"><div class="head"><h2>Space</h2><span class="n">${esc(sizeWords(total))}</span><span class="right">what Thermite keeps, by kind, and the policy that removes any of it</span></div><div class="card">
<p class="small" style="margin-top:0">Thermite keeps each kind for good unless a retention policy below removes it. Control's kinds are read on its disk at most once a minute (${SPACE_LOOK_MS / 1000} seconds); a rig's kinds are what each rig last said it keeps.</p>
<table><thead><tr><th>Kind</th><th>Kept on</th><th class="num">Space</th><th>Removed by</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
