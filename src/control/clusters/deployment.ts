/** One variable of a container's environment, as a deployment's spec gives it. */
export interface EnvVar {
  name: string;
  value?: string;
}

/**
 * The first container's environment in a deployment that `kubectl get deployment … -o json`
 * printed; null when the answer is not a deployment, so the caller can say it could not read it
 * instead of taking an empty environment for a real one.
 */
export function deploymentEnv(stdout: string): EnvVar[] | null {
  let d: unknown;
  try {
    d = JSON.parse(stdout);
  } catch {
    return null;
  }
  const spec = (d as { spec?: { template?: { spec?: { containers?: unknown } } } } | null)?.spec;
  const containers = spec?.template?.spec?.containers;
  if (!Array.isArray(containers)) return null;
  const env = (containers[0] as { env?: unknown } | undefined)?.env ?? [];
  return Array.isArray(env) ? (env as EnvVar[]) : null;
}
