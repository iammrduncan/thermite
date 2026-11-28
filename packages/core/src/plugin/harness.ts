type R<X> = Readonly<X>;
type P<X> = Promise<X>;
type Bytes = Uint8Array;
type StrRec = Record<string, string>;
type ObjRec = Record<string, unknown>;
type Auth1 = "api_key" | "gateway" | "chatgpt_plan" | "grok_plan";
type Auth2 = "claude_subscription" | "local_http" | "service_account";
export type AuthKind = Auth1 | Auth2;
type Comp = "host" | "rollover" | "native_only";
type Cap1 = { tools: "host_fn" | "mcp_or_cli"; steering: "live" | "next_turn" | "none" };
type Cap2 = { durableResume: boolean; interactiveTerminal: boolean; supportsResearch: boolean };
export type HarnessCapabilities = R<Cap1 & Cap2 & { compactionControl: Comp }>;
type ToolCtx = { signal: AbortSignal; callId: string };
type ToolBase = { name: string; description: string; inputSchema: ObjRec; idempotent: boolean };
type ToolFn = { writes?: boolean; execute(input: unknown, ctx: ToolCtx): P<unknown> };
export type HarnessTool = R<ToolBase> & ToolFn;
type ApiShape = "openai_chat" | "openai_responses" | "anthropic_messages" | "gateway" | "plan";
type Role = "worker" | "research" | "planner" | "advisor" | "check";
type Model = { id: string; effort?: string; contextWindow?: number; maxOutputTokens?: number };
type Prov1 = { id: string; authKind: AuthKind; apiShape: ApiShape };
type Prov = Prov1 & { baseUrl?: string; headers?: StrRec };
type Cred1 = { apiKey?: string; accessToken?: string; refreshToken?: string };
type Creds = Cred1 & { accountId?: string; expiresAt?: number };
type Cp = { through: string; data: Bytes };
type JRec = { expected: string | null; idempotencyKey: string; data: Bytes; barrier: boolean };
type Loaded = { checkpoint?: Cp; journal?: { cursor: string; data: Bytes }[] };
type Persist1 = { load(): P<Loaded>; append(rec: JRec): P<{ cursor: string }> };
type Persist = Persist1 & { saveCheckpoint(cp: Cp): P<void> };
type Bridge = { mcpUrl: string; cliEnv: StrRec };
type Spec1 = { sessionId: string; role: Role; model: Model; provider: Prov; instructions: string };
type Spec2 = { credentials: () => P<Creds>; onCredentials?: (next: ObjRec) => P<void> };
type Spec3 = { workspaceDir?: string; tools: readonly HarnessTool[]; toolBridge?: Bridge };
export type HarnessSessionSpec = R<Spec1 & Spec2 & Spec3 & { persistence?: Persist }>;
type Lim1 = { maxTurns?: number; maxTokens?: number };
export type TurnLimits = Lim1 & { wallMs?: number; stallMs?: number };
type Purp = "agent" | "compaction" | "auxiliary";
type Tel1 = { at: string; calls: number | null; tokensIn: number; cachedIn: number | null };
type Tel2 = { cacheWriteIn: number | null; tokensOut: number; reasoning: number | null };
type Tel3 = { firstTokenMs: number | null; callMs: number | null; purpose: Purp };
export type ModelCallTelemetry = R<Tel1 & Tel2 & Tel3>;
type Stop1 = "end_turn" | "cancelled" | "turns_limit" | "wall_limit";
type StopReason = Stop1 | "token_limit" | "context_full" | "error";
export type HarnessEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; callId: string; name: string; inputPreview?: string }
  | { type: "tool_end"; callId: string; name: string; isError: boolean; outputPreview?: string }
  | { type: "model_usage"; usage: ModelCallTelemetry }
  | { type: "compacted"; summary?: string; tokensBefore?: number; tokensAfter?: number }
  | { type: "provider_wait"; untilIso: string; reason: string }
  | { type: "turn_end"; stopReason: StopReason; error?: string };
type TurnOpts = { turnId?: string; resume?: boolean; limits?: TurnLimits; signal?: AbortSignal };
type Pty1 = { write(d: string | Bytes): void; resize(cols: number, rows: number): void };
type Pty = Pty1 & { onData(cb: (d: Bytes) => void): () => void };
type SteerRes = P<{ id: string; mode: "live" | "queued" }>;
type CompactRes = P<{ newSessionId?: string; summary: string }>;
type RunTurn = (input: string, opts?: TurnOpts) => AsyncIterable<HarnessEvent>;
type Sess1 = { readonly sessionId: string; runTurn: RunTurn };
type Sess2 = {
  steer(text: string, id?: string): SteerRes;
  cancel(r?: "abort" | "handoff"): P<void>;
};
type Sess3 = { compact?(o?: { instructions?: string }): CompactRes; attachTerminal?(): Pty };
export type HarnessSession = Sess1 & Sess2 & Sess3 & { close(): P<void> };
type Plug1 = { readonly id: string; readonly name: string; readonly version: string };
type Plug2 = { readonly capabilities: HarnessCapabilities; supportsAuth(k: AuthKind): boolean };
export type HarnessPlugin = Plug1 &
  Plug2 & { openSession(s: HarnessSessionSpec): P<HarnessSession> };
