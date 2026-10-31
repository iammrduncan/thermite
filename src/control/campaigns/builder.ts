import { z } from "zod";
import { shellQuote } from "../../common/exec.ts";
import { agentsContextRefusal } from "../../core/compaction.ts";
import {
  CommitSchema,
  DurationSchema,
  FolderSchema,
  IdSchema,
  MAX_LANES,
  MAX_LANES_REASON,
  parseContract,
} from "../../core/contract.ts";
import { CampaignId } from "../../core/ids.ts";
import { KitSchema, kitProblems } from "../../core/kit.ts";
import { type McpUse, McpUses } from "../../core/mcp.ts";
import { requestedAdditions } from "../../core/role-additions.ts";

/**
 * The new-campaign page's answers, turned into a contract and, for a kit described on the
 * page, the kit itself. Everything here is checked as the harness would check it, so a
 * campaign the page accepts is one a rig accepts.
 *
 * A kit described on the page is a few shell commands. Control writes two small wrappers around
 * them, so the person writing them never meets the kit's own placeholders:
 *   run/run.sh      runs the run command with {build}, {out}, {kit} and each case's parameters
 *   check/check.sh  runs the check command and turns its exit status into the judge's verdict
 */

const ParamName = z.string().regex(/^[a-z_][a-z0-9_]{0,31}$/, "a parameter name: a-z, 0-9, _");
const FileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "a file name: letters, digits, . _ -");
const GitUrl = z
  .string()
  .max(2000)
  .regex(/^(?:https:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/, "an https, ssh or git URL");
const Glob = z.string().min(1).max(500);

/** One test case: a name and what makes its run different, all optional. */
const Case = z.strictObject({
  name: CampaignId,
  /** Added to the run command as {args}. */
  args: z.string().max(2000).optional(),
  /** One of the kit's input files, given to the run as {input}. */
  input: FileName.optional(),
  /** Named values, as {name} in the commands. */
  params: z.record(ParamName, z.union([z.string().max(500), z.number()])).default({}),
  /** How much one run does (requests, frames, bytes): then the score is a rate, not time. */
  work: z.number().positive().optional(),
  /** A hidden test: used only to double-check a change that already looks better. */
  hidden: z.boolean().default(false),
});

const KitHere = z.strictObject({
  source: z.literal("here"),
  build: z.string().min(1).max(4000),
  outputs: z.array(z.string().min(1).max(500)).min(1),
  cases: z.array(Case).min(1).max(64),
  run: z.string().min(1).max(4000),
  check: z.string().min(1).max(4000),
  /** Files the kit carries: references and inputs. `run` files are also visible to the run. */
  files: z
    .array(
      z.strictObject({
        name: FileName,
        content_base64: z.string().max(14_000_000),
        run: z.boolean().default(false),
      }),
    )
    .max(32)
    .default([]),
  /** Input files the cases run on ({input}): both the run and the check can read them. */
  inputs: z
    .array(z.strictObject({ name: FileName, content_base64: z.string().max(14_000_000) }))
    .max(32)
    .default([]),
  build_timeout_s: z.number().int().positive().max(86_400).optional(),
  run_timeout_s: z.number().int().positive().max(86_400).optional(),
  held_out: z.array(IdSchema).default([]),
  /** Runs per case in each measurement; their median counts. */
  runs_per_case: z.number().int().min(1).max(9).optional(),
});
/** Git access control keeps, by name (Settings), for a private repository. */
const AccessName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a Git access name");

const KitRepo = z.strictObject({
  source: z.literal("repo"),
  url: GitUrl,
  access: AccessName.optional(),
  commit: CommitSchema,
  repo: IdSchema,
  /** The kit's cases this campaign measures, and those held back for confirmation. */
  cells: z.array(IdSchema).min(1),
  held_out: z.array(IdSchema).default([]),
});

/** A kit uploaded on the page (kits/upload.ts), by its archive's sha256, with the cases to use. */
const KitUploaded = z.strictObject({
  source: z.literal("upload"),
  upload: z.string().regex(/^[0-9a-f]{64}$/, "an uploaded kit's id"),
  cells: z.array(IdSchema).min(1),
  held_out: z.array(IdSchema).default([]),
});

const Goal = z.strictObject({
  id: IdSchema,
  description: z.string().min(1).max(2000),
  required: z.boolean().default(true),
  verify: z.discriminatedUnion("type", [
    /** The check passes on every one of these cases. */
    z.strictObject({ type: z.literal("check"), cells: z.array(IdSchema).min(1) }),
    /** One of a kit's own checks passes (a kit from a repository or an upload). */
    z.strictObject({ type: z.literal("verifier"), verifier: IdSchema }),
    /** The score clears a bound on these cases. */
    z.strictObject({
      type: z.literal("metric"),
      op: z.enum([">=", "<=", ">", "<"]),
      value: z.number(),
      cells: z.array(IdSchema).min(1),
    }),
    /** People review it. */
    z.strictObject({
      type: z.literal("review"),
      criteria: z.array(z.string().min(1).max(500)).min(1),
    }),
  ]),
});

export const CampaignDraft = z.strictObject({
  mode: z.enum(["hill_climb", "goal", "research"]),
  campaign: IdSchema,
  title: z.string().min(1).max(300),
  /**
   * The campaign's brief (goal 078), with no length limit: the additional information (Markdown,
   * the contract's notes), the ideas to try (hill climb and goal) and the hypotheses. The agents
   * get it as starting points, not rules (core/brief.ts).
   */
  notes: z.string().optional(),
  ideas: z.array(z.string()).optional(),
  hypotheses: z.array(z.string()).optional(),
  /** Hill climb and goal: the starting links the agents get with the brief. Research: its seeds. */
  links: z.array(z.string()).optional(),
  /** The rig's measurement target, from the rig the campaign starts on. */
  target: z.strictObject({ type: z.string().min(1), class: z.string().min(1) }),
  project: z
    .strictObject({
      url: GitUrl,
      access: AccessName.optional(),
      ref: z.string().max(300).optional(),
      commit: CommitSchema,
      repo: IdSchema,
      /** The project's folder in the repository, when it is not the whole repository. */
      folder: FolderSchema.optional(),
      editable_paths: z.array(Glob).min(1),
      forbidden_patterns: z.array(z.string().min(1).max(500)).default([]),
    })
    .optional(),
  kit: z.discriminatedUnion("source", [KitHere, KitRepo, KitUploaded]).optional(),
  /**
   * The score. "time": how long a run takes, from the judge's clock (a rate instead when every
   * case, hidden ones too, says how much work it does). "check": a number the check works out from the
   * run's output and prints in its JSON line, under `field`.
   */
  score: z
    .strictObject({
      kind: z.enum(["time", "check"]).default("time"),
      name: IdSchema.optional(),
      field: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
        .optional(),
      unit: z.string().max(40).optional(),
      direction: z.enum(["max", "min"]).default("max"),
      min_effect: z.number().positive().max(10).default(0.05),
    })
    .optional(),
  goals: z.array(Goal).max(64).optional(),
  research: z
    .strictObject({
      topic: z.string().min(1).max(2000),
      // Each question may be long and have several lines (goal 078); at least one is needed.
      questions: z.array(z.string()),
      // The starting links (goal 078): the harness archives them when a run starts.
      seeds: z.array(z.string()).default([]),
      min_duration: DurationSchema,
      /**
       * The floor of verified claims before the review panel first checks whether every
       * question is answered (goal 112): the contract's min_verified_claims. Left out: no floor.
       */
      min_verified_claims: z
        .number()
        .int("Verified claims before the check is a whole number")
        .min(1, "Verified claims before the check is 1 or more")
        .optional(),
    })
    .optional(),
  lanes: z.number().int().min(1).max(MAX_LANES, MAX_LANES_REASON).default(2),
  /**
   * Ideas kept ready (goal 081): the contract's lanes.queue_target, the experiments the queue
   * keeps ready for a hill climb's or a goal's lanes. A target, never a cap. Left out: two for
   * each lane.
   */
  queue_target: z
    .number()
    .int("Ideas kept ready is a whole number")
    .min(0, "Ideas kept ready is 0 or more")
    .max(1000, "Ideas kept ready is at most 1000")
    .optional(),
  limits: z
    .strictObject({
      trial_minutes: z.number().int().min(1).max(1440).optional(),
      run_rss_mib: z.number().int().min(256).max(16384).optional(),
      workspace_mib: z.number().int().min(256).max(65536).optional(),
    })
    .default({}),
  wall_hours: z.number().positive().optional(),
  /**
   * The campaign's own context window and compaction point for all its runs' agents (goal 070),
   * in its contract. Left out: each agent keeps the rig's. Values out of range are refused in
   * words (agentsContextRefusal).
   */
  agents_context: z
    .strictObject({ context_window: z.number().optional(), compact_at: z.number().optional() })
    .optional(),
  /**
   * The owner's additions to the roles of the campaign's agents (goal 166), by role id, in its
   * contract as `role_additions`. An empty one is left out; the contract's own check refuses a
   * role the mode never runs, in words.
   */
  role_additions: z.record(z.string(), z.string()).optional(),
  /**
   * The MCP servers the campaign's agents use (goal 068), by their names in Settings, with the
   * agents that get each and, only when narrowed, their tools. A kit described here or uploaded
   * gets them in its kit.json; a kit in a repository has its own (give what its kit.json names:
   * the rig checks them); a research campaign keeps them in its contract. Left out: an uploaded
   * kit keeps its own list.
   */
  mcp_servers: McpUses.optional(),
});
export type CampaignDraft = z.input<typeof CampaignDraft>;

export interface BuiltKit {
  /** The kit's repository name (and kit.json name). */
  name: string;
  /** Path in the kit → content. */
  files: Record<string, Buffer>;
}

export type Built =
  | {
      ok: true;
      contract: Record<string, unknown>;
      kit?: BuiltKit | undefined;
      /** The MCP servers the campaign's kit (or research contract) names, as built. */
      mcp_servers?: McpUse[] | undefined;
    }
  | { ok: false; errors: string[] };

/** An http or https address, as the contract's links and seeds take them. */
function webAddress(x: string): boolean {
  try {
    const u = new URL(x);
    return (u.protocol === "https:" || u.protocol === "http:") && !/\s/.test(x);
  } catch {
    return false;
  }
}

/** The kit's name for a campaign: its own repository beside the project. */
export const kitName = (campaign: string) => `${campaign.slice(0, 59)}-kit`;

/** A shell word: single-quoted, with any single quote closed, escaped and reopened. */

/**
 * A command as written on the page, with its placeholders as shell variables: {build}, {out}
 * and {kit} for the directories, and {name} for each case parameter. Unknown placeholders are
 * an error, so a typo does not reach a rig.
 */
export function shellCommand(
  cmd: string,
  params: Set<string>,
): { text: string; unknown: string[] } {
  const fixed: Record<string, string> = {
    build: `"$BUILD"`,
    out: `"$OUT"`,
    kit: `"$KIT"`,
    // The case's arguments, split into words as written.
    args: "$P_args",
    // The case's input file, from the kit's inputs.
    input: '"$KIT/inputs/$P_input"',
  };
  const unknown: string[] = [];
  const text = cmd.replace(/\{([a-z_][a-z0-9_]*)\}/g, (m, name: string) => {
    if (fixed[name]) return fixed[name] as string;
    if (params.has(name)) return `"$P_${name}"`;
    unknown.push(m);
    return m;
  });
  return { text, unknown };
}

const wrapper = (kind: "run" | "check", command: string) => `#!/bin/sh
# Written by Thermite control from the new-campaign page: the ${kind} command as entered there.
# Arguments: the build, the output directory, the case's parameters (key=value lines), the kit.
set -u
BUILD="$1"; OUT="$2"; PARAMS="$3"; KIT="$4"
export BUILD OUT KIT
# A case's arguments and input file, empty unless it has them.
P_args=; P_input=
while IFS='=' read -r k v; do
  [ -n "$k" ] && eval "P_$k=\\$v" && export "P_$k"
done < "$PARAMS"
${
  kind === "run"
    ? `exec sh -c ${shellQuote(command)}`
    : `# The judge reads one JSON line: pass when the command exits 0.
tail_file="$(mktemp)"
sh -c ${shellQuote(command)} > "$tail_file" 2>&1
status=$?
last="$(tail -n 1 "$tail_file")"
if [ "$status" -eq 0 ]; then
  # A check that prints its own JSON line (a score such as {"pass": true, "accuracy": 0.93})
  # is passed on as it is.
  case "$last" in
    "{"*'"pass"'*"}") printf '%s\n' "$last" ;;
    *) echo '{"pass": true, "reasons": []}' ;;
  esac
