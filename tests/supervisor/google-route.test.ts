import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advisorsOf } from "../../src/supervisor/advisors/routes.ts";
import { handModelRoute } from "../../src/supervisor/model-route.ts";
import { harnessControl } from "../../src/supervisor/settings.ts";

const HARNESS_CONTROL_SETTING = "THERMITE_HARNESS_CONTROL_URL";

// The public address control writes into its routes, which this rig can't reach, and the rig's own.
const PUBLIC = "https://control.example.com";
const RIG_CONTROL = "http://control:8800";
const BRIDGE = "/v1/google-gemini/gem";

const googleRoute = (o: Record<string, unknown> = {}) => ({
  name: "gem",
  type: "google-gemini-api",
  harness: "pi",
  version: 1,
  base_url: `${PUBLIC}${BRIDGE}`,
  model: "gemini-flash-test",
  context_window: 1_000_000,
  max_tokens: 0,
  reasoning: null,
  key_hint: "",
  revision: "aaaaaaaa",
  api_key: "bridge-capability",
  ...o,
});
const openaiRoute = {
  name: "other",
  type: "openai",
  harness: "pi",
  version: 3,
  base_url: "https://api.example.com/v1",
  model: "m",
  context_window: 0,
  max_tokens: 0,
  reasoning: null,
  key_hint: "",
  revision: "cccccccc",
  api_key: "k",
};

/** A fake harness, which records what it is handed. */
function harness(harnessControl?: string) {
  const handed: {
    route: Record<string, unknown> | null;
    planner: Record<string, unknown> | null;
  }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === "PUT") {
      handed.push(JSON.parse(String(init.body)));
      return Response.json({});
    }
    return Response.json({ source: "environment" });
  };
  return {
    cfg: { harnessUrl: "http://harness", harnessToken: "h", fetchImpl, harnessControl },
    handed,
  };
}

