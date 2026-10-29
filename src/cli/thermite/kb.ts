import { parseArgs } from "node:util";
import { KB_ITEM, KB_SEARCH } from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite kb: the owner's search of Thermite's knowledge base, and one item read whole (goal
 * 175), through control's `GET /v1/kb/search` and `GET /v1/kb/item`, as MCP's kb_search and
 * kb_read. It prints control's answer as JSON on standard output.
 */
export async function thermiteKb(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      collection: { type: "string", multiple: true },
      kind: { type: "string", multiple: true },
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
          collection: values.collection?.join(","),
          kind: values.kind?.join(","),
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
  if (values.collection || values.kind || values.limit !== undefined)
    fail("kb read takes only an address and --version: kb search takes the others");
  const out = await orFail(control.call(KB_ITEM, { query: { address, version: values.version } }));
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
