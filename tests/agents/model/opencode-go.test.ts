import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { forwardToProvider } from "../../../src/agents/model/forward.ts";

test("the model proxy forwards OpenCode's session without forwarding its caller's credential", async () => {
  const received: { session?: string; authorization?: string; cookie?: string } = {};
  const server = createServer((req, res) => {
    received.session = req.headers["x-opencode-session"] as string | undefined;
    received.authorization = req.headers.authorization;
    received.cookie = req.headers.cookie;
    req.resume();
    req.on("end", () => res.writeHead(200).end("ok"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const headers: Record<string, string> = {
      "x-opencode-session": "conversation-1",
      authorization: "Bearer trial-token",
      cookie: "private=1",
    };
    const answer = await forwardToProvider(
      {
        method: "POST",
        rest: "chat/completions",
        search: "",
        header: (name) => headers[name],
        body: Buffer.from("{}"),
      },
      {
        api: undefined,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        key: "provider-key",
      },
      undefined,
      { ms: undefined },
    );
    await answer.text();
    assert.equal(received.session, "conversation-1");
    assert.equal(received.authorization, "Bearer provider-key");
    assert.equal(received.cookie, undefined);
  } finally {
    server.close();
  }
});
