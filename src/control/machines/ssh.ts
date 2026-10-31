import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { shellQuote } from "../../common/exec.ts";

/**
 * Control's way into a machine it sets rigs up on: the OpenSSH client in control's image, with
 * the machine's private key in a 0600 file that exists only for the call, and the machine's
 * host keys pinned when the owner trusted them. Every command is one of Thermite's own scripts,
 * sent on stdin to `sh -s` with its arguments quoted; secrets travel inside the script (stdin),
 * never on a command line. Nothing the owner types is run as a command.
 */

const run = promisify(execFile);

export interface SshTarget {
  address: string;
  port: number;
  user: string;
  privateKey: string;
  /** known_hosts lines the owner trusted. Without them nothing connects. */
  hostKeys: string[];
}

/** A host name or an IP address; never one that ssh would read as an option. */
export const ADDRESS =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/;
/** A Unix account name. */
export const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/** `SHA256:…` as ssh prints it, from a known_hosts or public key line's base64 key. */
export function fingerprint(keyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export interface HostKey {
  /** The known_hosts line, as ssh-keyscan printed it. */
  line: string;
  /** ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa. */
  type: string;
  fingerprint: string;
}

/** Parses ssh-keyscan's output: one key per line, comments skipped. */
export function parseHostKeys(text: string): HostKey[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const [, type, key] = line.split(/\s+/);
      return type && key && /^[A-Za-z0-9+/=]+$/.test(key)
        ? { line, type, fingerprint: fingerprint(key) }
        : undefined;
    })
    .filter((k): k is HostKey => k !== undefined)
    .sort((a, b) => rank(a.type) - rank(b.type));
}
const rank = (t: string) => (t === "ssh-ed25519" ? 0 : t.startsWith("ecdsa") ? 1 : 2);

/** The machine's host keys as it presents them now: what the owner is asked to trust. */
export async function scanHostKeys(address: string, port: number): Promise<HostKey[]> {
  if (!ADDRESS.test(address)) throw new Error("the address is not a host name or an IP address");
  const { stdout } = await run(
    "ssh-keyscan",
    ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", address],
    { timeout: 20_000 },
  ).catch(() => ({ stdout: "" }));
  const keys = parseHostKeys(stdout);
  if (!keys.length) throw new Error(`no SSH server answered at ${address} port ${port}`);
  return keys;
}

/** The public half of a private key, and its fingerprint: also checks that ssh can use it. */
export async function publicKeyOf(
  privateKey: string,
): Promise<{ line: string; fingerprint: string }> {
  return withKeyDir(privateKey, [], async (dir) => {
    const { stdout } = await run("ssh-keygen", ["-y", "-P", "", "-f", join(dir, "key")], {
      timeout: 10_000,
    }).catch(() => {
      throw new Error(
        "that is not an SSH private key control can use (a key with a passphrase can't be used)",
      );
    });
    const line = stdout.trim();
    return { line, fingerprint: fingerprint(line.split(/\s+/)[1] ?? "") };
  });
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one of Thermite's scripts on the machine: `sh -s -- args…`, the script on stdin. */
export async function sshScript(
  t: SshTarget,
  script: string,
  args: string[] = [],
  timeoutMs = 120_000,
): Promise<SshResult> {
  if (!ADDRESS.test(t.address)) throw new Error("the address is not a host name or an IP address");
  if (!USER.test(t.user)) throw new Error("the user is not a Unix account name");
  if (!t.hostKeys.length) throw new Error("the machine's host key is not trusted yet");
  return withKeyDir(t.privateKey, t.hostKeys, async (dir) => {
    const argv = [
      "-i",
      join(dir, "key"),
      "-p",
      String(t.port),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${join(dir, "known_hosts")}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "LogLevel=ERROR",
      "-l",
      t.user,
      "--",
      t.address,
      ["sh", "-s", "--", ...args].map(shellQuote).join(" "),
    ];
    return new Promise<SshResult>((resolve, reject) => {
      const child = spawn("ssh", argv, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const cap = (b: Buffer, into: Buffer[]) => {
        size += b.length;
        if (size <= 8 * 1024 * 1024) into.push(b);
      };
      child.stdout.on("data", (b: Buffer) => cap(b, out));
      child.stderr.on("data", (b: Buffer) => cap(b, err));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const stderr = Buffer.concat(err).toString();
        if (signal === "SIGKILL")
          return reject(new Error(`the machine did not finish within ${timeoutMs / 1000} s`));
        // 255 is ssh's own failure: no connection, a refused key, a changed host key.
        if (code === 255) return reject(new Error(sshError(stderr)));
        resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr });
      });
      child.stdin.end(script);
    });
  });
}

/** ssh's own failure, in words. */
export function sshError(stderr: string): string {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr))
    return "the machine presented a different host key from the one you trusted: control refused it";
  if (/Permission denied/i.test(stderr)) return "the machine refused the key for that user";
  if (/Connection refused/i.test(stderr))
    return "nothing accepts SSH connections at that address and port";
  if (/timed out|No route to host|Could not resolve/i.test(stderr))
    return `control could not reach the machine (${stderr.trim().split("\n").pop()})`;
  return `ssh failed: ${stderr.trim().split("\n").pop() ?? "no reason given"}`;
}

/** The last three lines of a script's output, as one line: why a step on a machine failed. */
export const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 400);

/** A fresh 0700 directory with the key (0600) and the pinned host keys, removed afterwards. */
async function withKeyDir<T>(
  privateKey: string,
  hostKeys: string[],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "thermite-ssh-"));
  chmodSync(dir, 0o700);
  try {
    writeFileSync(join(dir, "key"), privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(dir, "known_hosts"), hostKeys.map((l) => `${l}\n`).join(""), {
      mode: 0o600,
    });
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The SSH operations control uses on machines (tests give their own). */
export interface MachineSsh {
  scanHostKeys: typeof scanHostKeys;
  publicKeyOf: typeof publicKeyOf;
  sshScript: typeof sshScript;
}

export const openSsh: MachineSsh = { scanHostKeys, publicKeyOf, sshScript };
