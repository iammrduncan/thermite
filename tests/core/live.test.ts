import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIVE_TEXT_MAX, LiveLog, liveText } from "../../src/core/live.ts";

const TRIAL = `trial.${"0a1b".repeat(16)}`;
const PROXY = `proxy.${"c3d4".repeat(12)}`;
const MCP = `mcp.${"e5f6".repeat(12)}`;

describe("the live log keeps the rig's credentials out of its lines", () => {
  test("a trial's, the proxy's and the gateway's tokens are masked wherever they are", () => {
    assert.equal(
      liveText(`curl -H "Authorization: Bearer ${TRIAL}" http://harness/v1/mcp`),
      'curl -H "Authorization: Bearer trial.***" http://harness/v1/mcp',
    );
    assert.equal(liveText(`key ${PROXY}, then ${MCP}.`), "key proxy.***, then mcp.***.");
    // A planner's call's in its own terminal (goal 169).
    assert.equal(liveText(`Bearer call.${"9e8d".repeat(12)}`), "Bearer call.***");
  });

  test("THERMITE_*_AUTH settings are masked as env prints them and as JSON", () => {
    assert.equal(
      liveText(`THERMITE_TRIAL_AUTH=${TRIAL}\nTHERMITE_PROXY_AUTH=${PROXY}\nHOME=/home/lane-1`),
      "THERMITE_TRIAL_AUTH=***\nTHERMITE_PROXY_AUTH=***\nHOME=/home/lane-1",
    );
    assert.equal(
      liveText(`{"THERMITE_MCP_AUTH":"${MCP}","PATH":"/usr/bin"}`),
      '{"THERMITE_MCP_AUTH":"***","PATH":"/usr/bin"}',
    );
  });

  test("words that only look like them stay", () => {
    for (const t of ["wrote trial.json", "mcp.servers", "proxy.ts", "THERMITE_TRIAL_AUTH is set"])
      assert.equal(liveText(t), t);
  });

  test("a line is masked before it is cut, and the log keeps it masked", () => {
    const long = `${"x".repeat(LIVE_TEXT_MAX - 20)} ${TRIAL}`;
    assert.equal(liveText(long), `${"x".repeat(LIVE_TEXT_MAX - 20)} trial.***`);
    const longer = `${TRIAL} ${"x".repeat(LIVE_TEXT_MAX)}`;
    assert.match(liveText(longer), /^trial\.\*\*\* x+ \[cut\]$/);
    const log = new LiveLog();
    log.append({ source: "trial:t-1", kind: "result", text: `env: THERMITE_TRIAL_AUTH=${TRIAL}` });
    assert.equal(log.since(0).entries[0]?.text, "env: THERMITE_TRIAL_AUTH=***");
  });
});
