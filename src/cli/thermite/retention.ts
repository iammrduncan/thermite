import { parseArgs } from "node:util";
import {
  RETENTION_CREATE,
  RETENTION_DELETE,
  RETENTION_LIST,
  RETENTION_ON,
  RETENTION_POLICY,
  RETENTION_PREVIEW,
  RETENTION_REMOVALS,
  RETENTION_RUN,
  RETENTION_UPDATE,
} from "../../core/api/control/retention.ts";
import type { RetentionSpecInput } from "../../core/retention/index.ts";
import { sizeWords } from "../../core/words.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite retention: the owner's retention policies on control (core/retention/), with the
 * owner's token, as Settings › Retention policies has them: list, show, create, update, delete,
 * on, off, preview, run and removals. A design is given by options; update changes only the
 * options given, from the policy as control has it.
 */

/** The design options, as `thermite retention create` and its kin take them. */
const DESIGN_OPTIONS = {
  name: { type: "string" },
  kind: { type: "string" },
  where: { type: "string" },
  rig: { type: "string", multiple: true },
  campaign: { type: "string", multiple: true },
  rule: { type: "string" },
  older: { type: "string" },
  unit: { type: "string" },
  newest: { type: "string" },
  per: { type: "string" },
  size: { type: "string" },
  keep: { type: "string", multiple: true },
  "no-keep": { type: "string", multiple: true },
  when: { type: "string" },
  time: { type: "string" },
  day: { type: "string" },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

/** A number option as a number; the option's words when it is not one. */
const numberOf = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} takes a number, not ${String(v)}`);
  return n;
};

/** The options given, laid over a design (a policy's, for update; none for create). */
function designFrom(values: Values, base: Partial<RetentionSpecInput> = {}) {
  const d: Record<string, unknown> = { ...base };
  const set = (key: string, v: unknown) => {
    if (v !== undefined) d[key] = v;
  };
  set("name", values.name);
  set("kind", values.kind);
  set("rigs", values.rig);
  set("campaigns", values.campaign);
  set("where", values.where ?? (values.rig ? "rigs" : values.campaign ? "campaigns" : undefined));
  set("rule", values.rule);
  set("older_n", numberOf(values.older, "older"));
  set("older_unit", values.unit);
  set("newest_n", numberOf(values.newest, "newest"));
  set("newest_per", values.per);
  set("size_gib", numberOf(values.size, "size"));
  set("when", values.when);
  set("time", values.time);
  set("day", values.day);
  const keep = { open: true, champions: true, newest: true, ...(base.keep ?? {}) };
  for (const k of (values.keep as string[] | undefined) ?? []) keep[k as keyof typeof keep] = true;
  for (const k of (values["no-keep"] as string[] | undefined) ?? [])
    keep[k as keyof typeof keep] = false;
  d.keep = keep;
  return d;
}

/** A policy as one line: its id, switch, name, kind, where, rule and time. */
const line = (p: {
  id: number;
  on: boolean;
  name: string;
  kind: string;
  where_words: string;
  rule_words: string;
  when_words: string;
  would_remove: { count: number; bytes: number };
}) =>
  `${p.id}  ${p.on ? "on " : "off"}  ${p.name}  ${p.kind}  ${p.where_words}: removes ${p.rule_words}, ${p.on ? p.when_words : "off"}  (would remove now: ${p.would_remove.count ? sizeWords(p.would_remove.bytes) : "nothing"})\n`;

export async function thermiteRetention(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean" },
      on: { type: "boolean" },
      policy: { type: "string" },
      limit: { type: "string" },
      ...DESIGN_OPTIONS,
    },
  });
  if (!sub || !values.control || !values["token-file"]) fail(USAGE);
  const control = controlAt(values.control, values["token-file"]);
  const out = (v: unknown, text: string) =>
    process.stdout.write(values.json ? `${JSON.stringify(v, null, 2)}\n` : text);
  const id = positionals[0];
  if (sub === "list") {
    const r = await orFail(control.call(RETENTION_LIST));
    out(
      r,
      r.policies.length
        ? r.policies.map(line).join("")
        : "no retention policy: Thermite keeps everything, everywhere\n",
    );
    return;
  }
  if (sub === "removals") {
    const query = { policy: values.policy, limit: values.limit };
    const r = await orFail(control.call(RETENTION_REMOVALS, { query }));
    out(
      r,
      r.removals.length
        ? r.removals
            .map(
              (x) =>
                `${x.at}  ${x.name}  ${x.rig ?? "control"}  ${x.count} removed, ${sizeWords(x.bytes)}  by ${x.by}${x.error ? `  (${x.error})` : ""}\n`,
            )
            .join("")
        : "nothing removed yet\n",
    );
    return;
  }
  if (sub === "create" || sub === "preview") {
    const design = designFrom(values);
    if (sub === "preview") {
      const r = await orFail(
        control.call(RETENTION_PREVIEW, { body: design as RetentionSpecInput }),
      );
      out(
        r,
        `${r.words} ${r.stays}${r.unreported.length ? ` Not said yet: ${r.unreported.join(", ")}.` : ""}\n`,
      );
      return;
    }
    const r = await orFail(
      control.call(RETENTION_CREATE, {
        body: { ...(design as RetentionSpecInput), on: values.on === true },
      }),
    );
    out(r, `${r.said}\n${line(r.policy)}`);
    return;
  }
  if (!id) fail(USAGE);
  const params = { id };
  if (sub === "show") {
    const p = await orFail(control.call(RETENTION_POLICY, { params }));
    process.stdout.write(`${JSON.stringify(p, null, 2)}\n`);
    return;
  }
  if (sub === "update") {
    const was = await orFail(control.call(RETENTION_POLICY, { params }));
    const design = designFrom(values, was as Partial<RetentionSpecInput>);
    const body = {
      ...(design as RetentionSpecInput),
      ...(values.on === undefined ? {} : { on: values.on }),
    };
    // What control adds to a policy is not part of its design.
    for (const k of Object.keys(body))
      if (!(k in DESIGN_KEYS)) delete (body as Record<string, unknown>)[k];
    const r = await orFail(control.call(RETENTION_UPDATE, { params, body }));
    out(r, `${r.said}\n${line(r.policy)}`);
    return;
  }
  if (sub === "on" || sub === "off") {
    const r = await orFail(control.call(RETENTION_ON, { params, body: { on: sub === "on" } }));
    out(r, `${r.said}\n`);
    return;
  }
  if (sub === "delete") {
    const r = await orFail(control.call(RETENTION_DELETE, { params }));
    out(r, `${r.said}\n`);
    return;
  }
  if (sub === "run") {
    const r = await orFail(control.call(RETENTION_RUN, { params }));
    out(r, `${r.said}\n`);
    return;
  }
  fail(USAGE);
}

/** A policy's design's keys, and `on`: what update sends. */
const DESIGN_KEYS = Object.fromEntries(
  [
    "name",
    "kind",
    "where",
    "rigs",
    "campaigns",
    "rule",
    "older_n",
    "older_unit",
    "newest_n",
    "newest_per",
    "size_gib",
    "keep",
    "when",
    "time",
    "day",
    "on",
  ].map((k) => [k, true]),
);
