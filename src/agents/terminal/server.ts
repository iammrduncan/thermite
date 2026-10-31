import { createServer, type Server, type Socket } from "node:net";
import type { z } from "zod";
import { errorText } from "../../common/errors.ts";
import { logWarn } from "../../common/log.ts";
import { sameSecret } from "../../common/secrets.ts";
import type { TerminalHost } from "./host.ts";
import { REQUEST_MAX, TerminalRequest } from "./protocol.ts";

/**
 * The host's socket: one request for each connection, one JSON line each way. A request that is
 * too long, that is not one the protocol knows, or that does not carry the host's secret, is
 * refused, and nothing is done. The agent runs as the same user as the host, so it can reach the
 * socket; without the secret, which came on the host's stdin, it gets only refusals.
 */

type Host = Pick<
  TerminalHost,
  "status" | "type" | "sendKeys" | "interrupt" | "screenText" | "screenSnapshot" | "end"
>;

type Request = z.infer<typeof TerminalRequest>;

/** What the host does for a request that passed: its answer's fields. */
async function answer(host: Host, r: Request): Promise<object> {
  switch (r.op) {
    case "status":
      return host.status();
    case "type":
      await host.type(r.text, r.enter);
      return {};
    case "keys":
      await host.sendKeys(r.keys);
      return {};
    case "interrupt":
      await host.interrupt();
      return {};
    case "screen":
      return r.form === "snapshot" ? host.screenSnapshot(r.scrollback) : host.screenText();
    case "end":
      return host.end(r.steps);
  }
}

/** Serves `host` on the Unix socket at `path`, to requests that carry `secret`. */
export function serveTerminal(host: Host, path: string, secret: string): Server {
  const server = createServer((sock: Socket) => {
    let buf = "";
    let taken = false;
    const reply = (body: object) => {
      if (!sock.destroyed) sock.end(`${JSON.stringify(body)}\n`);
    };
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    sock.on("data", (chunk: string) => {
      if (taken) return;
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at < 0 && buf.length <= REQUEST_MAX) return;
      taken = true;
      if (at < 0 || at > REQUEST_MAX) {
        reply({ ok: false, error: `a request is one line of at most ${REQUEST_MAX} bytes` });
        return;
      }
      let req: Request;
      try {
        req = TerminalRequest.parse(JSON.parse(buf.slice(0, at)));
      } catch {
        reply({ ok: false, error: "not a request the terminal host knows" });
        return;
      }
      if (!sameSecret(req.secret, secret)) {
        logWarn("terminal", "a request without the host's secret was refused", { op: req.op });
        reply({ ok: false, error: "refused" });
        return;
      }
      void answer(host, req).then(
        (fields) => reply({ ok: true, ...fields }),
        (err) => reply({ ok: false, error: errorText(err).slice(0, 2000) }),
      );
    });
  });
  server.listen(path);
  return server;
}
