import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { errorText } from "../../common/errors.ts";
import { ISSUE, UNTRIED } from "../../core/api/control/owner.ts";
import { briefChange } from "../../core/brief.ts";
import type { CommandKind } from "../../core/commands.ts";
import { CommitSchema, ID_PATTERN, parseContract } from "../../core/contract.ts";
import { controlAt, orFail } from "../calls.ts";
import { briefFromFlags, contextFromFlags, fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * The commands that make a signed command for a rig: assign (a run, from a contract),
 * assign-payload (assign_campaign's payload, printed) and command (any kind, through control).
 */

/**
 * The run's note, from --note TEXT (sent as the signed field `direction`, which the ledger keeps
 * with the run). --direction is its old name: a direction is now a named line of experiments
 * (goal 066). It still works in v0.1.0, and says so on standard error.
 */
function runNote(values: { note?: string | undefined; direction?: string | undefined }) {
  if (values.direction === undefined) return values.note;
  if (values.note !== undefined) fail("--direction is the old name of --note: give only --note");
  process.stderr.write(
    "--direction is now --note: a direction is now a named line of experiments\n",
  );
  return values.direction;
}

function readJsonArg(value: string): unknown {
  return JSON.parse(value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value);
}

/**
 * Prints an issued command's answer: its JSON on standard output, and, when control started the
 * rig's stopped RunPod pod first (an assigned or resumed run), its words on standard error.
 */
function printIssued(out: unknown): void {
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const woke = (out as { woke?: unknown } | null)?.woke;
  if (typeof woke === "string" && woke) process.stderr.write(`${woke}\n`);
}

/** thermite assign-payload: print an assign_campaign payload. */
export function thermiteAssignPayload(rest: string[]): void {
  const { values } = parseArgs({
    args: rest,
    options: {
      contract: { type: "string" },
      run: { type: "string" },
      "seed-repo": { type: "string" },
      "seed-commit": { type: "string" },
      bundle: { type: "string" },
      "bundle-sha256": { type: "string" },
      "kit-repo": { type: "string" },
      "kit-commit": { type: "string" },
      "kit-bundle": { type: "string" },
      "kit-bundle-sha256": { type: "string" },
      model: { type: "string", multiple: true },
      note: { type: "string" },
      direction: { type: "string" },
      agents: { type: "string" },
    },
  });
  if (values.agents !== undefined && values.agents !== "on" && values.agents !== "off")
    fail("--agents is on or off");
  const note = runNote(values);
  if (
    !values.contract ||
    !values.run ||
    !values["seed-repo"] ||
    !values["seed-commit"] ||
    !values.bundle
  ) {
    fail(USAGE);
  }
  if (!CommitSchema.safeParse(values["seed-commit"]).success)
    fail("--seed-commit must be a full commit id (40 or 64 hexadecimal characters)");
  const r = parseContract(JSON.parse(readFileSync(values.contract, "utf8")));
  if (!r.ok) fail(r.errors.join("\n"));
  const models = (values.model ?? []).map((m) => {
    const match = /^([^=]+)=([0-9a-f]{64}):(.+)$/.exec(m);
    if (!match) fail(`bad --model ${m}; expected NAME=SHA256:PATH`);
    return { kind: "model", name: match[1], sha256: match[2], path: match[3] };
  });
  const payload = {
    run: values.run,
    contract: r.contract,
    contract_sha: r.sha,
    seed: { repo: values["seed-repo"], commit: values["seed-commit"] },
    ...(note ? { direction: note } : {}),
    ...(values.agents === "off" ? { agents: false } : {}),
    imports: [
      {
        kind: "repo_bundle",
        path: values.bundle,
        repo: values["seed-repo"],
        commit: values["seed-commit"],
        ...(values["bundle-sha256"] ? { sha256: values["bundle-sha256"] } : {}),
      },
      ...(values["kit-bundle"]
        ? [
            {
              kind: "kit_bundle",
              path: values["kit-bundle"],
              repo: values["kit-repo"],
              commit: values["kit-commit"],
              ...(values["kit-bundle-sha256"] ? { sha256: values["kit-bundle-sha256"] } : {}),
            },
          ]
        : []),
      ...models,
    ],
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** thermite assign: start a run, through control (or --print its payload). */
export async function thermiteAssign(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      contract: { type: "string" },
      run: { type: "string" },
      seed: { type: "string" },
      "seed-commit": { type: "string" },
      kit: { type: "string" },
      model: { type: "string", multiple: true },
      note: { type: "string" },
      direction: { type: "string" },
      agents: { type: "string" },
      promotion: { type: "string" },
      ask: { type: "string", multiple: true },
      "queue-from": { type: "string" },
      "mcp-servers": { type: "string" },
      "context-window": { type: "string" },
      "compact-at": { type: "string" },
      "info-file": { type: "string" },
      link: { type: "string", multiple: true },
      idea: { type: "string", multiple: true },
      hypothesis: { type: "string", multiple: true },
      control: { type: "string" },
      "token-file": { type: "string" },
      rig: { type: "string" },
      ttl: { type: "string" },
      print: { type: "boolean" },
    },
  });
  if (!values.contract || !values.run) fail(USAGE);
  const ownContext = contextFromFlags(values);
  if (values.agents !== undefined && values.agents !== "on" && values.agents !== "off")
    fail("--agents is on or off");
  const note = runNote(values);
  if (values.promotion !== undefined && !["auto", "owner"].includes(values.promotion))
    fail("--promotion is auto or owner");
  const { askOwnerOption } = await import("../run.ts");
  let ask: ReturnType<typeof askOwnerOption>;
  try {
    ask = askOwnerOption(values.ask);
  } catch (err) {
    fail(errorText(err));
  }
  if (!values.print && (!values.control || !values["token-file"] || !values.rig))
    fail("give --control, --token-file and --rig to issue it, or --print to show it");
  // A past run's untried experiments (goal 067), from control's records of that run, which
  // control finds by its name alone (goal 170).
  const past = values["queue-from"];
  if (past !== undefined) {
    // As the harness refuses it: nothing would take the experiments of a run without agents.
    if (values.agents === "off") fail("a run without agents has no queue: leave out --queue-from");
    if (!values.control || !values["token-file"])
      fail("--queue-from reads the past run from control: give --control and --token-file");
    if (!past) fail("--queue-from names a run");
  }
  const fromFile = parseContract(JSON.parse(readFileSync(values.contract, "utf8")));
  if (!fromFile.ok) fail(fromFile.errors.join("\n"));
  // The campaign's brief over the file's (goal 078): each part given replaces the file's.
  const brief = briefFromFlags(values);
  if (brief.ideas && fromFile.contract.mode === "research")
    fail("--idea is for hill-climb and goal campaigns: a research campaign has questions");
  const withBrief = briefChange(fromFile.contract, brief);
  if (typeof withBrief === "string") fail(withBrief);
  // The campaign's own context settings over the file's (goal 070): a contract with another hash.
  const r =
    ownContext || Object.keys(brief).length
      ? parseContract({
          ...withBrief,
          ...(ownContext
            ? {
                agents_context: { ...fromFile.contract.agents_context, ...ownContext },
              }
            : {}),
        })
      : fromFile;
  if (!r.ok) fail(r.errors.join("\n"));
  const contract = r.contract;
  const full = (c: string | undefined, what: string) => {
    if (!c || !CommitSchema.safeParse(c).success)
      fail(`${what} must be a full commit id (40 or 64 hexadecimal characters)`);
    return c;
  };
  // "URL@COMMIT", where a URL may itself hold "@" (git@host:path).
  const ref = (v: string) => {
    const at = v.lastIndexOf("@");
    const tail = at > 0 ? v.slice(at + 1) : "";
    return CommitSchema.safeParse(tail).success
      ? { url: v.slice(0, at), commit: tail }
      : { url: v, commit: undefined };
  };
  const imports: unknown[] = [];
  let seed: { repo: string; commit: string } | undefined;
  if (contract.mode !== "research") {
    const repo = contract.project.repo;
    if (values.seed && values["seed-commit"]) fail("--seed or --seed-commit, not both");
    if (values.seed) {
      const s = ref(values.seed);
      const commit = full(s.commit ?? contract.project.commit, "the seed commit");
      seed = { repo, commit };
      imports.push({
        kind: "repo_bundle",
        path: `repos/${repo}-${commit}.bundle`,
        repo,
        commit,
        source: { git: s.url },
      });
    } else {
      seed = {
        repo,
        commit: full(values["seed-commit"] ?? contract.project.commit, "--seed-commit"),
      };
    }
    const kit = contract.project.kit;
    if (values.kit) {
      if (!kit) fail("--kit given, but the contract names no project.kit");
      // A kit control keeps (goal 096): fetched from control, as this rig.
      const kept = /^control:(.*)$/.exec(values.kit)?.[1];
      if (kept !== undefined && !ID_PATTERN.test(kept))
        fail(`--kit control:NAME names a kit control keeps: ${JSON.stringify(kept)} is not one`);
      imports.push({
        kind: "kit_bundle",
        path: `repos/kit-${kit.repo}-${kit.commit}.bundle`,
        repo: kit.repo,
        commit: kit.commit,
        source: kept !== undefined ? { control: `kits/${kept}` } : { git: values.kit },
      });
    }
  }
  for (const m of values.model ?? []) {
    const eq = m.indexOf("=");
    const name = m.slice(0, eq);
    const listed = contract.models.find((x) => x.name === name);
    if (eq < 1 || !listed) fail(`--model ${m}: expected NAME=URL for a model the contract lists`);
    imports.push({
      kind: "model",
      path: `models/${listed.sha256}`,
      name,
      sha256: listed.sha256,
      source: { url: m.slice(eq + 1) },
    });
  }
  // The same seed as Start a run: up next in order, then the lanes' ideas, at most 500, with
  // the words and authors control's records hold for this contract's campaign, as over MCP.
  let queue: unknown[] = [];
  if (past) {
    const control = controlAt(values.control as string, values["token-file"] as string);
    const from = await orFail(
      control.call(UNTRIED, { params: { run: past }, query: { campaign: contract.campaign } }),
    );
    queue = from.queue;
    if (!queue.length)
      process.stderr.write(
        `${past} has no untried experiments: the new run's queue starts empty\n`,
      );
  }
  const payload = {
    run: values.run,
    contract,
    contract_sha: r.sha,
    ...(seed ? { seed } : {}),
    ...(note ? { direction: note } : {}),
    ...(values.agents === "off" ? { agents: false } : {}),
    // The run's own promotion policy; unset, the rig's default applies.
    ...(values.promotion
      ? { promotion: values.promotion === "owner" ? "owner_approval" : "auto" }
      : {}),
    // What else the run asks the owner about (goal 079); unset: nothing.
    ...(ask ? { ask_owner: ask } : {}),
    imports,
    ...(queue.length ? { queue } : {}),
    // The MCP servers the kit's kit.json names: the rig refuses a run whose list differs.
    ...(values["mcp-servers"] ? { mcp_servers: readJsonArg(values["mcp-servers"]) } : {}),
  };
  if (values.print) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const control = controlAt(values.control as string, values["token-file"] as string);
  const out = await orFail(
    control.call(ISSUE, {
      body: {
        rig: values.rig as string,
        kind: "assign_campaign",
        payload,
        ...(values.ttl ? { ttl_minutes: Number(values.ttl) } : {}),
      },
    }),
  );
  printIssued(out);
}

/** thermite command: issue a signed command through control. */
export async function thermiteCommand(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      rig: { type: "string" },
      kind: { type: "string" },
      payload: { type: "string" },
      ttl: { type: "string" },
    },
  });
  // A kind about one run may leave out --rig: control sends it to the run's rig (goal 170).
  if (!values.control || !values["token-file"] || !values.kind || !values.payload) fail(USAGE);
  const out = await orFail(
    controlAt(values.control, values["token-file"]).call(ISSUE, {
      body: {
        ...(values.rig ? { rig: values.rig } : {}),
        // Control checks the kind, and refuses one it does not know in words.
        kind: values.kind as CommandKind,
        payload: readJsonArg(values.payload),
        ...(values.ttl ? { ttl_minutes: Number(values.ttl) } : {}),
      },
    }),
  );
  printIssued(out);
}
