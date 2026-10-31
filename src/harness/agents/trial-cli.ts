import { execFileSync } from "node:child_process";
import {
  CLAIM_LIMITS_WORDS,
  NOTE_USAGE,
  RESEARCH_TOOLS,
  researchOutput,
  researchTool,
} from "../../agents/tools/index.ts";
import { errorText } from "../../common/errors.ts";
import { apiCall } from "./api-call.ts";

/**
 * `thermite-trial`: Thermite's tools for an agent that works through its own shell (the OpenCode
 * harness). It runs as the lane's user, in the lane's workspace, and reaches the harness API with
 * the trial's own token (THERMITE_TRIAL_AUTH), which binds every call to the trial and stops
 * working when the trial ends.
 *
 *   thermite-trial submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...
 *   thermite-trial dev-run [--timeout SECONDS] -- COMMAND...
 *   thermite-trial status ATTEMPT
 *   thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--details TEXT] [--question N]
 *   thermite-trial note --kind KIND [--about TYPE:ID] TEXT
 *   thermite-trial research TOOL [WORDS...] [--FLAG VALUE]... [-]   (the research tools)
 */

const USAGE = `usage:
  thermite-trial submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...
  thermite-trial dev-run [--timeout SECONDS] -- COMMAND...
  thermite-trial status ATTEMPT
  thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--details TEXT] [--question N]
  ${NOTE_USAGE}
    KIND: observation, decision, surprise, question, lesson or note
    TYPE: run, experiment, attempt, source, claim, finding, round, trial or message
      (no --about: the note is about the run)
  thermite-trial research TOOL ... (thermite-trial research help lists them)`;

/**
 * One word that names a command, or asks for help or a list, is never an idea's title: `idea
 * list` is a guess at a command, and would otherwise propose an experiment titled "list".
 */
const COMMAND_WORDS = new Set([
  "submit",
  "dev-run",
  "status",
  "idea",
  "note",
  "research",
  "list",
  "ls",
  "show",
  "help",
  "-h",
  "--help",
]);

export interface TrialCliEnv {
  harnessUrl: string;
  auth: string;
  workspace: string;
  editablePaths: string[];
}

type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The options after a command: repeated flags collect, `--` ends them. */
export function parseArgs(argv: string[]): { flags: Record<string, string[]>; rest: string[] } {
  const flags: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) {
      const value = m[2] ?? argv[++i] ?? "";
      flags[m[1] as string] = [...(flags[m[1] as string] ?? []), value];
    } else rest.push(a);
  }
  return { flags, rest };
}

