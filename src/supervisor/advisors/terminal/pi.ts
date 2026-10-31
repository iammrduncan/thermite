import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { TrialConsole } from "../../../agents/cli/index.ts";
import { modelEnv } from "../../../agents/model/index.ts";
import { PiConsole, runInView } from "../../../agents/pi-view/index.ts";
import { errorText } from "../../../common/errors.ts";
import { log } from "../../../common/log.ts";
import { sameSecret } from "../../../common/secrets.ts";
import { PI_VIEW_DONE, PI_VIEW_END, PI_VIEW_NEXT } from "../../../core/api/harness/console.ts";
import type { Route } from "../../../core/api/route.ts";
import {
  ADVISOR_CALL_ANSWER,
  ADVISOR_CALL_COMPACTED,
  ADVISOR_CALL_END,
  ADVISOR_CALL_KEEP,
  ADVISOR_CALL_LIVE,
  ADVISOR_CALL_MCP,
  ADVISOR_CALL_MCP_TOOLS,
  ADVISOR_CALL_MESSAGES,
  ADVISOR_CALL_READ,
  ADVISOR_CALL_TOOL,
  ADVISOR_CALL_TURN,
  ADVISOR_CALL_USAGE,
} from "../../../core/api/supervisor/advisor-call.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { AdvisorCall, AdvisorCompaction, AdvisorResult } from "../call.ts";
import { advisorRoute } from "../config.ts";
import {
  advisorPiTools,
  callStamp,
  checkAnswer,
  PI_ADVISOR_MAIN,
  PI_ADVISOR_SPEC_FILE,
  type PiAdvisorSpec,
  type PiRuntime,
  piKey,
  piModel,
} from "../pi/index.ts";
import { serveAdvisorModel } from "../proxy.ts";
import { type AdvisorInTerminal, CallInbox, MESSAGES_EVERY_MS, nextCallId } from "./call.ts";

/**
 * An advisor in Pi in its Pi view (goal 169; the owner's decision of 2026-10-31: every program the
 * same way), on a rig whose agents run in their own terminal: its call runs in a process of its own
 * (../pi/main.ts), which the terminal host runs through the advisors' runner as an advisor user, in
 * a folder of its own among the runs' root's children, as the other programs' terminals run. The
 * process reaches the supervisor only over the call's routes (core/api/supervisor/advisor-call.ts),
 * on localhost for the length of the call, with a credential made for it, and its model only
 * through the call's proxy, which adds the key. Its tools are the headless advisor's, run here; its
 * answer is checked here as a headless advisor's is. The owner's messages for its role go in before
 * its next model call; the owner's input, which the harness checked and recorded, reaches its
 * view's console (consoles.ts, relay.ts); Live shows its view.
 */

/** The most usage records one call keeps: past it, the newest are left out, and the log says so. */
const USAGE_MAX = 100_000;
/** The time a process is given past its call's own limit to hand over its end. */
const END_GRACE_MS = 120_000;

/** What a call's routes answer with, while its process runs. */
interface CallSide {
  auth: string;
  route(r: Route, c: Context): Promise<unknown>;
}

