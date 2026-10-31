#!/usr/bin/env node
// New-campaign acceptance: a campaign from nothing through control's dashboard form, end to end.
// A tiny C project is served from this machine by git daemon. The form's draft describes the kit
// on the page; control writes the kit, keeps it, stores the contract and signs the assignment.
// The rig's supervisor fetches the project from the git server and the kit from control (with
// the rig's token), the harness checks both by commit, and the run starts. Then the same kit,
// uploaded as a .zip, starts a second campaign's try. Then a project in a folder of its
// repository: the sample in examples/matmul-cpu, served as part of a larger repository, with its
// kit uploaded as the quick start makes it; the rig fetches the repository and the try starts from
// the folder. Last, the private path: control makes a deploy key, an SSH server that accepts only
// that key serves the project, and a campaign from it is fetched by the rig with the key.
// Usage: COMPOSE="podman compose" node scripts/acceptance/campaign.mjs (or "docker compose").
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceChecks } from "./lib/checks.mjs";
import {
  api,
  control,
  dc,
  engine,
  events,
  formAnswer,
  latestVerdicts,
  prepare,
  secret,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const { check, results } = acceptanceChecks();

// The project: one C file whose benchmark prints the n it was given.
const root = mkdtempSync(join(tmpdir(), "thermite-newcamp-"));
const work = join(root, "work");
mkdirSync(work);
writeFileSync(
  join(work, "bench.c"),
  `#include <stdio.h>\n#include <stdlib.h>\nint main(int c, char **v) { long n = atol(v[1]); volatile double s = 0; for (long i = 0; i < n * 200000; i++) s += i; printf("%ld\\n", n); return 0; }\n`,
);
const git = (...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: work,
    encoding: "utf8",
  }).trim();
git("init", "--quiet", "-b", "main");
git("add", "-A");
git("commit", "--quiet", "-m", "a tiny benchmark");
const commit = git("rev-parse", "HEAD");
execFileSync("git", ["clone", "--quiet", "--bare", work, join(root, "tiny.git")]);
writeFileSync(join(root, "tiny.git", "git-daemon-export-ok"), "");
// A larger repository that holds the sample project and its kit in a folder, beside other files.
const sampleWork = join(root, "sample-work");
mkdirSync(sampleWork);
cpSync(join("examples", "matmul-cpu"), join(sampleWork, "examples", "matmul-cpu"), {
  recursive: true,
});
writeFileSync(join(sampleWork, "README.md"), "A repository whose project is in a folder.\n");
const sampleGit = (...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: sampleWork,
    encoding: "utf8",
  }).trim();
sampleGit("init", "--quiet", "-b", "main");
sampleGit("add", "-A");
sampleGit("commit", "--quiet", "-m", "the sample in a folder");
const sampleCommit = sampleGit("rev-parse", "HEAD");
execFileSync("git", ["clone", "--quiet", "--bare", sampleWork, join(root, "sample.git")]);
writeFileSync(join(root, "sample.git", "git-daemon-export-ok"), "");
// The kit's archive, made as the quick start makes it: one top folder, kit/.
execFileSync("tar", [
  "-czf",
  join(root, "matmul-cpu-kit.tar.gz"),
  "-C",
  "examples/matmul-cpu",
  "kit",
]);
const port = 19418;
const daemon = spawn(
  "git",
  ["daemon", "--reuseaddr", `--base-path=${root}`, `--port=${port}`, "--listen=0.0.0.0", root],
  { stdio: "ignore" },
);
const hostName = engine === "docker" ? "host.docker.internal" : "host.containers.internal";
const gitBox = "thermite-acc-git";
const projectUrl = `git://${hostName}:${port}/tiny.git`;

