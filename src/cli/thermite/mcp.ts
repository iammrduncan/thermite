import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  MCP_SERVER_ADD,
  MCP_SERVER_CHANGE,
  MCP_SERVER_CHECK,
  MCP_SERVER_DELETE,
  MCP_SERVER_SIGN_IN,
  MCP_SERVERS,
  type McpServerLine,
} from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/** One line per server, then its last error and its tools, for `thermite mcp`. */
export function formatMcpServers(list: McpServerLine[]): string {
  if (!list.length) return "no MCP server in Settings\n";
  return list
    .map((s) => {
      const tools = s.tools ?? [];
      const head = `${s.name}  ${s.auth}${s.secret_hint ? ` ${s.secret_hint}` : ""}  ${s.status}  ${tools.length} tool${tools.length === 1 ? "" : "s"}  ${s.url}${s.named_by?.length ? `  named by ${s.named_by.join(", ")}` : ""}`;
      const err = s.last_error ? `\n  ${s.last_error}` : "";
      const t = tools.length
        ? `\n  ${tools.map((x) => `${x.name}${x.reads ? "" : " (writes)"}`).join(", ")}`
        : "";
      return `${head}${err}${t}\n`;
    })
    .join("");
}

/** thermite mcp: the MCP servers in Settings. */
export async function thermiteMcp(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      auth: { type: "string" },
      header: { type: "string" },
      "secret-file": { type: "string" },
      "client-id": { type: "string" },
      "client-secret-file": { type: "string" },
      scope: { type: "string" },
    },
  });
  if (!values.control || !values["token-file"]) fail(USAGE);
  const control = controlAt(values.control, values["token-file"]);
  const name = positionals[0];
  // Secrets come from files, never from the command line, where other users could see them.
  const fields = () => ({
    ...(values.url ? { url: values.url } : {}),
    ...(values.auth ? { auth: values.auth } : {}),
    ...(values.header ? { header: values.header } : {}),
    ...(values["secret-file"]
      ? { secret: readFileSync(values["secret-file"], "utf8").trim() }
      : {}),
    ...(values["client-id"] ? { client_id: values["client-id"] } : {}),
    ...(values["client-secret-file"]
      ? { client_secret: readFileSync(values["client-secret-file"], "utf8").trim() }
      : {}),
    ...(values.scope ? { scope: values.scope } : {}),
  });
  const said = (out: {
    server?: McpServerLine;
    sign_in_url?: string;
    check_error?: string;
    error?: string;
  }) => {
    if (out.server) process.stdout.write(formatMcpServers([out.server]));
    if (out.sign_in_url)
      process.stdout.write(
        `open this address within 15 minutes and allow Thermite:\n  ${out.sign_in_url}\n`,
      );
    if (out.check_error) process.stdout.write(`its tools were not read: ${out.check_error}\n`);
    if (out.error) process.stdout.write(`${out.error}\n`);
  };
  if (sub === "list") {
    const out = await orFail(control.call(MCP_SERVERS));
    process.stdout.write(
      values.json ? `${JSON.stringify(out, null, 2)}\n` : formatMcpServers(out.servers),
    );
    return;
  }
  if (!name) fail(USAGE);
  const params = { name };
  if (sub === "add") {
    if (!values.url || !values.auth) fail(USAGE);
    said(await orFail(control.call(MCP_SERVER_ADD, { body: { name, ...fields() } })));
    return;
  }
  if (sub === "change") {
    said(await orFail(control.call(MCP_SERVER_CHANGE, { params, body: fields() })));
    return;
  }
  if (sub === "check") {
    said(await orFail(control.call(MCP_SERVER_CHECK, { params, body: {} })));
    return;
  }
  if (sub === "sign-in") {
    const out = await orFail(control.call(MCP_SERVER_SIGN_IN, { params, body: {} }));
    said({ sign_in_url: out.url });
    return;
  }
  if (sub === "delete") {
    await orFail(control.call(MCP_SERVER_DELETE, { params }));
    process.stdout.write(`${name} is deleted: control keeps nothing of its secrets\n`);
    return;
  }
  fail(USAGE);
}