else
  reason="$(tail -c 400 "$tail_file" | tr '\\n"\\\\' '   ' )"
  printf '{"pass": false, "reasons": ["the check exited %s: %s"]}\\n' "$status" "$reason"
fi
rm -f "$tail_file"`
}
`;

/**
 * Builds the contract (and kit) from the page's answers, or says what is wrong in words.
 * `uploads` gives the files of a kit uploaded earlier, by its id.
 */
export function buildCampaign(
  input: unknown,
  opts: { uploads?: (id: string) => Record<string, Buffer> | undefined } = {},
): Built {
  const parsed = CampaignDraft.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "the form"}: ${i.message}`),
    };
  const d = parsed.data;
  const errors: string[] = [];
  const context = d.agents_context;
  const contextRefused = context ? agentsContextRefusal(context) : undefined;
  if (contextRefused) return { ok: false, errors: [`The agents' context: ${contextRefused}`] };
  const own = {
    ...(context?.context_window !== undefined ? { context_window: context.context_window } : {}),
    ...(context?.compact_at !== undefined ? { compact_at: context.compact_at } : {}),
  };
  const additions = requestedAdditions(d.role_additions);
  // The brief's lists: entries trimmed, empty ones left out (goal 078).
  const entries = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
  const ideas = entries(d.ideas);
  const hypotheses = entries(d.hypotheses);
  // Starting links (goal 078): web addresses, refused in words otherwise.
  const notLinks = [...(d.links ?? []), ...(d.research?.seeds ?? [])].filter((x) => !webAddress(x));
  if (notLinks.length)
    return {
      ok: false,
      errors: notLinks.map(
        (x) => `Starting links: ${x.slice(0, 200)} is not a web address: write it as https://…`,
      ),
    };
  if (d.mode === "research" && d.links?.length)
    return {
      ok: false,
      errors: ["a research campaign's starting links are its seeds: give them as research.seeds"],
    };
  if (d.mode === "research" && ideas.length)
    return {
      ok: false,
      errors: [
        "Ideas to try are for hill-climb and goal campaigns: give a research campaign questions and hypotheses",
      ],
    };
  const contract: Record<string, unknown> = {
    schema_version: 1,
    campaign: d.campaign,
    version: 1,
    title: d.title,
    mode: d.mode,
    lanes: {
      count: d.lanes,
      ...(Object.keys(d.limits).length ? { limits: d.limits } : {}),
      // A research campaign has its research plan: no target (goal 081).
      ...(d.queue_target !== undefined && d.mode !== "research"
        ? { queue_target: d.queue_target }
        : {}),
    },
    ...(d.notes?.trim() ? { notes: d.notes } : {}),
    ...(ideas.length ? { ideas } : {}),
    ...(hypotheses.length ? { hypotheses } : {}),
    ...(d.mode !== "research" && d.links?.length ? { links: d.links } : {}),
    ...(d.wall_hours ? { budget: { wall_hours: d.wall_hours } } : {}),
    ...(Object.keys(own).length ? { agents_context: own } : {}),
    ...(additions ? { role_additions: additions } : {}),
  };

  if (d.mode === "research") {
    if (!d.research)
      return { ok: false, errors: ["a research campaign needs its topic and questions"] };
    const questions = entries(d.research.questions);
    if (!questions.length)
      return { ok: false, errors: ["a research campaign needs at least one question"] };
    Object.assign(contract, {
      project: { repo: d.project?.repo ?? `${d.campaign.slice(0, 50)}-notes` },
      topic: d.research.topic,
      questions,
      seeds: d.research.seeds,
      min_duration: d.research.min_duration,
      ...(d.research.min_verified_claims !== undefined
        ? { min_verified_claims: d.research.min_verified_claims }
        : {}),
      // A research campaign has no kit: its contract names its MCP servers.
      ...(d.mcp_servers?.length ? { mcp_servers: d.mcp_servers } : {}),
    });
    const r = parseContract(contract);
    return r.ok
      ? { ok: true, contract, ...(d.mcp_servers?.length ? { mcp_servers: d.mcp_servers } : {}) }
      : { ok: false, errors: r.errors };
  }

  if (!d.project)
    errors.push("the campaign needs its project: a repository and the files agents may change");
  if (!d.kit)
    errors.push("the campaign needs a way to measure: describe the kit, or name a kit repository");
  if (errors.length || !d.project || !d.kit) return { ok: false, errors };

  let kit: BuiltKit | undefined;
  let kitRef: { repo: string; commit?: string };
  let cells: string[] = [];
  let heldOut: string[] = [];
  // The score: what the judge compares, and which way is better.
  let metric = d.score?.name ?? (d.score?.kind === "check" ? (d.score.field ?? "score") : "rate");
  let direction: "max" | "min" = d.score?.direction ?? "max";
  let mcpServers: McpUse[] = [];
  if (d.kit.source === "here") {
    const k = d.kit;
    if (d.goals?.some((g) => g.verify.type === "verifier"))
      errors.push(
        "a kit described here has no checks of its own: check a goal by the check passing on cases",
      );
    const params = new Set(k.cases.flatMap((c) => Object.keys(c.params)));
    const run = shellCommand(k.run, params);
    const check = shellCommand(k.check, params);
    for (const u of [...run.unknown, ...check.unknown])
      errors.push(
        `${u} is not a placeholder here: use {args}, {input}, {build}, {out} or {kit}${params.size ? `, or a value: ${[...params].map((p) => `{${p}}`).join(", ")}` : ""}`,
      );
    const names = new Set<string>();
    const inputs = new Set(k.inputs.map((f) => f.name));
    for (const c of k.cases) {
      if (names.has(c.name)) errors.push(`two test cases are named ${c.name}`);
      names.add(c.name);
      if (c.input && !inputs.has(c.input))
        errors.push(`test case ${c.name} runs on ${c.input}, which is not among the input files`);
    }
    for (const h of k.held_out)
      if (!names.has(h)) errors.push(`hidden test ${h} is not one of the test cases`);
    heldOut = [...new Set([...k.held_out, ...k.cases.filter((c) => c.hidden).map((c) => c.name)])];
    cells = k.cases.map((c) => c.name).filter((n) => !heldOut.includes(n));
    if (!cells.length)
      errors.push("at least one test case must be measured every time, not only as a hidden test");
    const files: Record<string, Buffer> = {
      "run/run.sh": Buffer.from(wrapper("run", run.text)),
      "check/check.sh": Buffer.from(wrapper("check", check.text)),
    };
    const seen = new Set<string>();
    for (const f of k.files) {
      if (seen.has(f.name) || f.name === "run.sh" || f.name === "check.sh" || f.name === "inputs")
        errors.push(`the file ${f.name} is given twice, or has a name the kit uses itself`);
      seen.add(f.name);
      const body = Buffer.from(f.content_base64, "base64");
      files[`check/${f.name}`] = body;
      if (f.run) files[`run/${f.name}`] = body;
    }
    // Input files: the run reads them as {input}, and so may the check.
    for (const f of k.inputs) {
      const body = Buffer.from(f.content_base64, "base64");
      files[`run/inputs/${f.name}`] = body;
      files[`check/inputs/${f.name}`] = body;
    }
    // Time, or a rate when every case says how much work it does, or the check's number. A
    // hidden case runs too, at confirmation, and a rate needs its work as much as any other's.
    const kind = d.score?.kind ?? "time";
    const measured = k.cases.filter((c) => !heldOut.includes(c.name));
    let metricDef: Record<string, unknown>;
    if (kind === "check") {
      const field = d.score?.field;
      if (!field) errors.push("name the number your check reports (for example accuracy)");
      metricDef = { unit: d.score?.unit ?? "", from: "check", field: field ?? "score" };
    } else if (measured.length && k.cases.every((c) => c.work)) {
      metricDef = { unit: d.score?.unit ?? "per s", work: "work" };
      direction = "max";
    } else {
      metric = d.score?.name ?? "seconds";
      metricDef = { unit: "s", from: "time" };
      direction = "min";
    }
    const manifest = {
      schema_version: 1,
      name: kitName(d.campaign),
      target: d.target.type,
      build: {
        command: ["sh", "-c", k.build],
        outputs: k.outputs,
        ...(k.build_timeout_s ? { timeout_s: k.build_timeout_s } : {}),
      },
      cells: Object.fromEntries(
        k.cases.map((c) => [
          c.name,
          {
            ...c.params,
            ...(c.args ? { args: c.args } : {}),
            ...(c.input ? { input: c.input } : {}),
            ...(c.work ? { work: c.work } : {}),
          },
        ]),
      ),
      run: {
        copy: ["run"],
        command: ["sh", "{kit:run/run.sh}", "{build}", "{out}", "{params}", "{kit:run}"],
        ...(k.run_timeout_s ? { timeout_s: k.run_timeout_s } : {}),
      },
      metrics: { [metric]: metricDef },
      check: {
        command: ["sh", "{kit:check/check.sh}", "{build}", "{out}", "{params}", "{kit:check}"],
      },
      verifiers: Object.fromEntries(
        (d.goals ?? [])
          .filter((g) => g.verify.type === "check")
          .map((g) => [g.id, { cells: (g.verify as { cells: string[] }).cells }]),
      ),
      ...(d.mcp_servers?.length ? { mcp_servers: d.mcp_servers } : {}),
    };
    mcpServers = d.mcp_servers ?? [];
    files["kit.json"] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const kitCheck = KitSchema.safeParse(manifest);
    if (!kitCheck.success)
      errors.push(
        ...kitCheck.error.issues.map((i) => `the kit: ${i.path.join(".")}: ${i.message}`),
      );
    kit = { name: kitName(d.campaign), files };
    kitRef = { repo: kit.name };
  } else if (d.kit.source === "upload") {
    // An uploaded kit is kept by control like one described here; its cases and scores are its own.
    let files = opts.uploads?.(d.kit.upload);
    if (!files) return { ok: false, errors: ["the uploaded kit is gone: upload it again"] };
    const k = d.kit;
    cells = k.cells.filter((c) => !k.held_out.includes(c));
    heldOut = k.held_out;
    let manifest: { metrics?: Record<string, unknown>; mcp_servers?: unknown } = {};
    try {
      manifest = JSON.parse(String(files["kit.json"]));
    } catch {
      return { ok: false, errors: ["the uploaded kit's kit.json is not JSON"] };
    }
    // Control keeps an uploaded kit, so the page may change its MCP servers: kit.json follows.
    if (d.mcp_servers !== undefined) {
      const { mcp_servers: _old, ...rest } = manifest;
      manifest = d.mcp_servers.length ? { ...rest, mcp_servers: d.mcp_servers } : rest;
      files = { ...files, "kit.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
    }
    mcpServers = McpUses.safeParse(manifest.mcp_servers ?? []).data ?? [];
    const names = Object.keys(manifest.metrics ?? {});
    if (d.mode === "hill_climb" && !d.score?.name) metric = names[0] ?? metric;
    // A time score improves downwards whatever the page said.
    if ((manifest.metrics?.[metric] as { from?: string } | undefined)?.from === "time")
      direction = "min";
    kit = { name: kitName(d.campaign), files };
    kitRef = { repo: kit.name };
  } else {
    kitRef = { repo: d.kit.repo, commit: d.kit.commit };
    cells = d.kit.cells.filter((c) => !d.kit?.held_out.includes(c));
    heldOut = d.kit.held_out;
    // A kit in a repository has its own kit.json: the page read its servers from it, and the
    // rig's harness checks them against it.
    mcpServers = d.mcp_servers ?? [];
  }

  Object.assign(contract, {
    // The kit's commit is filled in when control stores a kit it wrote.
    project: {
      repo: d.project.repo,
      ...(d.project.folder ? { folder: d.project.folder } : {}),
      kit: { repo: kitRef.repo, commit: kitRef.commit ?? "0".repeat(40) },
    },
    target: d.target,
    editable_paths: d.project.editable_paths,
    forbidden_patterns: d.project.forbidden_patterns,
  });
  if (d.mode === "hill_climb") {
    Object.assign(contract, {
      objective: {
        primary: {
          metric,
          direction,
          min_effect: d.score?.min_effect ?? 0.05,
        },
      },
      cells,
      ...(heldOut.length ? { held_out_cells: heldOut } : {}),
      ...(d.kit.source === "here" && d.kit.runs_per_case
        ? { acceptance: { runs_per_cell: d.kit.runs_per_case } }
        : {}),
    });
  } else {
    if (!d.goals?.length) errors.push("a goal campaign needs at least one goal");
    Object.assign(contract, {
      goals: (d.goals ?? []).map((g, i) => ({
        id: g.id,
        description: g.description,
        priority: i + 1,
        required: g.required,
        verify:
          g.verify.type === "check"
            ? { type: "code", verifier: g.id }
            : g.verify.type === "verifier"
              ? { type: "code", verifier: g.verify.verifier }
              : g.verify.type === "metric"
                ? {
                    type: "metric_threshold",
                    metric,
                    op: g.verify.op,
                    value: g.verify.value,
                    cells: g.verify.cells,
                  }
                : { type: "review", criteria: g.verify.criteria },
      })),
      deliverable: "a commit that meets every required goal",
      ...(heldOut.length ? { held_out_cells: heldOut } : {}),
    });
  }
  if (errors.length) return { ok: false, errors };
  const r = parseContract(contract);
  if (!r.ok) return { ok: false, errors: r.errors };
  // The contract against the kit, as the harness checks it at assignment.
  if (kit) {
    const parsedKit = KitSchema.safeParse(JSON.parse(String(kit.files["kit.json"])));
    if (!parsedKit.success) return { ok: false, errors: ["the kit's kit.json is not a valid kit"] };
    const problems = kitProblems(r.contract, parsedKit.data, d.target.type);
    if (problems.length) return { ok: false, errors: problems };
  }
  return { ok: true, contract, kit, ...(mcpServers.length ? { mcp_servers: mcpServers } : {}) };
}