/** Starts the call's routes on a free local port. Close them when the call ends. */
async function serveCall(side: CallSide) {
  const app = new Hono();
  const allowed = (header: string | undefined) => sameSecret(header ?? "", `Bearer ${side.auth}`);
  const routes: Route[] = [
    PI_VIEW_NEXT,
    PI_VIEW_DONE,
    PI_VIEW_END,
    ADVISOR_CALL_TOOL,
    ADVISOR_CALL_MCP,
    ADVISOR_CALL_MCP_TOOLS,
    ADVISOR_CALL_ANSWER,
    ADVISOR_CALL_LIVE,
    ADVISOR_CALL_MESSAGES,
    ADVISOR_CALL_READ,
    ADVISOR_CALL_USAGE,
    ADVISOR_CALL_KEEP,
    ADVISOR_CALL_COMPACTED,
    ADVISOR_CALL_TURN,
    ADVISOR_CALL_END,
  ];
  for (const r of routes) {
    const handle = async (c: Context) => {
      if (!allowed(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      try {
        return c.json((await side.route(r, c)) as object);
      } catch (err) {
        return c.json({ error: errorText(err).slice(0, 2000) }, 400);
      }
    };
    if (r.method === "GET") app.get(r.path, handle);
    else app.post(r.path, bodyLimit({ maxSize: r.maxBytes ?? 64 * 1024 }), handle);
  }
  app.all("*", (c) => c.json({ error: "not found" }, 404));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** A route's body, as its schema reads it. */
async function bodyOf<R extends Route>(r: R, c: Context): Promise<z.infer<NonNullable<R["body"]>>> {
  return (r.body as z.ZodType).parse(await c.req.json()) as z.infer<NonNullable<R["body"]>>;
}

/** One advisor call in Pi in its Pi view; it answers as runAdvisor's other runtimes do. */
export async function runInPiView<S extends z.ZodType>(
  rt: PiRuntime,
  input: AdvisorCall<S>,
  at: AdvisorInTerminal,
): Promise<AdvisorResult<z.infer<S>>> {
  const fail = (error: string) => ({ output: undefined, error, tokensIn: 0, tokensOut: 0, usd: 0 });
  const key = piKey(rt);
  if (!key) return fail(`advisor ${rt.name} has no key`);
  const t = at.terminals;
  const id = nextCallId(rt.name, at.run);
  const fields = { advisor: rt.name, run: at.run, call: id };
  const tools = input.tools ?? {};
  const own = advisorPiTools(tools);
  const sent = input.prompt({
    program: "pi",
    mcpServers: [...new Set((tools.mcp?.tools ?? []).map((x) => x.server))],
    kbWrites: tools.kb?.writes,
  });
  const inbox = new CallInbox({
    read: () => t.waiting(at.run, at.role),
    given: at.given,
    everyMs: t.pollMs ?? MESSAGES_EVERY_MS,
    fields,
  });
  const usage: CallUsage[] = [];
  const compactions: AdvisorCompaction[] = [];
  const kept = callStamp();
  let output: z.infer<S> | undefined;
  let answered = false;
  let ended: { tokens_in: number; tokens_out: number; error?: string | undefined } | undefined;
  const auth = `call.${randomBytes(24).toString("hex")}`;
  const view = new PiConsole();
  const line = (kind: "text" | "thinking" | "tool" | "result" | "status", text: string) =>
    t.live({ kind, text: `${rt.name}: ${text}`, run: at.run });
  /** What each route does for the call. */
  const route = async (r: Route, c: Context): Promise<unknown> => {
    switch (r.path) {
      case PI_VIEW_NEXT.path:
        return { input: await view.next((await bodyOf(PI_VIEW_NEXT, c)).wait_ms) };
      case PI_VIEW_DONE.path: {
        const b = await bodyOf(PI_VIEW_DONE, c);
        if (!view.done(b.id, b.outcome, b.why)) throw new Error(`no input ${b.id} waits`);
        return { ok: true };
      }
      case PI_VIEW_END.path:
        await view.end();
        return { ok: true };
      case ADVISOR_CALL_TOOL.path: {
        const b = await bodyOf(ADVISOR_CALL_TOOL, c);
        const tool = own.tools.find((x) => x.name === b.tool);
        if (!tool) throw new Error(`this advisor has no tool ${b.tool.slice(0, 64)}`);
        const args = validateToolArguments(tool, {
          type: "toolCall",
          id: "view",
          name: tool.name,
          arguments: b.args as Parameters<typeof validateToolArguments>[1]["arguments"],
        });
        const r = await tool.execute("view", args);
        const text = r.content.map((x) => (x.type === "text" ? x.text : "")).join("");
        return { text };
      }
      case ADVISOR_CALL_MCP.path: {
        const b = await bodyOf(ADVISOR_CALL_MCP, c);
        if (!tools.mcp) throw new Error("this advisor has no MCP server");
        return await tools.mcp.call(b.server, b.tool, b.arguments);
      }
      case ADVISOR_CALL_MCP_TOOLS.path: {
        const b = await bodyOf(ADVISOR_CALL_MCP_TOOLS, c);
        if (!tools.mcp) throw new Error("this advisor has no MCP server");
        return tools.mcp.relist
          ? await tools.mcp.relist(b.fresh)
          : { tools: tools.mcp.tools, unavailable: [] };
      }
      case ADVISOR_CALL_ANSWER.path: {
        const b = await bodyOf(ADVISOR_CALL_ANSWER, c);
        if (answered) return { ok: true };
        const checked = await checkAnswer(input.schema, input.accept, b.answer);
        if (!checked.ok) return { ok: false, problems: checked.problems, words: checked.words };
        output = checked.output as z.infer<S>;
        answered = true;
        return { ok: true };
      }
      case ADVISOR_CALL_LIVE.path:
        for (const e of (await bodyOf(ADVISOR_CALL_LIVE, c)).entries) line(e.kind, e.text);
        return { ok: true };
      case ADVISOR_CALL_MESSAGES.path:
        return { messages: answered ? [] : inbox.waiting() };
      case ADVISOR_CALL_READ.path: {
        const offered = new Set(inbox.waiting().map((m) => m.id));
        inbox.given((await bodyOf(ADVISOR_CALL_READ, c)).ids.filter((x) => offered.has(x)));
        return { ok: true };
      }
      case ADVISOR_CALL_USAGE.path: {
        const calls = (await bodyOf(ADVISOR_CALL_USAGE, c)).calls;
        const room = Math.max(0, USAGE_MAX - usage.length);
        usage.push(...calls.slice(0, room));
        if (calls.length > room)
          log(
            "supervisor",
            "an advisor's model usage past the most one call keeps",
            fields,
            "warn",
          );
        return { recorded: Math.min(room, calls.length) };
      }
      case ADVISOR_CALL_KEEP.path: {
        const b = await bodyOf(ADVISOR_CALL_KEEP, c);
        if (!input.keeper) throw new Error("this advisor's call has no place to keep it");
        return { kept: input.keeper.keep(rt.name, kept, b.number, b.markdown) };
      }
      case ADVISOR_CALL_COMPACTED.path: {
        const b = await bodyOf(ADVISOR_CALL_COMPACTED, c);
        const done: AdvisorCompaction = {
          advisor: rt.name,
          number: b.number,
          tokens_before: b.tokens_before,
          tokens_after: b.tokens_after,
          how: b.how,
          kept: b.kept,
          ...(b.error ? { error: b.error } : {}),
        };
        compactions.push(done);
        input.keeper?.done?.(done);
        return { ok: true };
      }
      case ADVISOR_CALL_TURN.path: {
        const b = await bodyOf(ADVISOR_CALL_TURN, c);
        if (b.role !== sent.role)
          throw new Error(`this call's role is ${sent.role}, not ${b.role}`);
        input.later?.(b);
        return { ok: true };
      }
      case ADVISOR_CALL_END.path:
        ended ??= await bodyOf(ADVISOR_CALL_END, c);
        return { ok: true };
      default:
        throw new Error(`no route ${r.path}`);
    }
  };
  let proxy: Awaited<ReturnType<typeof serveAdvisorModel>> | undefined;
  let server: Awaited<ReturnType<typeof serveCall>> | undefined;
  let dir: string | undefined;
  const runner = t.runner;
  try {
    proxy = await serveAdvisorModel({
      api: rt.api === "anthropic" || rt.api === "chatgpt" ? rt.api : undefined,
      baseUrl: rt.base_url.replace(/\/$/, ""),
      key,
    });
    server = await serveCall({ auth, route });
    // One of the runs' root's children, which the advisors' runner hands to its user per run.
    dir = mkdtempSync(join(t.root, "thermite-advisor-"));
    const spec: PiAdvisorSpec = {
      url: server.url,
      auth,
      name: rt.name,
      heading: `Thermite's view of an advisor in Pi · ${rt.name} · ${at.run} · ${rt.model}`,
      sent,
      tools: own.tools.map((x) => ({
        name: x.name,
        label: x.label,
        description: x.description,
        parameters: x.parameters,
      })),
      mcpAt: own.mcpAt,
      ...(tools.mcp?.tools.length
        ? { mcp: { servers: tools.mcp.servers, tools: tools.mcp.tools } }
        : {}),
      answerSchema: input.answerSchema,
      maxTurns: rt.max_turns,
      timeoutS: rt.timeout_s,
    };
    writeFileSync(join(dir, PI_ADVISOR_SPEC_FILE), JSON.stringify(spec), { mode: 0o600 });
    t.consoles.set({ id, run: at.run, role: rt.name.slice(0, 40) }, new TrialConsole(view), true);
    inbox.start();
    log("supervisor", "an advisor's call starts in its Pi view", fields);
    const done = await runInView(
      runner,
      {
        role: id,
        dir,
        // Its route through the call's proxy: the key stays here.
        env: modelEnv(piModel(rt, { baseUrl: proxy.root, apiKey: proxy.token })),
        id,
        argv: [process.execPath, ...process.execArgv, PI_ADVISOR_MAIN],
        timeoutMs: rt.timeout_s !== undefined ? rt.timeout_s * 1000 + END_GRACE_MS : undefined,
      },
      view,
    );
    const where = advisorRoute(rt);
    const tokensIn = ended?.tokens_in ?? 0;
    const tokensOut = ended?.tokens_out ?? 0;
    const result = {
      tokensIn,
      tokensOut,
      usd: (tokensIn * rt.usd_per_mtok_in + tokensOut * rt.usd_per_mtok_out) / 1e6,
      ...(where ? { usage: { ...where, calls: usage } } : {}),
      ...(compactions.length ? { compactions } : {}),
      ...(inbox.taken.length ? { given: [...inbox.taken] } : {}),
    };
    if (answered) return { output, ...result };
    const how = done.exit?.error ?? done.outcome.killedFor ?? done.exit?.code ?? "no exit code";
    const error = ended?.error ?? `its process ended with no answer (${String(how).slice(0, 300)})`;
    log("supervisor", "an advisor in its Pi view gave no answer", { ...fields, error }, "warn");
    return { output: undefined, error, ...result };
  } catch (err) {
    view.ended();
    return fail(`${rt.name} could not run in its Pi view: ${errorText(err)}`);
  } finally {
    t.consoles.ended(id);
    inbox.stop();
    await runner.killRole(id).catch(() => 0);
    if (dir) await runner.remove(dir).catch(() => undefined);
    await server?.close();
    await proxy?.close();
  }
}
