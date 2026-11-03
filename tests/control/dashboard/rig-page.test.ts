import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deviceModeText } from "../../../src/control/ui/components/index.ts";
import { figuresCall } from "../../helpers/control-store.ts";
import { stack } from "./stack.ts";

/**
 * A rig's page: a rig check run from it, its hardware, and the supervisor's self-report, checked
 * and escaped.
 */

describe("control dashboard", () => {
  test("a rig check runs from the rig page, and its result shows there in words", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    s.env.service.rigChecks.model = {
      run: async () => ({
        ok: false,
        summary: "m failed the tool-call check: no tool call (stop: stop)",
      }),
    };
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(page, /<h2>Checks<\/h2>/);
    assert.match(
      page,
      /<span class="chip">not run yet<\/span><\/span><span class="ck-main"><span><b>Model route<\/b>/,
    );
    const r = await s.post("/ui/commands", {
      csrf: s.csrfFrom(page),
      rig: "rig-a",
      kind: "rig_check",
      check: "model",
      back: "/ui/rigs/rig-a",
    });
    assert.equal(r.status, 303);
    await s.relay(); // delivered: the harness starts the check
    await new Promise((res) => setTimeout(res, 20));
    await s.relay(); // its result reaches control
    const after = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(
      after,
      /<span class="chip bad">failed<\/span><\/span><span class="ck-main"><span><b>Model route<\/b> <span class="muted small">[^<]* ago<\/span><\/span><span class="ck-sum bad">m failed the tool-call check: no tool call/,
    );
    // The page's opening sentence says so, and so does its history.
    assert.match(after, /<b class="bad">Its model route check failed\.<\/b>/);
    assert.match(after, /The model route check FAILED/);
  });

  test("the supervisor's figures, advisor roles included, are accepted and say whether an auditor will decide", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    // The shape the supervisor sends (src/supervisor/main.ts): its stats and its configured roles.
    const r = await figuresCall(s.store, "rig-a", {
      at: new Date().toISOString(),
      relay: { cursor: 3 },
      export: { remote: false, exports: 1, pushed: [], last_push_at: null, last_error: null },
      advisors: {
        teacher_runs: 2,
        directive_sets: 1,
        directives: 3,
        audits: 0,
        reviews: 0,
        errors: 0,
        tokens_in: 100,
        tokens_out: 20,
        usd: 0,
        roles: { teachers: 2, merged_by: true, auditor: false, review_panel: 0 },
      },
    });
    assert.equal(r.status, 200, await r.clone().text());
    const sup = s.store.reportedRigs.supervisor("rig-a") as {
      advisors?: { roles?: { auditor?: boolean } };
    };
    assert.equal(sup.advisors?.roles?.auditor, false);
  });

  test("a supervisor's self-report cannot carry markup, and pages forbid scripts", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    await s.relay();
    const post = (body: unknown) => figuresCall(s.store, "rig-a", body);
    const evil = await post({
      at: "now",
      export: {
        remote: true,
        exports: "<img src=x onerror=alert(1)>",
        pushed: [],
        last_push_at: null,
        last_error: null,
      },
    });
    assert.equal(evil.status, 400);
    const ok = await post({
      at: "now",
      export: {
        remote: true,
        exports: 3,
        pushed: [],
        last_push_at: "<script>x</script>",
        last_error: null,
      },
    });
    assert.equal(ok.status, 200);
    const page = await s.get("/ui/rigs/rig-a");
    const html = await page.text();
    assert.ok(!html.includes("<script>x</script>"));
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });

  test("a rig's hardware shows on its page and in the rigs list, escaped", async () => {
    const s = await stack();
    await s.env.service.applyCommand(s.env.assign);
    s.env.service.hardware = {
      collected_at: new Date().toISOString(),
      target: { type: "cuda-gpu", class: "p100-pcie-16g", id: "GPU-a" },
      device_mode: "dedicated",
      devices: ["judge", "dev"].map((role, i) => ({
        role: role as "judge" | "dev",
        name: i ? "<b>Evil card</b>" : "Tesla P100-PCIE-16GB",
        uuid: `GPU-${i}`,
        bus: `00000000:0${1 + i}:00.0`,
        memory_mib: 16384,
        driver: "550.00.00",
        cuda: "12.4",
        power_limit_w: 250,
        max_sm_mhz: 1328,
        max_mem_mhz: 715,
        pcie: "gen3 x16",
        vbios: null,
      })),
      cpu: { model: "Example CPU", host: 48, usable: 48, quota: 6 },
      memory: { host_mib: 192_000, limit_mib: 12_288 },
      disks: [{ name: "state", total_gib: 200, free_gib: 150 }],
      os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
      toolchain: { cc: "cc 12", nvcc: null },
      errors: [],
    };
    await s.relay();
    const page = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(page, /Tesla P100-PCIE-16GB/);
    assert.match(page, /one for the judge, one for agents' dev runs/);
    const hw = s.env.service.hardware;
    const card = (role: "judge" | "dev") => ({
      ...(hw.devices[0] as (typeof hw.devices)[0]),
      role,
    });
    assert.equal(
      deviceModeText({
        ...hw,
        devices: [card("judge"), card("judge"), card("dev"), card("dev"), card("dev")],
      }),
      "2 for the judge, 3 for agents' dev runs",
    );
    assert.match(page, /quota 6 CPU of the host's 48/);
    assert.match(page, /12 GiB limit/);
    // The short version comes first.
    assert.match(page, /<h2>What it runs on<\/h2>/);
    assert.match(page, /<dt>CPU<\/dt><dd>6 of the host/);
    assert.ok(!page.includes("<b>Evil card</b>"));
    assert.match(page, /&lt;b&gt;Evil card/);
    const list = await (await s.get("/ui/rigs")).text();
    assert.match(list, /Tesla P100-PCIE-16GB · &lt;b&gt;Evil card&lt;\/b&gt; · 6 CPU · 12 GiB RAM/);
  });
});