/** The change inside the editable paths, as a binary patch against the trial's parent. */
export function patchOf(workspace: string, editablePaths: string[]): string {
  const pathspecs = editablePaths.map((p) => `':(glob)${p.replace(/'/g, "")}'`).join(" ");
  return execFileSync("sh", ["-c", `git add -A -- ${pathspecs} && git diff --cached --binary`], {
    cwd: workspace,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
}

/**
 * A research tool's request from its command line: its words fill the tool's main field, flags
 * fill the others, and `-` reads a JSON object of fields from stdin (a heredoc, so the shell
 * changes nothing inside exact quotes). Returns the request, or what is wrong in words.
 */
export function researchRequest(
  name: string,
  args: string[],
  stdin: string | undefined,
): { op: string; body: Record<string, unknown> } | string {
  const tool = researchTool(name);
  if (!tool) return `error: no research tool "${name}"\n${researchHelp()}`;
  const { flags, rest } = parseArgs(args);
  const body: Record<string, unknown> = {};
  const words = rest.filter((w) => w !== "-");
  if (words.length) {
    if (!tool.positional) return `error: ${name} takes no words; use:\n${tool.usage}`;
    body[tool.positional] = words.join(" ");
  }
  for (const [flag, values] of Object.entries(flags)) {
    const a = tool.args[flag];
    if (!a) return `error: ${name} has no --${flag}; use:\n${tool.usage}`;
    if (a.kind === "list") body[a.field] = values;
    else if (a.kind === "number") {
      const n = Number(values.at(-1));
      if (!Number.isFinite(n)) return `error: --${flag} needs a number`;
      body[a.field] = n;
    } else body[a.field] = values.at(-1);
  }
  if (rest.includes("-")) {
    let fields: unknown;
    try {
      fields = JSON.parse(stdin ?? "");
    } catch (err) {
      return `error: "-" reads a JSON object from stdin, and that was not one (${errorText(err)}); use:\n${tool.usage}`;
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields))
      return `error: "-" reads a JSON object from stdin; use:\n${tool.usage}`;
    Object.assign(body, fields);
  }
  return { op: tool.op, body };
}

/** Every research command, with its use. */
export function researchHelp(): string {
  const list = RESEARCH_TOOLS.map((t) => `  ${t.usage.split("\n")[0]}`).join("\n");
  return `research tools:\n${list}\n\nadd_claim: ${CLAIM_LIMITS_WORDS}`;
}

export async function trialCli(
  argv: string[],
  env: TrialCliEnv,
  call: Call,
  /** Reads stdin, only when a research command is given "-". */
  stdin: () => Promise<string> = async () => "",
): Promise<string> {
  const [cmd, ...args] = argv;
  if (cmd === "research") {
    const [name, ...rest] = args;
    if (!name || name === "help" || name === "--help") return researchHelp();
    const fromStdin = parseArgs(rest).rest.includes("-");
    const req = researchRequest(name, rest, fromStdin ? await stdin() : undefined);
    if (typeof req === "string") return req;
    return researchOutput(await call("POST", `/v1/research/${req.op}`, req.body));
  }
  const { flags, rest } = parseArgs(args);
  if (cmd === "submit") {
    const hypothesis = flags.hypothesis?.[0]?.trim();
    if (!hypothesis) return `error: submit needs --hypothesis\n${USAGE}`;
    const patch = patchOf(env.workspace, env.editablePaths);
    if (!patch.trim())
      return `error: there are no changes inside the editable paths (${env.editablePaths.join(", ")})`;
    const out = (await call("POST", "/v1/attempts", {
      patch_base64: Buffer.from(patch).toString("base64"),
      hypothesis: hypothesis.slice(0, 2000),
      claim: flags.claim?.[0]?.slice(0, 2000),
      known_flaws: (flags.flaw ?? []).map((f) => f.slice(0, 1000)),
    })) as { attempt: string; lifecycle: string; violations?: string[] };
    return `submitted ${out.attempt}: ${out.lifecycle}${out.violations?.length ? `; refused: ${out.violations.join("; ")}` : ""}. The trial ends with this submission.`;
  }
  if (cmd === "dev-run") {
    const command = rest.join(" ").trim();
    if (!command) return `error: dev-run needs a command after --\n${USAGE}`;
    const timeout = Number(flags.timeout?.[0]);
    const out = await call("POST", "/v1/dev-runs", {
      command,
      cwd: env.workspace,
      ...(timeout > 0 ? { timeout_s: Math.trunc(timeout) } : {}),
    });
    return JSON.stringify(out, null, 2);
  }
  if (cmd === "status") {
    const id = rest[0];
    if (!id) return `error: status needs an attempt id\n${USAGE}`;
    return JSON.stringify(await call("GET", `/v1/attempts/${encodeURIComponent(id)}`), null, 2);
  }
  if (cmd === "idea") {
    const title = rest.join(" ").trim();
    if (!title) return `error: idea needs a title: what to try, in a few words\n${USAGE}`;
    if (rest.length === 1 && COMMAND_WORDS.has(title.toLowerCase()))
      return `error: "${title}" is a command word, not an idea. idea proposes an experiment: give what to try, in a few words. thermite-trial does not list the run's ideas or queue.\n${USAGE}`;
    const unknown = Object.keys(flags).filter(
      (f) => !["why", "family", "details", "question"].includes(f),
    );
    if (unknown.length) return `error: idea has no --${unknown[0]}\n${USAGE}`;
    const opt = (f: string, n: number) => {
      const v = flags[f]?.at(-1)?.trim();
      return v ? { [f]: v.slice(0, n) } : {};
    };
    // A research task's question, as an index from 0 (goal 117).
    const q = flags.question?.at(-1)?.trim();
    if (q !== undefined && !/^\d+$/.test(q))
      return `error: --question takes the index of a campaign question, a whole number from 0\n${USAGE}`;
    const out = (await call("POST", "/v1/trial/idea", {
      title: title.slice(0, 200),
      ...opt("why", 2000),
      ...opt("family", 80),
      ...opt("details", 4000),
      ...(q !== undefined ? { question: Number(q) } : {}),
    })) as { experiment: string };
    return `proposed ${out.experiment}: it waits until the planner or the campaign's owner queues it or drops it. Your trial goes on.`;
  }
  if (cmd === "note") {
    const text = rest.join(" ").trim();
    const unknown = Object.keys(flags).filter((f) => !["kind", "about"].includes(f));
    if (unknown.length) return `error: note has no --${unknown[0]}\n${USAGE}`;
    const kind = flags.kind?.at(-1)?.trim().toLowerCase();
    if (!kind)
      return `error: note needs --kind: observation, decision, surprise, question, lesson or note\n${USAGE}`;
    if (!text) return `error: note needs its text: what you observed, decided or learned\n${USAGE}`;
    const a = flags.about?.at(-1)?.trim();
    const about = a ? /^([a-z]+):(.+)$/.exec(a) : undefined;
    if (a && !about)
      return `error: --about takes TYPE:ID, for example experiment:x-0123456789ab\n${USAGE}`;
    const out = (await call("POST", "/v1/trial/note", {
      kind,
      text,
      ...(about ? { about: { type: about[1], id: (about[2] as string).trim() } } : {}),
    })) as { note: number };
    return `noted (#${out.note}). Your trial goes on.`;
  }
  return USAGE;
}

async function main(): Promise<void> {
  const env: TrialCliEnv = {
    harnessUrl: process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700",
    auth: process.env.THERMITE_TRIAL_AUTH ?? "",
    workspace: process.env.THERMITE_WORKSPACE ?? process.cwd(),
    editablePaths: JSON.parse(process.env.THERMITE_EDITABLE_PATHS ?? "[]") as string[],
  };
  const call: Call = async (method, path, body) => {
    const r = await apiCall(
      `${env.harnessUrl}${path}`,
      method,
      { authorization: `Bearer ${env.auth}`, "content-type": "application/json" },
      body !== undefined ? JSON.stringify(body) : undefined,
    );
    if (r.status < 200 || r.status >= 300) throw new Error(`${r.status}: ${r.text.slice(0, 500)}`);
    return JSON.parse(r.text);
  };
  const stdin = async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const out = await trialCli(process.argv.slice(2), env, call, stdin);
    process.stdout.write(`${out}\n`);
    if (out.startsWith("error:") || out.startsWith("usage:")) process.exitCode = 2;
  } catch (err) {
    process.stdout.write(`error: ${errorText(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("trial-cli.js") || process.argv[1]?.endsWith("trial-cli.ts"))
  void main();
