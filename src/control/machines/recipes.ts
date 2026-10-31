import { createHash } from "node:crypto";
import { shellQuote } from "../../common/exec.ts";
import type { MachineFacts } from "./facts.ts";

/**
 * The only things control installs on a machine, and only when the owner says yes to that
 * install on that machine: control asks first, and installs only what the owner allows. Each recipe is a fixed script in Thermite's source; the page
 * shows it exactly as it would run, and the owner's yes is bound to that exact script.
 */

export type RecipeId = "podman" | "nvidia_toolkit" | "linger";

/** NVIDIA's container toolkit version the recipe installs, pinned as NVIDIA's guide does. */
export const NVIDIA_TOOLKIT_VERSION = "1.20.1-1";

export interface Recipe {
  id: RecipeId;
  title: string;
  /** Why a rig needs it, in a sentence. */
  why: string;
}

export const RECIPES: Record<RecipeId, Recipe> = {
  podman: {
    id: "podman",
    title: "Podman",
    why: "Rigs run as two containers under Podman, as systemd services of the machine's user.",
  },
  nvidia_toolkit: {
    id: "nvidia_toolkit",
    title: "NVIDIA's container toolkit",
    why: "It lets the rig's containers reach the GPUs (through a CDI specification), so the judge can measure on them.",
  },
  linger: {
    id: "linger",
    title: "Lingering for the user's services",
    why: "Without it the user's systemd services, and so the rig, stop when the user has no session.",
  },
};

const family = (f: MachineFacts): "debian" | "fedora" | undefined => {
  const id = ` ${f.os_id} `;
  if (/ (debian|ubuntu) /.test(id)) return "debian";
  if (/ (fedora|rhel|centos|rocky|almalinux|amzn) /.test(id)) return "fedora";
  return undefined;
};

/**
 * The script a recipe runs on this machine, or why control can't run it here. Every command
 * that needs root goes through `sudo -n`, so it fails rather than waits for a password.
 */
export function recipeScript(
  id: RecipeId,
  f: MachineFacts,
): { script: string } | { error: string } {
  if (!f.sudo)
    return { error: "the user can't sudo without a password, so control can't install it" };
  const os = family(f);
  const s = (lines: string[]) => ({ script: ["set -eu", ...lines].join("\n") });
  if (id === "linger") return s([`sudo -n loginctl enable-linger ${shellQuote(f.user)}`]);
  if (!os) return { error: `control has no recipe for ${f.os}: install it yourself` };
  if (id === "podman")
    return os === "debian"
      ? s(["sudo -n apt-get update", "sudo -n apt-get install -y podman"])
      : s(["sudo -n dnf install -y podman"]);
  // NVIDIA's install guide (container toolkit), then a CDI specification for Podman.
  const v = NVIDIA_TOOLKIT_VERSION;
  const pkgs = [
    "nvidia-container-toolkit",
    "nvidia-container-toolkit-base",
    "libnvidia-container-tools",
    "libnvidia-container1",
  ];
  const cdi = "sudo -n nvidia-ctk cdi generate --output=/var/run/cdi/nvidia.yaml";
  return os === "debian"
    ? s([
        "sudo -n apt-get update",
        "sudo -n apt-get install -y --no-install-recommends ca-certificates curl gnupg2",
        "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo -n gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
        "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo -n tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null",
        "sudo -n apt-get update",
        `sudo -n apt-get install -y ${pkgs.map((p) => `${p}=${v}`).join(" ")}`,
        cdi,
      ])
    : s([
        "sudo -n dnf install -y curl",
        "curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo -n tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null",
        `sudo -n dnf install -y ${pkgs.map((p) => `${p}-${v}`).join(" ")}`,
        cdi,
      ]);
}

/** What the owner's yes is bound to: the recipe's exact script. */
export const scriptSha = (script: string) => createHash("sha256").update(script).digest("hex");
