import { parseArgs } from "node:util";
import {
  CAMPAIGN_KB_GRANT,
  CAMPAIGN_KB_REVOKE,
  KB_ITEM,
  KB_LIST,
  KB_NOTE,
  KB_SEARCH,
  KB_SETTINGS,
  KB_STORED,
  SET_KB_SETTINGS,
} from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite kb: the owner's search of Thermite's knowledge base, one item read (goal 175), one
 * place's list, and a grant given or ended (goal 176), through control's `GET /v1/kb/search`, `GET
 * /v1/kb/item`, `GET /v1/kb/list` and `POST` or `DELETE /v1/campaigns/<campaign>/kb-grants`, as
 * MCP's kb_search, kb_read, kb_list, kb_grant and kb_revoke, with the same options; and the
 * knowledge base's settings on control, read or set (`GET` or `PUT /v1/kb/settings`). It prints
 * control's answer as JSON on standard output.
 */
export async function thermiteKb(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      query: { type: "string", multiple: true },
      mode: { type: "string" },
      like: { type: "string" },
      seen: { type: "string", multiple: true },
      collection: { type: "string", multiple: true },
      kind: { type: "string", multiple: true },
      outcome: { type: "string", multiple: true },
      run: { type: "string", multiple: true },
      slot: { type: "string", multiple: true },
      offset: { type: "string" },
      limit: { type: "string" },
      version: { type: "string" },
      type: { type: "string", multiple: true },
      sort: { type: "string" },
      order: { type: "string" },
      as: { type: "string" },
      title: { type: "string" },
      "max-file-mib": { type: "string" },
      "orphan-hours": { type: "string" },
      control: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  const grants = sub === "grant" || sub === "revoke";
  const subs = ["search", "read", "list", "stored", "note", "settings"];
  if (!subs.includes(sub ?? "") && !grants) fail(USAGE);
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control keeps the knowledge base");
  const control = controlAt(values.control, values["token-file"]);
  if (grants) {
    const [campaign, reads, ...extra] = positionals;
    const given = Object.entries(values).filter(
      ([k, v]) => v !== undefined && k !== "control" && k !== "token-file",
    );
    if (!campaign || !reads || extra.length || given.length)
      fail(`kb ${sub} takes a campaign and the other campaign whose collection it reads`);
    const out = await orFail(
      sub === "grant"
        ? control.call(CAMPAIGN_KB_GRANT, { params: { campaign }, body: { reads } })
        : control.call(CAMPAIGN_KB_REVOKE, { params: { campaign, reads } }),
    );
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  const settings = { max: values["max-file-mib"], hours: values["orphan-hours"] };
  if (sub === "settings") {
    const given = Object.entries(values).filter(
      ([k, v]) =>
        v !== undefined && !["control", "token-file", "max-file-mib", "orphan-hours"].includes(k),
    );
    if (positionals.length || given.length)
      fail("kb settings takes only --max-file-mib and --orphan-hours");
    if (settings.max === undefined && settings.hours === undefined) {
      process.stdout.write(`${JSON.stringify(await orFail(control.call(KB_SETTINGS, {})))}\n`);
      return;
    }
    const body = {
      // Empty or 0: no limit.
      ...(settings.max !== undefined
        ? { max_file_mib: settingNumber(settings.max, "--max-file-mib") }
        : {}),
      // default: back to THERMITE_CONTROL_KB_ORPHAN_HOURS.
      ...(settings.hours !== undefined
        ? {
            orphan_hours:
              settings.hours === "default" ? null : settingNumber(settings.hours, "--orphan-hours"),
          }
        : {}),
    };
    const out = await orFail(control.call(SET_KB_SETTINGS, { body }));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (settings.max !== undefined || settings.hours !== undefined)
    fail(`kb ${sub} takes no --max-file-mib or --orphan-hours: kb settings does`);
  if (sub !== "note" && values.title !== undefined)
    fail(`kb ${sub} takes no --title: kb note does`);
  if (sub === "note") {
    const [address, ...words] = positionals;
    const given = Object.entries(values).filter(
      ([k, v]) => v !== undefined && !["control", "token-file", "title"].includes(k),
    );
    if (!address || !words.length || given.length)
      fail("kb note takes an item's address, the note's words, and --title");
    const body = {
      address,
      text: words.join(" "),
      ...(values.title ? { title: values.title } : {}),
    };
    const out = await orFail(control.call(KB_NOTE, { body }));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (sub === "stored") {
    const given = Object.entries(values).filter(
      ([k, v]) => v !== undefined && !["control", "token-file", "offset"].includes(k),
    );
    if (positionals.length || given.length) fail("kb stored takes only --offset");
    const out = await orFail(control.call(KB_STORED, { query: { offset: values.offset } }));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  const listOnly = [values.sort, values.order];
  if (sub === "list") {
    const [at, ...extra] = positionals;
    if (extra.length)
      fail("kb list takes one place: <campaign>, <campaign>/<run> or <campaign>/<run>/<slot>");
    const searchOnly = [
      values.query,
      values.mode,
      values.like,
      values.seen,
      values.collection,
      values.run,
      values.as,
    ];
    if ([...searchOnly, values.version].some((v) => v !== undefined))
      fail(
        "kb list takes a place, --kind, --outcome, --type, --slot, --sort, --order, --offset and --limit",
      );
    const out = await orFail(
      control.call(KB_LIST, {
        query: {
          at: at ?? "",
          kind: values.kind?.join(","),
          outcome: values.outcome?.join(","),
          type: values.type?.join(","),
          slot: values.slot?.join(","),
          sort: values.sort,
          order: values.order,
          offset: values.offset,
          limit: values.limit,
        },
      }),
    );
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (listOnly.some((v) => v !== undefined))
    fail(`kb ${sub} takes no --sort or --order: kb list does`);
  if (sub === "search") {
    if (values.version !== undefined) fail("kb search takes no --version: kb read does");
    const out = await orFail(
      control.call(KB_SEARCH, {
        query: {
          q: positionals.join(" "),
          query: values.query,
          mode: values.mode,
          like: values.like,
          seen: values.seen,
          collection: values.collection?.join(","),
          kind: values.kind?.join(","),
          outcome: values.outcome?.join(","),
          run: values.run?.join(","),
          slot: values.slot?.join(","),
          type: values.type?.join(","),
          as: values.as,
          offset: values.offset,
          limit: values.limit,
        },
      }),
    );
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  const [address, ...more] = positionals;
  if (!address || more.length)
    fail("kb read takes one item's address: <campaign>/<run>/<slot>/<kind>:<id>");
  const searchOnly = [values.query, values.mode, values.like, values.seen, values.collection];
  const filters = [
    values.kind,
    values.outcome,
    values.run,
    values.slot,
    values.limit,
    values.type,
    values.as,
  ];
  if ([...searchOnly, ...filters].some((v) => v !== undefined))
    fail("kb read takes only an address, --version and --offset: kb search takes the others");
  const out = await orFail(
    control.call(KB_ITEM, {
      query: { address, version: values.version, offset: values.offset },
    }),
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** A setting's number as the command line gives it: empty is 0; anything else must be a number of 0 or more. */
function settingNumber(raw: string, option: string): number {
  const n = raw.trim() === "" ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${option} takes a number, 0 or more, not "${raw}"`);
  return n;
}
