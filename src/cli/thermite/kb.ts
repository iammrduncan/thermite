import { parseArgs } from "node:util";
import { KB_ITEM, KB_SEARCH } from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite kb: the owner's search of Thermite's knowledge base, and one item read (goal 175),
 * through control's `GET /v1/kb/search` and `GET /v1/kb/item`, as MCP's kb_search and kb_read,
 * with the same options. It prints control's answer as JSON on standard output.
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
      control: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  if (sub !== "search" && sub !== "read") fail(USAGE);
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control keeps the knowledge base");
  const control = controlAt(values.control, values["token-file"]);
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
