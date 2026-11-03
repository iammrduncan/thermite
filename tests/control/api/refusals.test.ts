import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerOf, BadInput, Refusal } from "../../../src/common/errors.ts";
import { FORM_MAX_BYTES } from "../../../src/control/dashboard/session.ts";
import { MCP_BODY_MAX } from "../../../src/control/mcp/index.ts";
import {
  CLOUD_LAUNCH,
  ENROLL,
  ISSUE,
  PROPAGATE,
  RESET,
  RESTART,
  RUNPOD_LIMITS,
  RUNPOD_TERMINATE,
} from "../../../src/core/api/control/owner.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

function control() {
  const { store, control: api } = controlOnly({
    tokens: { rigs: { "rig-a": "rig-token-aaaaaa", "rig-b": "rig-token-bbbbbb" } },
  });
  // The body as given, not as JSON: some tests send one that isn't.
  const post = async (path: string, body: string) => {
    const r = await api.request(path, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
    return { status: r.status, error: ((await r.json()) as { error?: string }).error };
  };
  return { store, post };
}

describe("refusals over REST are answered as refusals, never as server errors (goal 161)", () => {
  test("a body that is not JSON is a 400 with its words", async () => {
    const { post } = control();
    assert.deepEqual(await post("/v1/propagate", "{not json"), {
      status: 400,
      error: "the request's body is not JSON",
    });
    assert.deepEqual(await post("/v1/rigs/rig-a/reset", "{"), {
      status: 400,
      error: "the request's body is not JSON",
    });
  });

  test("a body that doesn't fit its schema is a 400", async () => {
    const { post } = control();
    assert.deepEqual(await post("/v1/propagate", JSON.stringify({ run: "r-1" })), {
      status: 400,
      error: "invalid request",
    });
  });

  test("propagate's refusals are 409s with their words", async () => {
    const { store, post } = control();
    const body = { run: "r-1", to_run: "r-2" };
    assert.deepEqual(await post("/v1/propagate", JSON.stringify(body)), {
      status: 409,
      error: "no run r-1",
    });
    // Two runs of one rig: control knows where each ran (goal 170).
    const created = (run: string, at: string) => ({
      id: Number(run.slice(2)),
      at,
      actor: "harness",
      kind: "run_created",
      subject: run,
      body: { campaign: "c", mode: "hill_climb", seed: { repo: "p", commit: "s" } },
    });
    const at = new Date().toISOString();
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "l-a",
      cursor: 0,
      next: 2,
      summary: {},
      events: [created("r-1", at), created("r-2", at)],
    });
    assert.deepEqual(await post("/v1/propagate", JSON.stringify(body)), {
      status: 409,
      error: "r-1 and r-2 are on one rig: propagate between two rigs",
    });
  });

  test("a reset's confirm and cancel of no such reset, and a second reset, are 409s", async () => {
    const { store, post } = control();
    assert.deepEqual(await post("/v1/resets/99/confirm", "{}"), {
      status: 409,
      error: "no reset 99",
    });
    assert.deepEqual(await post("/v1/resets/99/cancel", "{}"), {
      status: 409,
      error: "no reset 99",
    });
    store.fullResets.create("rig-a", "owner:api");
    assert.deepEqual(
      await post("/v1/rigs/rig-a/reset", JSON.stringify({ confirm: "reset rig-a" })),
      {
        status: 409,
        error: "a reset of rig-a is already in progress",
      },
    );
  });

  test("each error has one answer; anything else is a fault, a 500 in words that say nothing of it", () => {
    assert.deepEqual(answerOf(new Refusal("no")), { status: 409, error: "no" });
    assert.deepEqual(answerOf(new BadInput("bad")), { status: 400, error: "bad" });
    assert.deepEqual(answerOf(new Error("broke")), { status: 500, error: "internal error" });
  });

  test("a fault answers an id only; control's output and audit log keep its words under it", async () => {
    const { store, control: api } = controlOnly();
    store.commands.list = () => {
      throw new Error("SQLITE_IOERR: disk I/O error at /var/lib/thermite-control/control.db");
    };
    const r = await api.request("/v1/commands", { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(r.status, 500);
    const { error } = (await r.json()) as { error: string };
    const id = /^internal error ([0-9a-f]{8})$/.exec(error)?.[1];
    assert.ok(id, error);
    const entry = store.auditLog.list(5, { action: "failed" })[0];
    assert.equal(entry?.actor, "owner:api");
    assert.deepEqual(entry?.body, {
      method: "GET",
      path: "/v1/commands",
      status: 500,
      error: "SQLITE_IOERR: disk I/O error at /var/lib/thermite-control/control.db",
      id,
    });
  });

  test("an MCP tool's error reaches its caller with any secret in it masked", async () => {
    const { store, control: api } = controlOnly();
    store.commands.get = () => {
      throw new Error("the provider said 401 to Authorization: Bearer made-up-0123456789abcdef");
    };
    const mcp = await mcpClient(api);
    const r = (await mcp.callTool({ name: "command_status", arguments: { id: "c-1" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(r.isError, true);
    const text = r.content[0]?.text ?? "";
    assert.ok(!text.includes("0123456789abcdef"), text);
    assert.match(text, /said 401 to Authorization: \*\*\*/);
  });
  test("every route that reads a body refuses one past its limit, 413, before it reads it", async () => {
    const { control: api } = controlOnly({
      tokens: { rigs: { "rig-a": "rig-token-aaaaaa" } },
    });
    const owner = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    const over = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes) });
    const routes: [string, number][] = [
      [ISSUE.path, ISSUE.maxBytes],
      [ENROLL.path, ENROLL.maxBytes],
      ["/v1/rigs/rig-a/restart", RESTART.maxBytes],
      ["/v1/rigs/rig-a/reset", RESET.maxBytes],
      [PROPAGATE.path, PROPAGATE.maxBytes],
      ["/v1/gpu-clouds/runpod/tests", 4 * 1024],
      ["/v1/gpu-clouds/runpod/rigs", CLOUD_LAUNCH.maxBytes],
      ["/v1/rigs/rig-a/runpod/terminate", RUNPOD_TERMINATE.maxBytes],
      ["/v1/rigs/rig-a/runpod/limits", RUNPOD_LIMITS.maxBytes],
    ];
    for (const [path, max] of routes) {
      const r = await api.request(path, { method: "POST", headers: owner, body: over(max) });
      assert.equal(r.status, 413, path);
    }
    // The dashboard's forms, past theirs; MCP's requests, past its.
    const ui = await signIn(api);
    const csrf = ui.csrfOf(await ui.page("/ui"));
    const form = await ui.post("/ui/settings/rigs", { csrf, pad: "x".repeat(FORM_MAX_BYTES) });
    assert.equal(form.status, 413);
    const mcp = await api.request("/mcp", {
      method: "POST",
      headers: { ...owner, accept: "application/json, text/event-stream" },
      body: over(MCP_BODY_MAX),
    });
    assert.equal(mcp.status, 413);
  });
});
