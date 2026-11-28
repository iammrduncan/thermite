type P<X> = Promise<X>;
export type WallBoundary = "app" | "wasm" | "os" | "container" | "microvm";
type Cap1 = { boundary: WallBoundary; localShell: boolean };
export type WallCapabilities = Cap1 & { externalCli: boolean; networkProxy: boolean };
type Lim1 = { memoryMb: number; diskMb: number };
type Limits = Lim1 & { maxProcs?: number; timeoutMs?: number };
type Zs1 = { runId: string; laneId: string; workspaceDir: string; scratchDir: string };
type Zs2 = { readOnlyMounts?: string[]; proxySocketOrUrl?: string; limits: Limits };
export type ZoneSpec = Zs1 & Zs2;
type Killed = "timeout" | "memory" | "disk" | "cancelled";
type Res1 = { exitCode: number | null; signal: string | null; stdout: string };
export type ZoneExecResult = Res1 & { stderr: string; killedFor?: Killed };
type ReadOpts = { offset?: number; limit?: number };
type ExecOpts = { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal };
type Z1 = { readonly id: string; readonly workspaceDir: string };
type Z2 = {
  readFile(r: string, o?: ReadOpts): P<string>;
  writeFile(r: string, c: string): P<void>;
};
type Z3 = { editFile(r: string, a: string, b: string, all?: boolean): P<number> };
type Z4 = {
  listFiles(r?: string, d?: number): P<string[]>;
  searchFiles(p: string, r?: string): P<string[]>;
};
type Z5 = { exec?(argv: string[], opts?: ExecOpts): P<ZoneExecResult>; destroy(): P<void> };
export type Zone = Z1 & Z2 & Z3 & Z4 & Z5;
type Tgt1 = { secretFile: string; stateDir: string; siblingDir: string };
export type WallSelfTestTargets = Tgt1 & { blockedTcp: { host: string; port: number }[] };
type Rep1 = { ok: boolean; wallId: string; boundary: WallBoundary };
export type WallSelfTestReport = Rep1 & { probes: Record<string, string>; skipped: string[] };
type W1 = { readonly id: string; readonly version: string; capabilities: WallCapabilities };
type W2 = {
  probeAvailable(): P<{ ok: boolean; reason?: string }>;
  createZone(s: ZoneSpec): P<Zone>;
};
export type WallPlugin = W1 & W2 & { selfTest(t: WallSelfTestTargets): P<WallSelfTestReport> };
