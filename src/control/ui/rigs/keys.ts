import { sealKeyFingerprint } from "../../../core/link/config.ts";
import { userKeyFingerprint } from "../../../core/link/users.ts";
import { BUS_KEY_CHANGE_STEPS } from "../../bus/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { ago, esc } from "../components/index.ts";

/**
 * A rig's keys on the message bus on its page: the fingerprints of the user key and the seal key
 * its supervisor registered, and when one last changed or was refused (HTML).
 */
export function busKeysHtml(store: ControlStore, rig: string, now: number): string {
  const key = store.busKeys.rigKey(rig);
  if (!key) return `<span class="muted">none registered yet</span>`;
  const seal = store.busKeys.rigSealKey(rig);
  const last = store.rigHistory.latest(rig, BUS_KEY_CHANGE_STEPS, 1)[0];
  const change = last
    ? ` · <span class="${last.ok ? "warn" : "bad"}">${last.ok ? "changed" : "a new one refused"} ${esc(ago(last.at, now))} ago</span>`
    : "";
  return `<code>${esc(userKeyFingerprint(key))}</code> its user${seal ? ` · <code>${esc(sealKeyFingerprint(seal))}</code> its seal key` : ""}${change}`;
}