describe("a rig reaches control's Gemini API bridge where it already reaches control", () => {
  test("the workers' and the planner's Gemini API routes go to the harness on its own address for control", async () => {
    const h = harness(RIG_CONTROL);
    await handModelRoute(h.cfg, {
      route: googleRoute(),
      planner: googleRoute({ revision: "bbbbbbbb" }),
    });
    assert.equal(h.handed[0]?.route?.base_url, `${RIG_CONTROL}${BRIDGE}`);
    assert.equal(h.handed[0]?.planner?.base_url, `${RIG_CONTROL}${BRIDGE}`);
    // Capability and model stay the same; a local revision includes the resolved destination.
    assert.equal(h.handed[0]?.route?.api_key, "bridge-capability");
    assert.notEqual(h.handed[0]?.route?.revision, "aaaaaaaa");
  });

  test("matching upstream worker revisions cannot retain a stale bridge destination", async () => {
    let current: Record<string, unknown> = {
      source: "control",
      revision: "aaaaaaaa",
      planner_revision: null,
    };
    const sent: { route: ReturnType<typeof googleRoute>; planner: null }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method !== "PUT") return Response.json(current);
      const body = JSON.parse(String(init.body));
      sent.push(body);
      current = { source: "control", revision: body.route.revision, planner_revision: null };
      return Response.json({});
    };
    const cfg = {
      harnessUrl: "http://harness",
      harnessToken: "h",
      fetchImpl,
      harnessControl: RIG_CONTROL,
    };
    const given = { route: googleRoute(), planner: null };
    assert.equal(await handModelRoute(cfg, given), "set");
    assert.equal(sent[0]?.route.base_url, `${RIG_CONTROL}${BRIDGE}`);
    assert.equal(await handModelRoute(cfg, given), "unchanged");
    assert.equal(sent.length, 1);
    assert.equal(
      await handModelRoute({ ...cfg, harnessControl: "http://other-control:8800" }, given),
      "set",
    );
    assert.equal(sent[1]?.route.base_url, `http://other-control:8800${BRIDGE}`);
    assert.equal(sent[1]?.route.api_key, "bridge-capability");
    assert.notEqual(sent[1]?.route.revision, sent[0]?.route.revision);
  });

  test("matching upstream planner revisions cannot retain a stale bridge destination", async () => {
    let current: Record<string, unknown> = { source: "environment", planner_revision: "bbbbbbbb" };
    const sent: { route: null; planner: ReturnType<typeof googleRoute> }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method !== "PUT") return Response.json(current);
      const body = JSON.parse(String(init.body));
      sent.push(body);
      current = { source: "environment", planner_revision: body.planner.revision };
      return Response.json({});
    };
    const cfg = {
      harnessUrl: "http://harness",
      harnessToken: "h",
      fetchImpl,
      harnessControl: RIG_CONTROL,
    };
    const given = { route: null, planner: googleRoute({ revision: "bbbbbbbb" }) };
    assert.equal(await handModelRoute(cfg, given), "cleared");
    assert.equal(sent[0]?.planner.base_url, `${RIG_CONTROL}${BRIDGE}`);
    assert.equal(sent[0]?.planner.api_key, "bridge-capability");
    assert.equal(await handModelRoute(cfg, given), "unchanged");
    assert.equal(sent.length, 1);
  });

  test("with no address of the harness's own, the routes go as control gave them", async () => {
    const h = harness(undefined);
    await handModelRoute(h.cfg, { route: googleRoute(), planner: null });
    assert.equal(h.handed[0]?.route?.base_url, `${PUBLIC}${BRIDGE}`);
  });

  test("every advisor role's Gemini API route goes to the supervisor's own address for control, by the same rule", async () => {
    const g = googleRoute();
    const advisors = advisorsOf(
      {
        teacher_models: [g, g],
        merged_by: g,
        auditor: g,
        review_panel: g,
        synthesizer: g,
        final_writer: g,
      },
      undefined,
      RIG_CONTROL,
    );
    const runtimes = [
      ...(advisors.teachers ?? []),
      advisors.merged_by,
      advisors.auditor,
      ...(advisors.review_panel ?? []),
      advisors.synthesizer,
      advisors.final_writer,
    ];
    assert.equal(runtimes.length, 9);
    // The harness's roles and the advisors get the one address for the same control.
    const h = harness(RIG_CONTROL);
    await handModelRoute(h.cfg, { route: g, planner: null });
    for (const rt of runtimes) {
      assert.ok(rt && rt.runtime === "openai", rt?.name);
      assert.equal(rt.base_url, h.handed[0]?.route?.base_url, rt.name);
      assert.equal(rt.api_key, "bridge-capability", rt.name);
    }
  });

  test("an ordinary provider's route goes on byte for byte, to the harness and to the advisors", async () => {
    const h = harness(RIG_CONTROL);
    await handModelRoute(h.cfg, { route: openaiRoute, planner: null });
    assert.equal(JSON.stringify(h.handed[0]?.route), JSON.stringify(openaiRoute));
    const advisors = advisorsOf({ auditor: openaiRoute }, undefined, RIG_CONTROL);
    assert.equal(
      advisors.auditor?.runtime === "openai" && advisors.auditor.base_url,
      openaiRoute.base_url,
    );
  });

  test("a Gemini API route naming another provider's bridge is refused, not sent with its capability", async () => {
    const drifted = googleRoute({ base_url: `${PUBLIC}/v1/google-gemini/someone-else` });
    await assert.rejects(
      handModelRoute(harness(RIG_CONTROL).cfg, { route: drifted, planner: null }),
      /bridge for its provider/u,
    );
    assert.throws(
      () => advisorsOf({ auditor: drifted }, undefined, RIG_CONTROL),
      /bridge for its provider/u,
    );
  });

  test("the harness's address for control: the setting, else pull mode's own, else none; a bad one stops the start", () => {
    assert.equal(
      harnessControl({ [HARNESS_CONTROL_SETTING]: "http://control:8800" }, undefined),
      "http://control:8800",
    );
    assert.equal(harnessControl({}, "http://127.0.0.1:8790"), "http://127.0.0.1:8790");
    assert.equal(harnessControl({}, undefined), undefined);
    assert.equal(harnessControl({ [HARNESS_CONTROL_SETTING]: "" }, undefined), undefined);
    for (const bad of [
      "http://u:p@control:8800",
      "http://control:8800/?x",
      "ftp://control",
      "control",
    ])
      assert.throws(
        () => harnessControl({ [HARNESS_CONTROL_SETTING]: bad }, undefined),
        /THERMITE_HARNESS_CONTROL_URL/u,
        bad,
      );
  });
});
