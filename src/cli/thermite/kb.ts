import { parseArgs } from "node:util";
import { KB_ITEM, KB_LIST, KB_SEARCH } from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite kb: the owner's search of Thermite's knowledge base, one item read (goal 175), and one
 * place's list (goal 176), through control's `GET /v1/kb/search`, `GET /v1/kb/item` and `GET
 * /v1/kb/list`, as MCP's kb_search, kb_read and kb_list, with the same options. It prints
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
      control: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  if (sub !== "search" && sub !== "read" && sub !== "list") fail(USAGE);
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control keeps the knowledge base");
  const control = controlAt(values.control, values["token-file"]);
  const listOnly = [values.type, values.sort, values.order];
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
    fail(`kb ${sub} takes no --type, --sort or --order: kb list does`);
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
  const filters = [values.kind, values.outcome, values.run, values.slot, values.limit];
  if ([...searchOnly, ...filters].some((v) => v !== undefined))
    fail("kb read takes only an address, --version and --offset: kb search takes the others");
  const out = await orFail(
    control.call(KB_ITEM, {
      query: { address, version: values.version, offset: values.offset },
    }),
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
