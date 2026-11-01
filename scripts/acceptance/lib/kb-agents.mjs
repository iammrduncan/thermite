// The knowledge base's scene of the agents acceptance (goal 175), on its scripted model: lane-1's
// worker in Pi and a hill-climb trial in OpenCode each write an item with kb_write into their own
// slot (worker-<lane>), and a write naming another slot, which kb_write never takes, is refused;
// the owner's search finds each item in its slot, and none of the refused ones; then a second run
// of the campaign, smoke-2, whose planner searches with kb_search and finds both items: an agent
// of another run. Its planner follows the workers, so it plans in Pi (the workers run in OpenCode
// on a provider's route, which a planner that follows them reaches through Pi); in OpenCode its
// search would be Thermite's MCP server's. Each item's word is one token, so a search finds
// exactly it.
import { api, assign, command, until } from "./smoke-env.mjs";

const PI = "kbprobepi";
const OC = "kbprobeoc";
const DENIED = "kbprobedenied";
const CAMPAIGN_JSON = "The campaign, as JSON:";

/**
 * What the owner's search for a write naming another slot finds, which every check's agents title
 * `kbprobedenied …`. `held`: the items such a write made, whose title is the write's; there must be
 * none, as the harness refuses each such write. `quoted`: the other items holding the word, each
 * as its address, kind and slot; a kept conversation is one, a `doc` of the run's records whose
 * text quotes the refused call (the conversation before a compaction).
 */
export async function deniedItems() {
  const hits = (await api(`/v1/kb/search?q=${DENIED}`)).body.hits ?? [];
  const held = hits.filter((h) => String(h.title ?? "").includes(DENIED));
  const quoted = hits
    .filter((h) => !held.includes(h))
    .map((h) => `${h.address} (${h.kind} in ${h.slot})`);
  return { held, quoted };
}

/** A tool result's text: OpenCode sends it as a string or as text parts. */
const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
      : String(c ?? "");

/** A write into another writer's slot: the agent names a slot, which kb_write never takes. */
const denied = (name) => ({
  name,
  args: { kind: "note", title: `${DENIED} not my slot`, text: "x", slot: "planner" },
});

/**
 * What the knowledge base's tools answered in one conversation: the addresses kept, whether a
 * write naming a slot was refused, and smoke-1's agents' items any result names.
 */
function answered(messages) {
  const out = { kept: [], refused: false, hits: [] };
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const t = textOf(m.content);
    for (const k of t.matchAll(/kept: (\S+?), item \d+, version \d+/g)) out.kept.push(k[1]);
    if (/kb_write takes no slot: you write only in your own slot/.test(t)) out.refused = true;
    for (const a of t.matchAll(/smoke-cpu\/smoke-1\/worker-\d+\/[a-z]+:\d+/g))
      if (!out.hits.includes(a[0])) out.hits.push(a[0]);
  }
  return out;
}

/** What every conversation of one program's agent was told, together: a later trial adds to it. */
const together = (had, kb) => ({
  kept: [...new Set([...(had?.kept ?? []), ...kb.kept])],
  refused: Boolean(had?.refused || kb.refused),
  hits: [...new Set([...(had?.hits ?? []), ...kb.hits])],
});

