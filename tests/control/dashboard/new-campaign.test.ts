import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { controlStack, signIn } from "../../helpers/control-stack.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";

/** Control with kits and one CPU rig that has reported its hardware; signed in. */
async function stack() {
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const probes: string[] = [];
  const { env, store, control, relay } = controlStack({
    env: makeJudgeEnv({ promotion: "auto" }),
    options: {
      kits,
      probeRepo: async (url, ref, _access, folder) => {
        probes.push(`${url}@${ref}${folder ? ` in ${folder}` : ""}`);
        if (url.includes("private")) throw new Error("control cannot read it without a key");
        if (folder === "examples/none") throw new Error(`${ref} has no folder ${folder}`);
        return folder
          ? { commit: C, files: 4, suggest: ["src/**", "src/kernel/**"] }
          : { commit: C, files: 1532, suggest: ["src/**", "src/kernels/**"] };
      },
    },
  });
  env.service.hardware = {
    collected_at: new Date().toISOString(),
    target: { type: "cpu", class: "generic-cpu", id: "cpu-a" },
    device_mode: "none",
    devices: [],
    cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
    memory: { host_mib: 16_000, limit_mib: null },
    disks: [],
    os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
    toolchain: { cc: "cc 12", nvcc: null },
    errors: [],
  };
  await relay();
  const { cookie, get, page, csrfOf, post } = await signIn(control);
  const csrf = csrfOf(await page("/ui/campaigns/new"));
  /** Sends a kit archive as the page does: a multipart form with the page's token. */
  const upload = (name: string, archive: Buffer, token = csrf) => {
    const body = new FormData();
    body.append("csrf", token);
    body.append("archive", new File([new Uint8Array(archive)], name));
    return control.request("/ui/campaigns/new/kit", { method: "POST", body, headers: { cookie } });
  };
  return { store, kits, get, post, upload, csrf, probes };
}

