import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newToken } from "../common/secrets.ts";
import type { ENROLL, ListedBuild, RigList } from "../core/api/control/owner.ts";
import type { AnswerOf } from "../core/api/route.ts";

/** What control answers when it enrolls a rig (core/api/control/owner.ts). */
export type Enrolled = AnswerOf<typeof ENROLL>;

/**
 * The files a new rig starts from, written for the rig's host: its control token, a fresh token
 * its harness and supervisor share, control's public key with its fingerprint, the rig's name and
 * control's address, and the message bus's address with the certificate of control's authority
 * for it: a rig reaches control only on the bus. No token is printed; each is only in its file,
 * mode 0600. A control with no address for rigs on its bus gets no files, in words.
 */
export function writeRigFiles(dir: string, enrolled: Enrolled, controlUrl: string): string[] {
  if (existsSync(dir) && readdirSync(dir).length)
    throw new Error(`${dir} is not empty; a rig's files are never overwritten`);
  const bus = enrolled.bus;
  if (!bus)
    throw new Error(
      `control enrolled ${enrolled.rig} but has no address for rigs on its message bus (THERMITE_NATS_PUBLIC_URL, or THERMITE_CONTROL_PUBLIC_URL), and a rig works only on the bus. Set it on control, retire this rig (thermite rig retire ${enrolled.rig}) and add it again`,
    );
  mkdirSync(join(dir, "secrets"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "keys"), { recursive: true });
  const env = [
    `THERMITE_RIG_ID=${enrolled.rig}`,
    `CONTROL_URL=${controlUrl.replace(/\/$/, "")}`,
    `THERMITE_NATS_URL=${bus.url}`,
  ];
  const readme = [
    `Rig ${enrolled.rig}, enrolled at ${controlUrl}.`,
    "",
    "secrets/control-rig-token         the supervisor's token for control (THERMITE_CONTROL_TOKEN_FILE)",
    "secrets/harness-supervisor-token  shared by the harness (THERMITE_SUPERVISOR_TOKEN_FILE) and the",
    "                                  supervisor (THERMITE_HARNESS_TOKEN_FILE)",
    "keys/control-signing.pub          control's public key (the harness's THERMITE_CONTROL_PUBKEY_FILE)",
    "keys/control-signing.fingerprint  compare it with the fingerprint on control's dashboard",
    "keys/bus-ca.pem                   the certificate of control's authority for the message bus",
    "                                  (the supervisor's THERMITE_NATS_CA_FILE)",
    "rig.env                           the rig's name, control's address and the message bus's",
    "",
    "Keep secrets/ private. A lost or leaked token is replaced with `thermite rig token`.",
    "",
  ];
  const files: [string, string, number][] = [
    ["secrets/control-rig-token", `${enrolled.token}\n`, 0o600],
    ["secrets/harness-supervisor-token", `${newToken().token}\n`, 0o600],
    ["keys/control-signing.pub", enrolled.control_public_key, 0o644],
    ["keys/control-signing.fingerprint", `${enrolled.control_fingerprint}\n`, 0o644],
    ["keys/bus-ca.pem", bus.ca, 0o644],
    ["rig.env", `${env.join("\n")}\n`, 0o644],
    ["README.txt", readme.join("\n"), 0o644],
  ];
  for (const [name, text, mode] of files)
    writeFileSync(join(dir, name), text, { mode, flag: "wx" });
  return files.map(([name]) => name);
}

/** What control answers for its rig list (its home: core/api/control/owner.ts). */
export type { RigList };

const short = (b: ListedBuild | null | undefined) =>
  b?.version ? `${b.version}${b.commit ? ` (${b.commit.slice(0, 12)})` : ""}` : "no version";

/**
 * The rig list as `thermite rig list` prints it: control's build, then each rig with whether it
 * reports, its last report, its version against control's and each part's build, and under it
 * what the owner should know. Enrolled rigs that never reported come last.
 */
export function formatRigList(list: RigList): string {
  const c = list.control;
  const works =
    c && typeof c.oldest_protocol === "number" && c.oldest_protocol !== c.protocol
      ? ` (works with ${c.oldest_protocol} to ${c.protocol})`
      : "";
  const lines = [
    c
      ? `control ${short(c)}, protocol ${c.protocol}${works}`
      : "control: no version (control is older than version checks)",
  ];
  const rows = [["RIG", "STATE", "LAST REPORT", "VERSION", "HARNESS", "SUPERVISOR"]];
  const notes = new Map<number, string>();
  for (const u of list.rigs) {
    if (u.version?.notice) notes.set(rows.length, u.version.notice);
    rows.push([
      u.id,
      u.state ?? "unknown",
      Date.parse(u.last_seen) > 0 ? u.last_seen : "never",
      u.version?.state ?? "unknown",
      short(u.version?.harness),
      short(u.version?.supervisor),
    ]);
  }
  const width = (i: number) => Math.max(...rows.map((r) => (r[i] ?? "").length));
  rows.forEach((r, n) => {
    lines.push(
      r
        .map((cell, i) => cell.padEnd(width(i)))
        .join("  ")
        .trimEnd(),
    );
    const note = notes.get(n);
    if (note) lines.push(`  ${note}`);
  });
  const listed = new Set(list.rigs.map((u) => u.id));
  for (const e of list.enrolled ?? [])
    if (!e.retired_at && !listed.has(e.rig)) lines.push(`${e.rig}: enrolled, no report yet`);
  return `${lines.join("\n")}\n`;
}
