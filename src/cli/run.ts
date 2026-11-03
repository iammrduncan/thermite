/**
 * `thermite run start`: a new run of a campaign control keeps, as a campaign page's Start a run
 * does, through control's REST API (POST /v1/campaigns/<name>/runs) with the owner's token. These
 * turn the command's options into the route's body, and its answer into lines.
 */

export interface RunStartOptions {
  rig?: string | undefined;
  agents?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  promotion?: string | undefined;
  ask?: string[] | undefined;
  "judge-gpus"?: string | undefined;
  "queue-from"?: string | undefined;
  past?: string[] | undefined;
  fresh?: boolean | undefined;
  granted?: string[] | undefined;
  "no-granted"?: boolean | undefined;
}

const whole = (flag: string, text: string): number => {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n))
    throw new Error(`${flag} takes a whole number, not "${text}"`);
  return n;
};

/**
 * `--ask`, given once for each (goal 079): what else the run asks the owner about. `gain:PERCENT`
 * a confirmed gain above it, `flaws` a win with declared flaws, `reviews` a review panel's pass,
 * `not-possible` a "not possible" ending. Throws, in words, on another value.
 */
export function askOwnerOption(
  values: string[] | undefined,
): Record<string, number | boolean> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, number | boolean> = {};
  for (const v of values) {
    const gain = /^gain:(\d+(?:\.\d+)?)%?$/.exec(v);
    if (gain && Number(gain[1]) > 0) out.above_gain = Number(gain[1]) / 100;
    else if (v === "flaws") out.declared_flaws = true;
    else if (v === "reviews") out.reviews = true;
    else if (v === "not-possible") out.not_possible = true;
    else throw new Error("--ask is gain:PERCENT, flaws, reviews or not-possible");
  }
  return out;
}

/** The body of POST /v1/campaigns/<name>/runs. Throws, in words, on an option it can't take. */
export function runStartBody(o: RunStartOptions): Record<string, unknown> {
  if (!o.rig) throw new Error("--rig names the rig the run starts on");
  if (o.agents !== undefined && o.agents !== "on" && o.agents !== "off")
    throw new Error("--agents is on or off");
  if (o.promotion !== undefined && o.promotion !== "auto" && o.promotion !== "owner")
    throw new Error("--promotion is auto or owner");
  if (Boolean(o.provider) !== Boolean(o.model))
    throw new Error(
      "--provider and --model go together: the agents' model is one of a provider's models",
    );
  const ask = askOwnerOption(o.ask);
  // A run by its name alone, wherever it ran (goal 170), as for thermite assign --queue-from.
  const queueFrom = o["queue-from"];
  if (queueFrom === "") throw new Error("--queue-from names a run");
  if (o["no-granted"] && o.granted?.length)
    throw new Error("--no-granted searches no granted collection: leave out --granted");
  return {
    rig: o.rig,
    ...(o.agents === "off" ? { agents: false } : {}),
    ...(o.provider && o.model ? { agents_model: { provider: o.provider, model: o.model } } : {}),
    ...(o.promotion ? { promotion: o.promotion === "owner" ? "owner_approval" : "auto" } : {}),
    ...(ask ? { ask_owner: ask } : {}),
    ...(o["judge-gpus"] !== undefined
      ? { judge_gpus: whole("--judge-gpus", o["judge-gpus"]) }
      : {}),
    ...(queueFrom ? { queue_from: queueFrom } : {}),
    ...(o.past?.length ? { past: o.past.map((x) => whole("--past", x)) } : {}),
    ...(o.fresh ? { collection: "fresh" } : {}),
    ...(o["no-granted"] ? { granted: [] } : o.granted?.length ? { granted: o.granted } : {}),
  };
}

/** What to say on standard error about the answer: a model given first, or the run's notes. */
export function runStartSaid(out: {
  started?: boolean;
  said?: string;
  woke?: string;
  notes?: string[];
}): string {
  const lines = out.started === false ? [out.said ?? ""] : [out.woke ?? "", ...(out.notes ?? [])];
  const said = lines.filter(Boolean);
  return said.length ? `${said.join("\n")}\n` : "";
}