const draft = (over: Record<string, unknown> = {}) => ({
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  project: {
    url: "https://git.example.com/team/fastmat.git",
    ref: "main",
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: {
    source: "here",
    build: "make bench",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
    run: "{build}/bench --n {n} --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { name: "throughput", unit: "FLOP/s", direction: "max", min_effect: 0.05 },
  lanes: 2,
  ...over,
});

describe("the new-campaign page", () => {
  test("the page offers the rig and explains every field; a campaign from nothing starts its first run", async () => {
    const s = await stack();
    const page = await (await s.get("/ui/campaigns/new")).text();
    // The mode's name as everywhere else.
    assert.match(page, /data-value="hill_climb"[\s\S]*?Hill climb/);
    assert.doesNotMatch(page, /Hillclimbing/);
    assert.match(page, /data-group="rig" data-value="rig-a"/);
    assert.match(page, /cpu · generic-cpu/);
    assert.match(page, /<script src="\/ui\/assets\/new-campaign.js" defer>/);
    // Every label has its description.
    const labels = page.match(/class="lb"/g)?.length ?? 0;
    const tips = page.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(labels > 20 && tips === labels, `${labels} labels, ${tips} with descriptions`);
    assert.match(await (await s.get("/ui/campaigns")).text(), /href="\/ui\/campaigns\/new"/);
    const js = await s.get("/ui/assets/new-campaign.js");
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    // Its counts in words: "1 agent works", "1 file".
    const script = await js.text();
    assert.match(script, /" agent works" : " agents work"/);
    assert.match(script, /j\.files \+ " file" \+ \(j\.files === 1 \? "" : "s"\)/);

    // The project is looked up by control; the page then shows what it found.
    // A POST with the form's token: a lookup may unseal a Git access, so no link can start one.
    const asLink = `/ui/campaigns/new/probe?${new URLSearchParams({ url: "https://git.example.com/team/fastmat.git" })}`;
    assert.equal((await s.get(asLink)).status, 404);
    assert.equal(
      (await s.post("/ui/campaigns/new/probe", { url: "https://git.example.com/team/fastmat.git" }))
        .status,
      403,
    );
    const probe = await s.post("/ui/campaigns/new/probe", {
      csrf: s.csrf,
      url: "https://git.example.com/team/fastmat.git",
      ref: "main",
    });
    assert.deepEqual(await probe.json(), {
      commit: C,
      files: 1532,
      suggest: ["src/**", "src/kernels/**"],
    });
    const refused = await s.post("/ui/campaigns/new/probe", {
      csrf: s.csrf,
      url: "https://git.example.com/private.git",
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /without a key/);

    // Started without the page's lookup: control looks the ref up itself.
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft()),
      rig: "rig-a",
      promotion: "",
      start_value: "start",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/ui/campaigns/matmul-speed/runs/matmul-speed-1");
    assert.ok(s.probes.includes("https://git.example.com/team/fastmat.git@main"));
    const [v] = s.store.campaigns.versions("matmul-speed");
    const contract = v?.contract as { target: unknown; project: { kit: { commit: string } } };
    assert.deepEqual(contract.target, { type: "cpu", class: "generic-cpu" });
    assert.equal(contract.project.kit.commit, s.kits.head("matmul-speed-kit"));
    const cmd = s.store.commands.list(10).find((c) => c.kind === "assign_campaign");
    assert.equal(cmd?.rig, "rig-a");
    assert.equal(cmd?.issued_by, "owner:ui");
    assert.ok(
      JSON.stringify(s.store.db.prepare("select action from audit").all()).includes(
        "campaign_version_created",
      ),
    );
  });

  test("Ideas kept ready (goal 081): a target, explained; in the contract; on the campaign's page", async () => {
    const s = await stack();
    const page = await (await s.get("/ui/campaigns/new")).text();
    const tip =
      /<span class="lb">Ideas kept ready<i class="ii" tabindex="0" data-tip="([^"]+)">i<\/i><\/span><input name="queue_target" inputmode="numeric" placeholder="2 for each agent">/.exec(
        page,
      )?.[1] ?? "";
    assert.match(tip, /^How many experiments the queue keeps ready for the agents' next tries/);
    assert.match(tip, /It is a target that drives ideas, not a cap/);
    assert.match(tip, /Empty: 2 for each agent\. 0: ask for none\./);
    const script = await (await s.get("/ui/assets/new-campaign.js")).text();
    assert.match(
      script,
      /if \(mode !== "research" && num\("queue_target"\) !== undefined\) d\.queue_target = num\("queue_target"\);/,
    );
    // Saved with its own number: the contract's lanes.queue_target.
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft({ queue_target: 6 })),
      rig: "rig-a",
      promotion: "",
      start_value: "save",
    });
    assert.equal(res.status, 303);
    const [v] = s.store.campaigns.versions("matmul-speed");
    assert.deepEqual((v?.contract as { lanes?: unknown } | undefined)?.lanes, {
      count: 2,
      trials_per_epoch: 3,
      queue_target: 6,
    });
    const campaign = await (await s.get("/ui/campaigns/matmul-speed")).text();
    assert.match(
      campaign,
      /<h2>Experiment queue<\/h2>[\s\S]*?Ideas kept ready[\s\S]*?<b>6<\/b> <span class="muted">\(the campaign's own number\)<\/span>/,
    );
    // Without a number: two for each lane, said so.
    const other = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft({ campaign: "matmul-two", lanes: 3 })),
      rig: "rig-a",
      promotion: "",
      start_value: "save",
    });
    assert.equal(other.status, 303);
    assert.match(
      await (await s.get("/ui/campaigns/matmul-two")).text(),
      /<b>6<\/b> <span class="muted">\(2 for each of 3 lanes\)<\/span>/,
    );
    // Out of range: refused in words, nothing saved.
    const bad = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft({ campaign: "matmul-bad", queue_target: -1 })),
      rig: "rig-a",
      promotion: "",
      start_value: "save",
    });
    assert.match(await bad.text(), /Ideas kept ready is 0 or more/);
    assert.equal(s.store.campaigns.versions("matmul-bad").length, 0);
  });

  test("Verified claims before the check (goal 112): beside Run for at least, explained; in the contract only when set; refused below 1", async () => {
    const s = await stack();
    const page = await (await s.get("/ui/campaigns/new")).text();
    const fields =
      /<div class="g3"><label class="fd"><span class="lb">Run for at least<i class="ii" tabindex="0" data-tip="([^"]+)">i<\/i><\/span><input name="min_duration" value="8h"><\/label>\n<label class="fd"><span class="lb">Verified claims before the check<i class="ii" tabindex="0" data-tip="([^"]+)">i<\/i><\/span><input name="min_verified_claims" inputmode="numeric" placeholder="no floor"><\/label><\/div>/.exec(
        page,
      );
    assert.ok(fields, "both fields, side by side, each with its description");
    assert.match(String(fields[1]), /the review panel checks whether every question is answered/);
    assert.match(String(fields[2]), /It only delays the check: it never ends the run\./);
    assert.match(String(fields[2]), /Empty: no floor/);
    const script = await (await s.get("/ui/assets/new-campaign.js")).text();
    assert.match(
      script,
      /if \(num\("min_verified_claims"\) !== undefined\) d\.research\.min_verified_claims = num\("min_verified_claims"\);/,
    );
    assert.match(script, /set\("min_verified_claims", back\.research\.min_verified_claims\)/);
    const research = (campaign: string, more: Record<string, unknown>) =>
      s.post("/ui/campaigns/new", {
        csrf: s.csrf,
        draft: JSON.stringify(
          draft({
            mode: "research",
            campaign,
            project: undefined,
            kit: undefined,
            score: undefined,
            research: {
              topic: "RL harnesses",
              questions: ["Which is fastest?"],
              min_duration: "1h",
              ...more,
            },
          }),
        ),
        rig: "rig-a",
        start_value: "save",
      });
    assert.equal((await research("rl-floor", { min_verified_claims: 12 })).status, 303);
    const [floor] = s.store.campaigns.versions("rl-floor");
    assert.ok(floor);
    assert.equal((floor.contract as { min_verified_claims?: unknown }).min_verified_claims, 12);
    assert.equal((await research("rl-none", {})).status, 303);
    const [none] = s.store.campaigns.versions("rl-none");
    assert.ok(none && !("min_verified_claims" in (none.contract as object)), "no floor: not in it");
    const bad = await research("rl-bad", { min_verified_claims: 0 });
    assert.match(await bad.text(), /Verified claims before the check is 1 or more/);
    assert.equal(s.store.campaigns.versions("rl-bad").length, 0);
  });

  test("past research: the page links to the knowledge base, and a campaign saved without starting offers grants and From past research", async () => {
    const s = await stack();
    const page = await (await s.get("/ui/campaigns/new")).text();
    const note = /<div class="nc-does" id="nc-past">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? "";
    assert.match(note, /<a href="\/ui\/knowledge">Thermite's knowledge base<\/a>/);
    assert.match(note, /press <b>Save without starting<\/b>/);
    assert.match(note, /add collections under <b>Can read from<\/b>/);
    assert.match(note, /press <b>Start a run<\/b> and pick items under <b>From past research<\/b>/);
    // Saved without starting: the campaign's page has both, as the note says.
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft()),
      rig: "rig-a",
      promotion: "",
      start_value: "save",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/ui/campaigns/matmul-speed");
    const campaign = await (await s.get("/ui/campaigns/matmul-speed")).text();
    assert.match(campaign, /<div class="block" id="knowledge">/);
    assert.match(campaign, /<h2>Can read from<\/h2>/);
    assert.match(campaign, /From past research/);
    assert.equal(s.store.commands.list(10).filter((c) => c.kind === "assign_campaign").length, 0);
  });

  test("try the kit first: a no-agents run, a page that waits for it, and a start form for the real run", async () => {
    const s = await stack();
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify({ ...draft(), project: { ...(draft().project as object), commit: C } }),
      rig: "rig-a",
      start_value: "try",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/ui/campaigns/matmul-speed/runs/matmul-speed-try-1");
    // Before the rig reports the run: its page waits, and the saved campaign's page has a way to
    // start a run.
    const waiting = await (
      await s.get("/ui/campaigns/matmul-speed/runs/matmul-speed-try-1")
    ).text();
    assert.match(waiting, /Starting matmul-speed-try-1 on rig-a/);
    assert.ok(!waiting.includes("data-refresh"), "pages never reload by themselves");
    assert.match(waiting, /page from \d\d:\d\d:\d\d UTC<\/span><a href="" /);
    assert.match(
      await (await s.get("/ui/campaigns/matmul-speed")).text(),
      /action="\/ui\/campaigns\/matmul-speed\/runs"/,
    );
    const started = await s.post("/ui/campaigns/matmul-speed/runs", {
      csrf: s.csrf,
      rig: "rig-a",
      agents: "on",
      promotion: "",
    });
    assert.equal(started.status, 303);
    assert.match(
      String(started.headers.get("location")),
      /\/ui\/campaigns\/matmul-speed\/runs\/matmul-speed-1$/,
    );
    const kinds = s.store.commands.list(10).map((c) => c.kind);
    assert.deepEqual(kinds, ["assign_campaign", "assign_campaign"]);
    const bad = await s.post("/ui/campaigns/matmul-speed/runs", { csrf: s.csrf, rig: "nope" });
    assert.match(
      decodeURIComponent(String(bad.headers.get("location"))),
      /error=No rig is called nope\. Choose a rig\.$/,
    );
    const none = await s.post("/ui/campaigns/matmul-speed/runs", { csrf: s.csrf });
    assert.match(String(none.headers.get("location")), /error=Choose%20a%20rig\.$/);
  });

  test("an uploaded kit is checked and summed up, then kept by control for the campaign", async () => {
    const s = await stack();
    const dir = mkdtempSync(join(tmpdir(), "thermite-up-"));
    const smoke = resolve(import.meta.dirname, "..", "..", "..", "kits", "smoke-cpu");
    execFileSync("tar", ["-czf", join(dir, "kit.tar.gz"), "-C", smoke, "."]);
    const res = await s.upload("kit.tar.gz", readFileSync(join(dir, "kit.tar.gz")));
    assert.equal(res.status, 200);
    const kit = (await res.json()) as { id: string; name: string; cells: string[] };
    assert.equal(kit.name, "smoke-cpu");
    assert.deepEqual(kit.cells, ["small", "large", "held"]);
    // A page sent back with mistakes can show it again.
    const again = await s.get(`/ui/campaigns/new/kit/${kit.id}`);
    assert.deepEqual(await again.json(), kit);
    assert.equal((await s.get(`/ui/campaigns/new/kit/${"0".repeat(64)}`)).status, 404);
    const saved = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(
        draft({
          project: { ...(draft().project as object), commit: C },
          kit: { source: "upload", upload: kit.id, cells: ["small", "held"], held_out: ["held"] },
          score: { name: "flops_per_s", direction: "max", min_effect: 0.05 },
        }),
      ),
      rig: "rig-a",
      start_value: "save",
    });
    assert.equal(saved.status, 303, await saved.text());
    const [v] = s.store.campaigns.versions("matmul-speed");
    assert.deepEqual(v?.sources.kit, { control: "kits/matmul-speed-kit" });
    const contract = v?.contract as { project: { kit: { commit: string } }; cells: string[] };
    assert.deepEqual(contract.cells, ["small"]);
    // The kit repository holds the archive's files at the commit the contract names.
    const show = (path: string) =>
      execFileSync("git", [
        "--git-dir",
        join(s.kits.dir, "matmul-speed-kit.git"),
        "show",
        `${contract.project.kit.commit}:${path}`,
      ]);
    assert.deepEqual(show("kit.json"), readFileSync(join(smoke, "kit.json")));
    assert.deepEqual(show("bench/build.sh"), readFileSync(join(smoke, "bench", "build.sh")));
    // Not a kit, or a form without the page's token: refused.
    const bad = await s.upload("notes.tgz", Buffer.from("not an archive"));
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /.+/);
    const forged = await s.upload(
      "kit.tar.gz",
      readFileSync(join(dir, "kit.tar.gz")),
      "0".repeat(64),
    );
    assert.equal(forged.status, 403);
  });

  test("mistakes come back on the page with the answers kept, and nothing is created", async () => {
    const s = await stack();
    const bad = draft({
      kit: { ...(draft().kit as object), run: "{build}/bench --size {size}" },
    });
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(bad),
      rig: "rig-a",
      start_value: "start",
    });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /Not started: fix these first/);
    assert.match(page, /\{size\} is not a placeholder here/);
    assert.match(page, /data-draft="\{&quot;mode&quot;:&quot;hill_climb&quot;/);
    assert.equal(s.store.campaigns.versions().length, 0);
    assert.equal(s.store.commands.list(10).length, 0);
    // No rig chosen, or a form without its token, changes nothing either.
    const noRig = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft()),
      rig: "",
    });
    assert.match(await noRig.text(), /Choose a rig/);
    const forged = await s.post("/ui/campaigns/new", {
      csrf: "0".repeat(64),
      draft: JSON.stringify(draft()),
      rig: "rig-a",
    });
    assert.equal(forged.status, 403);
    assert.equal(s.store.campaigns.versions().length, 0);
  });

  test("a project in a folder of its repository: the page asks for it, the lookup reads that folder, and the contract names it", async () => {
    const s = await stack();
    const page = await (await s.get("/ui/campaigns/new")).text();
    assert.match(
      page,
      /<span class="lb">Folder in the repository<i class="ii" tabindex="0" data-tip="Leave it empty when the project is the whole repository\. [^"]+">i<\/i><\/span><input class="mono" name="project_folder"/,
    );
    const script = await (await s.get("/ui/assets/new-campaign.js")).text();
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /folder: folder\(\)/);
    const mono = "https://git.example.com/team/mono.git";
    const probe = (folder: string) =>
      s.post("/ui/campaigns/new/probe", { csrf: s.csrf, url: mono, ref: "main", folder });
    // The lookup reads the folder: its files, and paths to suggest from its own top.
    assert.deepEqual(await (await probe("examples/matmul-cpu/project")).json(), {
      commit: C,
      files: 4,
      suggest: ["src/**", "src/kernel/**"],
    });
    const missing = await probe("examples/none");
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /main has no folder/);
    const outside = await probe("../etc");
    assert.equal(outside.status, 400);
    assert.match(
      ((await outside.json()) as { error: string }).error,
      /no part that starts with a dot/,
    );
    assert.ok(!s.probes.some((p) => p.includes("../etc")), "a bad folder never reaches git");

    // The sample's kit, packed as the quick start packs it: one top folder, kit/.
    const dir = mkdtempSync(join(tmpdir(), "thermite-up-"));
    const sample = resolve(import.meta.dirname, "..", "..", "..", "examples", "matmul-cpu");
    execFileSync("tar", ["-czf", join(dir, "matmul-cpu-kit.tar.gz"), "-C", sample, "kit"]);
    const up = await s.upload(
      "matmul-cpu-kit.tar.gz",
      readFileSync(join(dir, "matmul-cpu-kit.tar.gz")),
    );
    assert.equal(up.status, 200);
    const kit = (await up.json()) as { id: string; name: string; cells: string[] };
    assert.deepEqual([kit.name, kit.cells], ["matmul-cpu", ["small", "large", "held"]]);
    const inFolder = (folder: string) =>
      draft({
        project: {
          url: mono,
          ref: "main",
          repo: "mono",
          folder,
          editable_paths: ["src/kernel/**"],
          forbidden_patterns: ["__real_", "__wrap_", "thermite_ref_calls"],
        },
        kit: {
          source: "upload",
          upload: kit.id,
          cells: ["small", "large", "held"],
          held_out: ["held"],
        },
        score: { name: "flops_per_s", direction: "max", min_effect: 0.05 },
        lanes: 1,
      });
    // Started without the page's lookup: control looks it up in the folder.
    const res = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(inFolder("examples/matmul-cpu/project")),
      rig: "rig-a",
      start_value: "start",
    });
    assert.equal(res.status, 303);
    assert.ok(s.probes.includes(`${mono}@main in examples/matmul-cpu/project`));
    const [v] = s.store.campaigns.versions("matmul-speed");
    assert.equal(
      (v?.contract as { project: { folder?: string } } | undefined)?.project.folder,
      "examples/matmul-cpu/project",
    );
    // The rig is sent the whole repository's commit, and the contract that names the folder.
    const payload = s.store.commands.latestAssignments().get("matmul-speed")?.payload as {
      contract: { project: { folder?: string } };
      seed: { commit: string };
      imports: { kind: string; commit: string; source?: { git?: string } }[];
    };
    assert.equal(payload.contract.project.folder, "examples/matmul-cpu/project");
    assert.equal(payload.seed.commit, C);
    assert.deepEqual(
      payload.imports.filter((i) => i.kind === "repo_bundle").map((i) => [i.commit, i.source?.git]),
      [[C, mono]],
    );
    // A folder that is not a path in the repository: refused in words, and nothing is sent.
    const bad = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify({ ...inFolder("/abs"), campaign: "abs-folder" }),
      rig: "rig-a",
      start_value: "start",
    });
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /project\.folder: a folder in the repository/);
    assert.equal(s.store.campaigns.versions("abs-folder").length, 0);
  });

  test("agents never start on a rig with no model: the page gives it one, saves the campaign, and starts once the rig has it", async () => {
    const s = await stack();
    // The rig reports that its agents have no model.
    const model = (m: unknown) =>
      s.store.db
        .prepare(
          "update rig set summary = json_set(summary, '$.model', json(?)) where id = 'rig-a'",
        )
        .run(JSON.stringify(m));
    model({ source: "none", harness: "pi" });
    s.store.modelProviders.put({
      name: "zen",
      type: "opencode",
      base_url: "https://opencode.ai/zen/v1",
    });
    s.store.modelProviders.setModels("zen", [
      { id: "glm-5.3-flash-free" },
      { id: "deepseek-v4.1-flash-free" },
    ]);
    const form = await (await s.get("/ui/campaigns/new")).text();
    assert.match(form, /no model for its agents yet/);
    assert.match(
      form,
      /<option value="zen\|glm-5\.3-flash-free" data-window="0">glm-5\.3-flash-free<\/option>/,
    );
    assert.match(
      form,
      /<select name="agents_harness">[\s\S]*?<option value="codex">Codex<\/option>/,
    );
    const send = (extra: Record<string, string>) =>
      s.post("/ui/campaigns/new", {
        csrf: s.csrf,
        draft: JSON.stringify(draft()),
        rig: "rig-a",
        start_value: "start",
        ...extra,
      });
    const refused = await (await send({})).text();
    assert.match(refused, /rig-a has no model for its agents, so they could not work/);
    // A try of the kit needs no model; neither does another run without agents, from its page.
    const tried = await send({
      draft: JSON.stringify(draft({ campaign: "matmul-try" })),
      start_value: "try",
    });
    assert.match(String(tried.headers.get("location")), /\/runs\/matmul-try-try-/);
    const another = async (agents: string) =>
      decodeURIComponent(
        String(
          (
            await s.post("/ui/campaigns/matmul-try/runs", { csrf: s.csrf, rig: "rig-a", agents })
          ).headers.get("location"),
        ),
      );
    assert.match(await another("on"), /error=rig-a has no model for its agents/);
    const without = await another("off");
    assert.doesNotMatch(without, /error=/);
    assert.match(without, /\/runs\/matmul-try-/);
    // OpenCode's free models work only inside OpenCode: research workers in Pi can't use them.
    const researchDraft = draft({
      mode: "research",
      campaign: "rl-research",
      project: undefined,
      kit: undefined,
      score: undefined,
      research: { topic: "RL harnesses", questions: ["Which is fastest?"], min_duration: "1h" },
    });
    const research = await (
      await s.post("/ui/campaigns/new", {
        csrf: s.csrf,
        draft: JSON.stringify(researchDraft),
        rig: "rig-a",
        start_value: "start",
        agents_model: "zen|glm-5.3-flash-free",
        agents_harness: "pi",
      })
    ).text();
    assert.match(
      research,
      /glm-5\.3-flash-free is one of OpenCode's free models, which work only inside OpenCode, and rig-a's agents would run in Pi/,
    );
    assert.equal(s.store.agentModels.byRig()["rig-a"], undefined, "the rig was given nothing");
    assert.equal(s.store.campaigns.versions("matmul-speed").length, 0, "nothing created");

    // A model chosen on the page: the rig gets it, the campaign is saved, no run yet.
    const saved = await send({ agents_model: "zen|glm-5.3-flash-free" });
    assert.equal(saved.status, 303);
    const to = decodeURIComponent(String(saved.headers.get("location")));
    assert.match(
      to,
      /^\/ui\/campaigns\/matmul-speed\?ok=Saved\. rig-a takes glm-5\.3-flash-free within a minute/,
    );
    assert.deepEqual(s.store.agentModels.byRig()["rig-a"], {
      provider: "zen",
      model: "glm-5.3-flash-free",
      harness: "opencode",
    });
    assert.match(await (await s.get(to)).text(), /rig-a takes glm-5\.3-flash-free within a minute/);

    // Once the rig shows the model, the next campaign starts at once.
    model({ source: "control", model: "glm-5.3-flash-free", harness: "opencode" });
    const started = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(draft({ campaign: "matmul-speed-2" })),
      rig: "rig-a",
      start_value: "start",
      agents_model: "zen|glm-5.3-flash-free",
    });
    assert.match(String(started.headers.get("location")), /\/runs\/matmul-speed-2-/);
    // In OpenCode they can: a research run on the same model starts.
    const inOpencode = await s.post("/ui/campaigns/new", {
      csrf: s.csrf,
      draft: JSON.stringify(researchDraft),
      rig: "rig-a",
      start_value: "start",
      agents_model: "zen|glm-5.3-flash-free",
    });
    assert.match(String(inOpencode.headers.get("location")), /\/runs\/rl-research-/);
    // The agents in the Codex CLI: only with a provider OpenAI's Responses API reaches.
    const codexRefused = await (
      await send({
        draft: JSON.stringify(draft({ campaign: "matmul-codex" })),
        agents_model: "zen|glm-5.3-flash-free",
        agents_harness: "codex",
      })
    ).text();
    assert.match(codexRefused, /Codex runs only with a ChatGPT subscription/);
    s.store.modelProviders.put({
      name: "openai",
      type: "openai",
      base_url: "https://api.openai.com/v1",
      key: { sealed: "s1:not-opened-here", hint: "…abcd" },
    });
    s.store.modelProviders.setModels("openai", [{ id: "gpt-test" }]);
    const inCodex = await send({
      draft: JSON.stringify(draft({ campaign: "matmul-codex" })),
      agents_model: "openai|gpt-test",
      agents_harness: "codex",
    });
    assert.match(decodeURIComponent(String(inCodex.headers.get("location"))), /takes gpt-test/);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "codex");
  });
});