/** The scene's part of the scripted model, and its checks. */
export function kbAgentsScene() {
  const seen = {
    pi: undefined,
    oc: undefined,
    found: undefined,
    second: false,
    ocTools: [],
    planner: undefined,
  };
  return {
    /** lane-1's worker's two calls in Pi, before it submits; `messages` its conversation so far. */
    piSteps(messages) {
      seen.pi = together(seen.pi, answered(messages));
      return [
        {
          name: "kb_write",
          args: {
            kind: "finding",
            title: `${PI}: the i-k-j loop order keeps the inner loop contiguous`,
            text: `${PI}: lane-1's worker in Pi wrote this in its own slot; the i-k-j order made the kernel faster.`,
          },
        },
        denied("kb_write"),
      ];
    },
    /**
     * An OpenCode trial's two calls of Thermite's MCP server's kb_write (`names`: its tools), or
     * none when OpenCode lists no such tool.
     */
    ocSteps(messages, names) {
      const write = names.find((n) => /kb_write$/.test(n));
      seen.ocTools = [...new Set([...seen.ocTools, ...names.filter((n) => /kb_/.test(n))])];
      if (!write) return [];
      seen.oc = together(seen.oc, answered(messages));
      const item = {
        kind: "surprise",
        title: `${OC}: the tidied kernel builds as it was`,
        text: `${OC}: OpenCode's trial wrote this in its own slot through Thermite's MCP server.`,
      };
      return [{ name: write, args: item }, denied(write)];
    },
    /**
     * The second run's planner, in the program it runs in (`program`): one search before it plans,
     * or undefined. In Pi the caller knows a planner's request by its submit_plan; in OpenCode it
     * is the request whose prompt gives the campaign as JSON.
     */
    plannerTurn(messages, names, program) {
      const planner = program === "pi" || JSON.stringify(messages).includes(CAMPAIGN_JSON);
      if (!seen.second || !planner) return undefined;
      const kb = answered(messages);
      if (kb.hits.length) seen.found = kb.hits;
      const search = names.find((n) => /kb_search$/.test(n));
      // What it was given and told, for the check's detail.
      const told = messages.find((m) => m.role === "tool");
      seen.planner = {
        program,
        asks: (seen.planner?.asks ?? 0) + 1,
        kb_tools: names.filter((n) => /kb_/.test(n)),
        answer: told ? textOf(told.content).slice(0, 400) : seen.planner?.answer,
      };
      if (!search || messages.some((m) => m.role === "tool")) return undefined;
      return { toolCalls: [{ name: search, args: { query: `${PI} ${OC}`, limit: 50 } }] };
    },
    /**
     * The checks, once smoke-1's trials in Pi and in OpenCode have ended: each item where control
     * holds it, none of the refused ones, then smoke-2's planner's search. `env` is prepare()'s.
     */
    async run(check, env) {
      const ownerFinds = async (word) =>
        (await api(`/v1/kb/search?q=${encodeURIComponent(word)}`)).body.hits ?? [];
      const stored = async (word, address) =>
        address
          ? await until(
              `control holds ${address}`,
              async () => (await ownerFinds(word)).find((h) => h.address === address),
              180_000,
              3000,
            ).catch(() => undefined)
          : undefined;
      const piKept = seen.pi?.kept.find((a) =>
        /^smoke-cpu\/smoke-1\/worker-1\/finding:\d+$/.test(a),
      );
      const piStored = await stored(PI, piKept);
      check(
        "Pi: lane-1's worker writes a finding into its own slot with kb_write, control holds it there, and its write naming another slot is refused",
        Boolean(piKept) && piStored?.slot === "worker-1" && seen.pi?.refused === true,
        { seen: seen.pi, stored: piStored },
      );
      const ocKept = seen.oc?.kept.find((a) =>
        /^smoke-cpu\/smoke-1\/worker-\d+\/surprise:\d+$/.test(a),
      );
      const ocStored = await stored(OC, ocKept);
      check(
        "OpenCode: its trial writes into its own slot with Thermite's MCP server's kb_write, control holds it there, and its write naming another slot is refused",
        Boolean(ocKept) &&
          ocStored?.slot === ocKept.split("/")[2] &&
          /^worker-\d+$/.test(String(ocStored?.slot)) &&
          seen.oc?.refused === true,
        { seen: seen.oc, kb_tools: seen.ocTools, stored: ocStored },
      );
      const refused = await deniedItems();
      check(
        "a write naming another writer's slot never reaches control",
        refused.held.length === 0,
        refused,
      );
      // An agent of another run: a second run of the campaign, whose planner searches for both
      // items before it plans. Assigning it pauses research-oc's run, already paused; smoke-2 is
      // paused once it found them.
      const kept = [piKept, ocKept].filter(Boolean);
      const name =
        "an agent of another run (smoke-2's planner) finds the items Pi's and OpenCode's agents wrote in smoke-1, with kb_search";
      if (!kept.length) return check(name, false, "neither agent kept an item to find");
      seen.second = true;
      await assign(env, "smoke-2");
      const found = await until(
        "smoke-2's planner finds smoke-1's items",
        async () => (kept.every((a) => seen.found?.includes(a)) ? seen.found : undefined),
        600_000,
        2000,
      ).catch(() => seen.found);
      await command("pause_run", { run: "smoke-2", reason: "acceptance: drain" }).catch(
        () => undefined,
      );
      check(name, kept.length === 2 && kept.every((a) => found?.includes(a)), {
        found,
        pi: piKept,
        oc: ocKept,
        planner: seen.planner,
      });
    },
  };
}
