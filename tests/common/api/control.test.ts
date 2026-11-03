import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL_CALL_TIMEOUT_MS, controlClient } from "../../../src/common/api/control.ts";
import { buildInfo } from "../../../src/common/build-info.ts";
import { EXPORT_BEGIN } from "../../../src/core/api/control/rigs.ts";
import { BUILD_HEADERS } from "../../../src/core/version.ts";

/** A fake fetch that answers `{}`-shaped JSON and keeps each call's address and headers. */
function recording(answer: unknown) {
  const calls: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), signal: init?.signal });
    return Response.json(answer);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("control's client: a rig's routes as that rig, with this build's version and a time limit", async () => {
  assert.equal(CONTROL_CALL_TIMEOUT_MS, 5 * 60_000);
  const r = recording({ received: {}, done: [], complete: false });
  const control = controlClient({
    url: "http://control/",
    token: "rig-token",
    rig: "rig-a",
    fetchImpl: r.fetchImpl,
  });
  const name = "20261020T120000Z-0123abcd";
  const manifest = { from_event: 0, through_event: 1, files: {} };
  await control.call(EXPORT_BEGIN, { params: { name }, body: { manifest, files: {} } });
  const [call] = r.calls;
  assert.equal(call?.url, `http://control/v1/rigs/rig-a/exports/${name}`);
  assert.equal(call?.headers.get("authorization"), "Bearer rig-token");
  assert.equal(call?.headers.get(BUILD_HEADERS.version), buildInfo().version);
  assert.ok(call?.signal, "each call has its time limit");
});
