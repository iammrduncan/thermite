import { parseArgs } from "node:util";
import { AGENT_ROLE, AGENT_ROLES, RUN_PROMPT, RUN_PROMPTS } from "../../core/api/control/agents.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite agents list and show (goal 166): the agents' roles, one role's definition, and the
 * prompts a run's agents were sent, with each section's source, as control has them.
 */
export async function thermiteAgents(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      run: { type: "string" },
      prompt: { type: "string" },
      sections: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control shows the agents");
  const control = controlAt(values.control, values["token-file"]);
  const out = (v: unknown): void => {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  };
  if (sub === "list" && !positionals.length) {
    const r = await orFail(control.call(AGENT_ROLES));
    if (values.json) return out(r);
    for (const x of r.roles as { id: string; name: string; what: string }[])
      process.stdout.write(`${x.id.padEnd(20)} ${x.name}: ${x.what}\n`);
    return;
  }
  const [role] = positionals;
  if (sub !== "show" || !role || positionals.length > 1) fail(USAGE);
  if (!values.run) {
    const r = await orFail(control.call(AGENT_ROLE, { params: { role } }));
    if (values.json) return out(r);
    const d = r as unknown as {
      name: string;
      what: string;
      model: string;
      programs: string[];
      render: string;
      texts: { id: string; what: string; text: string }[];
    };
    process.stdout.write(
      `${d.name}: ${d.what}\nmodel: ${d.model}; programs: ${d.programs.join(", ")}; put together by ${d.render}\n`,
    );
    for (const t of d.texts) process.stdout.write(`\n# ${t.id}: ${t.what}\n${t.text}\n`);
    return;
  }
  // A run's prompts of this role: the newest, or the one --prompt names.
  const list = await orFail(control.call(RUN_PROMPTS, { params: { run: values.run } }));
  const mine = (list.prompts as { id: number; role: string }[]).filter((p) => p.role === role);
  const id = values.prompt ? Number(values.prompt) : mine.at(-1)?.id;
  if (id === undefined) fail(`${values.run} has sent no ${role} a prompt yet`);
  const p = (await orFail(
    control.call(RUN_PROMPT, { params: { run: values.run, id } }),
  )) as unknown as PromptShown;
  if (values.json) return out(p);
  process.stdout.write(
    `prompt ${p.id} of ${values.run} on ${p.rig}: ${p.role} in ${p.program}${p.lane ? `, ${p.lane}` : ""}${p.trial ? `, trial ${p.trial}` : ""}${p.call ? `, ${p.call}` : ""}; version ${p.version}; ${p.chars} characters\n`,
  );
  for (const s of p.sections) {
    const head = `${s.part} · ${s.id} · from ${s.source}${s.from_definition ? " (the role's definition)" : ""} · ${s.chars} characters${s.cut ? ", cut: the whole is on the rig and in the run's export" : ""}`;
    process.stdout.write(
      values.sections ? `${head}\n` : `\n# ${head}\n${s.text ?? "(not on control)"}\n`,
    );
  }
}

interface PromptShown {
  id: number;
  rig: string;
  role: string;
  program: string;
  lane: string | null;
  trial: string | null;
  call: string | null;
  version: string;
  chars: number;
  sections: {
    id: string;
    source: string;
    part: string;
    chars: number;
    text: string | null;
    cut: boolean;
    from_definition: boolean;
  }[];
}