prepare();
// Two calibration blocks: a try of the kit is the judge measuring the starting point on its own.
const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_CALIBRATION_BLOCKS: "2",
  // A model route for the rig's agents, so the run may start with them: control refuses agents on a
  // rig with none. Nothing answers there, so they fail at once; the patches come from this script.
  THERMITE_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
  THERMITE_MODEL: "no-model-here",
};
console.log("compose: build and start");
dc(composeEnv, "up", "-d", "--build");
try {
  // The rig must have reported its hardware: the campaign's target comes from it.
  await until(
    "the rig reports its hardware",
    async () => (await api("/v1/rigs/local-1/view")).body?.hardware?.target,
    240_000,
    2000,
  );
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const pageHtml = await (
    await fetch(`${control}/ui/campaigns/new`, { headers: { cookie } })
  ).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(pageHtml)?.[1] ?? "";
  check(
    "the new-campaign page offers the rig",
    /data-value="local-1"/.test(pageHtml) && csrf.length > 0,
  );
  // The draft the page's script sends: a hill climb with its kit described on the page.
  const draft = {
    mode: "hill_climb",
    campaign: "acc-tiny",
    title: "Acceptance: a campaign from nothing",
    project: { url: projectUrl, ref: "main", commit, repo: "tiny", editable_paths: ["bench.c"] },
    // The case shape the page sends: a name and its arguments; the score is plain time.
    kit: {
      source: "here",
      build: "cc -O2 -o bench bench.c",
      outputs: ["bench"],
      cases: [
        { name: "small", args: "50" },
        { name: "large", args: "200" },
      ],
      run: "{build}/bench {args} > {out}/result.txt",
      check: 'test "$(cat {out}/result.txt)" = {args}',
      runs_per_case: 1,
    },
    score: { kind: "time", min_effect: 0.1 },
    lanes: 1,
  };
  const res = await fetch(`${control}/ui/campaigns/new`, {
    method: "POST",
    body: new URLSearchParams({
      csrf,
      draft: JSON.stringify(draft),
      rig: "local-1",
      start_value: "try",
    }),
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "control took the campaign and started a try of its kit",
    res.status === 303 && /acc-tiny-try-1/.test(String(res.headers.get("location"))),
    {
      status: res.status,
      location: res.headers.get("location"),
      page: res.status === 303 ? undefined : (await res.text()).match(/<li>[^<]*<\/li>/g),
    },
  );
  // The try: no agents; the judge builds the starting point and runs every case on its own.
  const calibrated = await until(
    "the judge measures the try on its own",
    async () =>
      (await events()).find((e) => e.kind === "calibration" && e.subject === "acc-tiny-try-1"),
    600_000,
    3000,
  );
  check(
    "the try measured every case with no agents",
    calibrated?.body?.blocks === 2,
    calibrated?.body,
  );
  // Then the campaign itself, from its page's start form.
  const started = await fetch(`${control}/ui/campaigns/acc-tiny/runs`, {
    method: "POST",
    body: new URLSearchParams({ csrf, rig: "local-1", agents: "on", promotion: "" }),
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "the campaign's own run starts from its page",
    started.status === 303 && !/error=/.test(String(started.headers.get("location"))),
    {
      location: started.headers.get("location"),
    },
  );
  const created = await until(
    "the run starts on the rig",
    async () =>
      (await events()).find((e) => e.kind === "run_created" && e.subject === "acc-tiny-1"),
    300_000,
    3000,
  );
  const evs = await events();
  const imports = evs
    .filter((e) => e.kind === "import_verified")
    .map((e) => ({ kind: e.subject, commit: e.body.commit, name: e.body.name }));
  check(
    "the supervisor fetched the project from its git server and the kit from control; the harness verified both",
    Boolean(created) &&
      imports.some((i) => i.kind === "repo_bundle" && i.commit === commit) &&
      imports.some((i) => i.kind === "kit_bundle"),
    imports,
  );
  // A faster benchmark (a tenth of the loop) must win on the judge's clock, scored as time.
  const faster = execFileSync(
    "sh",
    ["-c", "sed 's/n \\* 200000/n * 20000/' bench.c > f.c && mv f.c bench.c && git diff"],
    { cwd: work, encoding: "utf8" },
  );
  const sub = submit(composeEnv, "acc-tiny-1", faster, "loop a tenth as often");
  const verdict = await until(
    "the judge's verdict on the faster benchmark",
    async () => {
      const v = latestVerdicts(await events())[sub.attempt];
      return v && v !== "win_screened" ? v : undefined;
    },
    600_000,
    3000,
  );
  check("a faster run wins when the score is time", verdict === "win_confirmed", { verdict });
  const cmd = (await api("/v1/commands")).body.commands.find((c) => c.kind === "assign_campaign");
  check(
    "the assignment was signed by control for the owner and delivered",
    cmd?.status === "delivered" && cmd?.issued_by === "owner:ui",
    cmd && { status: cmd.status, issued_by: cmd.issued_by },
  );
  // The kit control wrote, fetched as a rig would and uploaded as a .zip with one top folder:
  // control unpacks it in its own image, keeps it as a new kit, and a try of it runs.
  const kitDir = join(root, "uploaded", "kit");
  execFileSync("git", [
    "-c",
    `http.extraHeader=Authorization: Bearer ${secret("control-rig-token")}`,
    "clone",
    "-q",
    `${control}/v1/rigs/local-1/git/kits/acc-tiny-kit.git`,
    kitDir,
  ]);
  rmSync(join(kitDir, ".git"), { recursive: true });
  execFileSync("zip", ["-qr", join(root, "kit.zip"), "kit"], { cwd: join(root, "uploaded") });
  const form = new FormData();
  form.append("csrf", csrf);
  form.append("archive", new File([readFileSync(join(root, "kit.zip"))], "kit.zip"));
  const up = await fetch(`${control}/ui/campaigns/new/kit`, {
    method: "POST",
    body: form,
    headers: { cookie },
  });
  const kit = await up.json();
  check(
    "control unpacked and checked an uploaded kit",
    up.status === 200 && kit.cells?.join(" ") === "small large",
    kit,
  );
  const fromUpload = await fetch(`${control}/ui/campaigns/new`, {
    method: "POST",
    body: new URLSearchParams({
      csrf,
      draft: JSON.stringify({
        ...draft,
        campaign: "acc-up",
        kit: { source: "upload", upload: kit.id, cells: kit.cells, held_out: [] },
        score: { min_effect: 0.1 },
      }),
      rig: "local-1",
      start_value: "try",
    }),
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "control took a campaign with the uploaded kit and started its try",
    fromUpload.status === 303 && /acc-up-try-1/.test(String(fromUpload.headers.get("location"))),
    { status: fromUpload.status, location: fromUpload.headers.get("location") },
  );
  const uploadedTry = await until(
    "the judge measures the uploaded kit's try",
    async () =>
      (await events()).find((e) => e.kind === "calibration" && e.subject === "acc-up-try-1"),
    600_000,
    3000,
  );
  check(
    "the uploaded kit's try measured every case",
    uploadedTry?.body?.blocks === 2,
    uploadedTry?.body,
  );

  // A project in a folder of its repository: the sample, with its kit uploaded.
  const sampleForm = new FormData();
  sampleForm.append("csrf", csrf);
  sampleForm.append(
    "archive",
    new File([readFileSync(join(root, "matmul-cpu-kit.tar.gz"))], "matmul-cpu-kit.tar.gz"),
  );
  const sampleUp = await fetch(`${control}/ui/campaigns/new/kit`, {
    method: "POST",
    body: sampleForm,
    headers: { cookie },
  });
  const sampleKit = await sampleUp.json();
  check(
    "control checked the sample's kit, packed as the quick start packs it",
    sampleUp.status === 200 &&
      sampleKit.name === "matmul-cpu" &&
      sampleKit.cells?.join(" ") === "small large held",
    sampleKit,
  );
  const folder = "examples/matmul-cpu/project";
  const fromFolder = await fetch(`${control}/ui/campaigns/new`, {
    method: "POST",
    body: new URLSearchParams({
      csrf,
      draft: JSON.stringify({
        mode: "hill_climb",
        campaign: "acc-folder",
        title: "Acceptance: a project in a folder of its repository",
        project: {
          url: `git://${hostName}:${port}/sample.git`,
          ref: "main",
          commit: sampleCommit,
          repo: "sample",
          folder,
          editable_paths: ["src/kernel/**"],
          forbidden_patterns: ["__real_", "__wrap_", "thermite_ref_calls"],
        },
        kit: {
          source: "upload",
          upload: sampleKit.id,
          cells: ["small", "large", "held"],
          held_out: ["held"],
        },
        score: { name: "flops_per_s", direction: "max", min_effect: 0.1 },
        lanes: 1,
      }),
      rig: "local-1",
      start_value: "try",
    }),
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "control took a campaign whose project is a folder, and started its try",
    fromFolder.status === 303 &&
      /acc-folder-try-1/.test(String(fromFolder.headers.get("location"))),
    {
      status: fromFolder.status,
      location: fromFolder.headers.get("location"),
      page:
        fromFolder.status === 303 ? undefined : (await fromFolder.text()).match(/<li>[^<]*<\/li>/g),
    },
  );
  const folderRun = await until(
    "the folder's try starts on the rig",
    async () =>
      (await events()).find((e) => e.kind === "run_created" && e.subject === "acc-folder-try-1"),
    300_000,
    3000,
  );
  check(
    "the rig fetched the whole repository and started from the folder",
    folderRun?.body?.seed?.folder === folder &&
      folderRun?.body?.seed?.source_commit === sampleCommit &&
      folderRun?.body?.seed?.commit !== sampleCommit,
    folderRun?.body?.seed,
  );
  const folderTry = await until(
    "the judge measures the sample from its folder",
    async () =>
      (await events()).find((e) => e.kind === "calibration" && e.subject === "acc-folder-try-1"),
    600_000,
    3000,
  );
  check(
    "the sample's kit built the folder's project and measured every case",
    folderTry?.body?.blocks === 2,
    folderTry?.body,
  );

  // The private path. A stand-in Git host on control's network accepts only keys in its
  // authorized_keys; control makes the deploy key in Providers and keeps its private half.
  execFileSync(engine, ["build", "-q", "-t", "thermite-test-machine", "containers/test-machine"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync(
    engine,
    ["run", "-d", "--name", gitBox, "--network", "thermite_control", "thermite-test-machine"],
    { stdio: "ignore" },
  );
  execFileSync(engine, ["cp", join(root, "tiny.git"), `${gitBox}:/home/thermite/tiny.git`]);
  execFileSync(engine, [
    "exec",
    gitBox,
    "chown",
    "-R",
    "thermite:thermite",
    "/home/thermite/tiny.git",
  ]);
  const privateUrl = `ssh://thermite@${gitBox}/home/thermite/tiny.git`;
  const settingsPost = (path, form) =>
    fetch(`${control}${path}`, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie },
      redirect: "manual",
    }).then((r) => formAnswer(r, cookie));
  // A Git access is for one host: the stand-in Git host's name.
  await settingsPost("/ui/settings/add", { type: "gitkey", name: "acc-deploy", host: gitBox });
  const settings = await (await fetch(`${control}/ui/settings`, { headers: { cookie } })).text();
  const deployKey = /<pre class="json"[^>]*>(ssh-ed25519 [A-Za-z0-9+/=]+[^<]*)<\/pre>/.exec(
    settings,
  )?.[1];
  check(
    "control made a deploy key and shows only its public half",
    Boolean(deployKey) && !/PRIVATE KEY/.test(settings),
    deployKey,
  );
  const before = await settingsPost("/ui/settings/git/acc-deploy/test", { url: privateUrl });
  check(
    "before the key is added, the private repository refuses control",
    /could not read/.test(before),
    before,
  );
  execFileSync(engine, [
    "exec",
    gitBox,
    "sh",
    "-c",
    `printf '%s\\n' "$1" >> /home/thermite/.ssh/authorized_keys`,
    "sh",
    deployKey ?? "",
  ]);
  const after = await settingsPost("/ui/settings/git/acc-deploy/test", { url: privateUrl });
  check(
    "with the key added, control reads the private repository",
    new RegExp(`reads .*${commit.slice(0, 7)}`).test(after),
    after,
  );
  const fromPrivate = await fetch(`${control}/ui/campaigns/new`, {
    method: "POST",
    body: new URLSearchParams({
      csrf,
      draft: JSON.stringify({
        ...draft,
        campaign: "acc-private",
        project: { ...draft.project, url: privateUrl, access: "acc-deploy", repo: "tiny-private" },
      }),
      rig: "local-1",
      start_value: "try",
    }),
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "control took a campaign from the private repository",
    fromPrivate.status === 303 &&
      /acc-private-try-1/.test(String(fromPrivate.headers.get("location"))),
    { status: fromPrivate.status, location: fromPrivate.headers.get("location") },
  );
  const privateImport = await until(
    "the rig fetches the private repository with the deploy key",
    async () =>
      (await events()).find(
        (e) =>
          e.kind === "import_verified" &&
          e.subject === "repo_bundle" &&
          e.body?.name === "tiny-private",
      ),
    300_000,
    3000,
  );
  check(
    "the supervisor fetched the private project with the key, and the harness verified it",
    privateImport?.body?.commit === commit,
    privateImport?.body,
  );
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  daemon.kill();
  try {
    execFileSync(engine, ["rm", "-f", gitBox], { stdio: "ignore" });
  } catch {}
  dc(composeEnv, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(`campaign acceptance: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
