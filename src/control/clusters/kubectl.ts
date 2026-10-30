import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Control's way into a Kubernetes cluster it sets rigs up on: the kubectl in control's image,
 * with the cluster's kubeconfig in a 0600 file that exists only for the call. Control runs only
 * fixed read commands and applies only manifests it renders itself (manifests.ts), on stdin.
 */

export interface ClusterTarget {
  kubeconfig: string;
  /** The kubeconfig context to use; empty: its current context. */
  context?: string | undefined;
}

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A context or namespace name: what kubectl takes as a single argument. */
export const KUBE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,252}$/;

/** Runs kubectl with these arguments (never a shell), stdin if given. */
export async function kubectl(
  t: ClusterTarget,
  args: string[],
  stdin?: string,
  timeoutMs = 60_000,
): Promise<KubectlResult> {
  if (t.context && !KUBE_NAME.test(t.context)) throw new Error("the context name is not valid");
  const dir = mkdtempSync(join(tmpdir(), "thermite-kube-"));
  chmodSync(dir, 0o700);
  try {
    const config = join(dir, "config");
    writeFileSync(config, t.kubeconfig, { mode: 0o600 });
    const argv = [
      `--kubeconfig=${config}`,
      ...(t.context ? [`--context=${t.context}`] : []),
      "--request-timeout=30s",
      ...args,
    ];
    return await new Promise<KubectlResult>((resolve, reject) => {
      const child = spawn("kubectl", argv, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGKILL")
          return reject(new Error(`kubectl did not finish within ${timeoutMs / 1000} s`));
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
        });
      });
      child.stdin.end(stdin ?? "");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** kubectl's own failure, in a line. */
export const kubeError = (r: KubectlResult) =>
  (r.stderr.trim().split("\n").pop() ?? `kubectl exited ${r.code}`).replace(/^error: /i, "");

/** The contexts a kubeconfig holds, and its current one (read locally, nothing contacted). */
export async function contextsOf(
  kubeconfig: string,
): Promise<{ contexts: string[]; current: string }> {
  const names = await kubectl({ kubeconfig }, ["config", "get-contexts", "-o", "name"]);
  if (names.code !== 0)
    throw new Error(`that is not a kubeconfig kubectl can read: ${kubeError(names)}`);
  const current = await kubectl({ kubeconfig }, ["config", "current-context"]);
  return {
    contexts: names.stdout
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
    current: current.code === 0 ? current.stdout.trim() : "",
  };
}

/**
 * What a pasted kubeconfig would make kubectl do inside control, read without contacting the
 * cluster (kubectl config view runs no plugin). Refused: exec and auth-provider plugins (they
 * run commands in control's container) and file references (they read control's own files,
 * its secrets among them); everything must be inline data. Unchecked: skipped TLS checks and
 * plain http, where control can't tell the real API server from another; control takes those only
 * when the owner accepts it.
 */
export async function inspectKubeconfig(
  k: ClusterKubectl,
  kubeconfig: string,
): Promise<{ problems: string[]; unchecked: string[] }> {
  const r = await k.kubectl({ kubeconfig }, ["config", "view", "--raw", "-o", "json"]);
  let cfg: {
    clusters?: { name?: string; cluster?: Record<string, unknown> }[];
    users?: { name?: string; user?: Record<string, unknown> }[];
  };
  try {
    cfg = JSON.parse(r.stdout) as typeof cfg;
  } catch {
    return { problems: [`kubectl could not read it: ${kubeError(r)}`], unchecked: [] };
  }
  const problems: string[] = [];
  const unchecked: string[] = [];
  for (const u of cfg.users ?? []) {
    const user = u.user ?? {};
    const who = `user "${u.name ?? "?"}"`;
    if (user.exec)
      problems.push(
        `${who} runs a command (exec) to log in: control runs no commands from a kubeconfig; use a token or a client certificate, inline`,
      );
    if (user["auth-provider"])
      problems.push(
        `${who} uses an auth-provider plugin: use a token or a client certificate, inline`,
      );
    for (const f of ["tokenFile", "client-certificate", "client-key"])
      if (user[f])
        problems.push(
          `${who} reads a file (${f}): put the data inline (token, client-certificate-data, client-key-data)`,
        );
  }
  for (const c of cfg.clusters ?? []) {
    const cluster = c.cluster ?? {};
    const which = `cluster "${c.name ?? "?"}"`;
    if (cluster["certificate-authority"])
      problems.push(
        `${which} reads a file (certificate-authority): use certificate-authority-data`,
      );
    if (cluster["proxy-url"])
      problems.push(
        `${which} goes through a proxy (proxy-url): control talks to the API server directly`,
      );
    if (cluster["insecure-skip-tls-verify"])
      unchecked.push(`${which} skips TLS checks (insecure-skip-tls-verify)`);
    if (typeof cluster.server === "string" && cluster.server.startsWith("http:"))
      unchecked.push(`${which} reaches its API server over plain http`);
  }
  return { problems, unchecked };
}

/** The kubectl operations control uses (tests give their own). */
export interface ClusterKubectl {
  kubectl: typeof kubectl;
  contextsOf: typeof contextsOf;
}

export const realKubectl: ClusterKubectl = { kubectl, contextsOf };
