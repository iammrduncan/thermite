import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_CALL_TIMEOUT_MS, harnessClient } from "../../../src/common/api/harness.ts";
import { SETTINGS } from "../../../src/core/api/harness/supervisor.ts";
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

test("the harness's client: the supervisor's token, and no build headers", async () => {
  assert.equal(HARNESS_CALL_TIMEOUT_MS, 5 * 60_000);
  const r = recording({ teachers: true, auditor: false, review: true });
  const harness = harnessClient({ url: "http://harness", token: "sup", fetchImpl: r.fetchImpl });
  assert.deepEqual(await harness.call(SETTINGS), { teachers: true, auditor: false, review: true });
  const [call] = r.calls;
  assert.equal(call?.url, "http://harness/v1/settings");
  assert.equal(call?.headers.get("authorization"), "Bearer sup");
  assert.equal(call?.headers.get(BUILD_HEADERS.version), null);
});
