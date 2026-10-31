import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cardValue, formWith, pageText } from "../../../tests/helpers/quick-start.ts";
import { latestVerdicts, lifecycles, until } from "../lib/smoke-env.mjs";
import { check, control, MODEL, PROVIDER, plan, rig, section, tag } from "./context.mjs";
import { checkDone, cookie, events, page, press, said, send, view, words } from "./dashboard.mjs";
import { HYPOTHESIS } from "./model.mjs";
import { cwd, quiet, typed } from "./processes.mjs";
import { containersHost } from "./release.mjs";

/**
 * Hand the work to agents, steps 1 to 11, with the command line and `thermite doctor` from
 * Troubleshoot: the scripted model as the rig's model, the sample campaign to the judge's first
 * verdict on an agent's change, and a pause. It reaches the source and the model where
 * beforeTheTester serves them.
 */
export async function handToAgents({ served, gitDir, gitPort, modelUrl }) {
  // ------------------------------------------------ Hand the work to agents
  section("Hand the work to agents, 1: add a model provider (the scripted model)");
  const settings = await page("/ui/settings");
  const add = formWith(settings.html, plan.agents.addProvider);
  check(
    "the provider form offers an OpenAI-compatible provider",
    Object.values(add.options.type ?? {}).includes("openai"),
    add.options.type,
  );
  const added = await send(
    add.action,
    new URLSearchParams({
      ...add.fields,
      type: "openai",
      name: PROVIDER,
      base_url: modelUrl,
      api_key: "quick-start",
    }),
  );
  const savedWords = plan.agents.providerSaved.replace(
    `"${plan.agents.providerName}"`,
    `"${PROVIDER}"`,
  );
  check(
    "the provider is saved and lists its model",
    said(added.location).startsWith(`${savedWords} 1 model`),
    { said: said(added.location) || said(added.location, "error") },
  );

  section("Hand the work to agents, 2: give the rig the model");
  const rows = await page("/ui/settings");
  check(
    `the rig's row says "${plan.agents.noModel}"`,
    pageText(rows.html).includes(plan.agents.noModel),
  );
  const use = formWith(rows.html, plan.agents.use, `name="rig" value="${rig}"`);
  const harness = use.options.harness?.[plan.agents.harness];
  const choice = `${PROVIDER}|${MODEL}`;
  check(
    `the row offers ${plan.agents.harness} and the scripted model`,
    Boolean(harness) && Object.values(use.options.choice ?? {}).includes(choice),
    use.options,
  );
  const given = await send(use.action, new URLSearchParams({ ...use.fields, harness, choice }));
  check(
    `Use gives the rig the model under ${plan.agents.harness}`,
    said(given.location).includes(`under ${plan.agents.harness} within a minute`),
    { said: said(given.location) || said(given.location, "error") },
  );

  section("Hand the work to agents, 3: check that the model works");
  const modelCheck = await checkDone("model", 600_000);
  check(
    "the rig's model check passed, in the page's words",
    modelCheck.ok === true &&
      plan.agents.modelPassed.every((w) => String(modelCheck.summary).includes(w)),
    modelCheck.summary,
  );

  section("Hand the work to agents, 4: get the sample and pack its kit");
  await typed(plan.agents.source, "step 4");
  const sourceDir = cwd;
  check(
    "the kit's archive is in thermite-source",
    existsSync(join(sourceDir, plan.agents.kitArchive)),
  );

  section("Troubleshoot: build the command line and check the machine");
  await typed(plan.commandLine, "the command line");
  const doctorLines = plan.doctor.map((l) =>
    l.replace(/--model-url\s+\S+/, `--model-url ${modelUrl}`),
  );
  const doctor = await typed(doctorLines, "thermite doctor");
  check("thermite doctor finds no failure", doctor.includes(plan.doctorOk));

  section(
    "Hand the work to agents, 5 to 8: name the campaign, point it at the sample, upload the kit, start it",
  );
  const form = await page("/ui/campaigns/new");
  const formWords = pageText(form.html);
  const missing = [
    ...plan.agents.formLabels,
    plan.agents.kitField,
    plan.agents.lookUp,
    plan.agents.startButton,
    plan.agents.access,
  ].filter((l) => !formWords.includes(l));
  check("New campaign shows every field and button the steps name", !missing.length, { missing });
  const mode = cardValue(form.html, "mode", plan.agents.mode);
  const kitSource = cardValue(form.html, "kit", plan.agents.kitCard);
  // Look it up, done here: control reads only https:// addresses, and the source is served here.
  check(
    "the campaign starts from the release the source was cloned at",
    plan.agents.startFrom === plan.agents.tag,
  );
  const ref = tag;
  const sourceCommit = quiet("git", ["ls-remote", served, `refs/tags/${ref}`]).split(/\s/)[0];
  const folderFiles = quiet(
    "git",
    ["ls-tree", "-r", "--name-only", sourceCommit, "--", `${plan.agents.folder}/`],
    { cwd: join(gitDir, "thermite.git") },
  )
    .split("\n")
    .filter(Boolean).length;
  check(
    "the folder holds as many files as Look it up says",
    folderFiles === plan.agents.folderFiles,
    { files: folderFiles, page: plan.agents.folderFiles },
  );
  // The kit, uploaded as the page's Kit archive field sends it.
  const campaignForm = formWith(form.html, plan.agents.startButton);
  const upload = new FormData();
  upload.append("csrf", campaignForm.fields.csrf ?? "");
  upload.append(
    "archive",
    new File([readFileSync(join(sourceDir, plan.agents.kitArchive))], plan.agents.kitArchive),
  );
  const up = await fetch(`${control}/ui/campaigns/new/kit`, {
    method: "POST",
    body: upload,
    headers: { cookie },
  });
  const kit = await up.json();
  const n = kit.cells?.length ?? 0;
  const summary = `${kit.name}: measures on ${kit.target}, ${n} case${n === 1 ? "" : "s"}, scores ${Object.keys(kit.metrics ?? {}).join(", ")}.`;
  check(
    "control checks the kit, and sums it up as the page does",
    up.ok && summary === plan.agents.kitSummary,
    { summary, page: plan.agents.kitSummary, error: kit.error },
  );
  const used = [...plan.agents.measured, ...plan.agents.hidden];
  check(
    "the kit has every case the page uses",
    used.every((c) => kit.cells.includes(c)),
    { kit: kit.cells, page: used },
  );
  const [metric, about] = plan.agents.score.split(": ");
  check("the score is the one the page shows", kit.metrics?.[metric]?.about === about, kit.metrics);
  const direction = { higher: "max", lower: "min" }[plan.agents.better];
  check("Better is higher or lower", Boolean(direction), plan.agents.better);
  const project = plan.agents.repository.replace(plan.repo, "").replace(/^\//, "");
  const draft = {
    mode,
    campaign: plan.agents.campaign,
    title: plan.agents.title,
    lanes: plan.agents.lanes,
    limits: {},
    project: {
      url: `git://${containersHost()}:${gitPort}/thermite.git`,
      ref,
      commit: sourceCommit,
      repo: (
        project
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .pop() || "project"
      ).toLowerCase(),
      folder: plan.agents.folder,
      editable_paths: [plan.agents.editable],
      forbidden_patterns: plan.agents.forbidden,
    },
    kit: {
      source: kitSource,
      upload: kit.id,
      cells: kit.cells.filter((c) => used.includes(c)),
      held_out: plan.agents.hidden,
    },
    score: { name: metric, direction, min_effect: plan.agents.minEffectPercent / 100 },
  };
  console.log(`  draft: ${JSON.stringify(draft)}`);
  const started = await send(
    "/ui/campaigns/new",
    new URLSearchParams({
      ...campaignForm.fields,
      draft: JSON.stringify(draft),
      rig,
      start_value: "start",
    }),
  );
  check(
    "Start the campaign takes it and starts its first run",
    started.status === 303 && started.location.includes("/runs/"),
    {
      status: started.status,
      location: started.location,
      page: started.status === 303 ? undefined : pageText(started.text).slice(0, 400),
    },
  );
  check(
    "the run's page says what the page quotes",
    (await words(started.location.replace(control, ""))).includes(plan.agents.starting),
    plan.agents.starting,
  );
  const run = /^Starting (\S+) on \S+\.$/.exec(plan.agents.starting)?.[1];
  const created = await until(
    "the run starts on the rig",
    async () => (await events()).find((e) => e.kind === "run_created" && e.subject === run),
    900_000,
    5000,
  );
  check(
    "the rig fetched the repository and started from the folder",
    created.body?.seed?.folder === plan.agents.folder &&
      created.body?.seed?.source_commit === sourceCommit,
    created.body?.seed,
  );

  section("Hand the work to agents, 9 and 10: watch the agent work and the judge decide");
  const first = await until(
    "the judge's first verdict on an agent's change",
    async () => {
      const all = await events();
      const v = latestVerdicts(all);
      const l = lifecycles(all);
      const attempts = all.filter((e) => e.kind === "attempt_recorded" && e.body.run === run);
      const refused = attempts.find((a) => l[a.subject] === "rejected_v0");
      if (refused) return { attempt: refused, verdict: "rejected v0" };
      const judged = attempts.find((a) => v[a.subject] && v[a.subject] !== "win_screened");
      return judged && { attempt: judged, verdict: v[judged.subject] };
    },
    2_400_000,
    10_000,
  );
  check(
    "lane-1's agent submitted the change",
    first.attempt.body.lane === "lane-1" && first.attempt.body.hypothesis === HYPOTHESIS,
    first.attempt.body,
  );
  check("the judge confirmed it faster", first.verdict === "win_confirmed", {
    verdict: first.verdict,
  });

  section("Hand the work to agents, 11: pause the campaign");
  const runPath = `/ui/campaigns/${encodeURIComponent(plan.agents.campaign)}/runs/${encodeURIComponent(run)}`;
  const runPage = await page(runPath);
  const paused = await press(runPage.html, plan.agents.pause, `value="${run}"`, {
    reason: plan.agents.pauseReason,
  });
  check("Pause the run sends the command", paused.status === 303, { status: paused.status });
  const stopped = await until(
    "the run's page says it is paused",
    async () => ((await words(runPath)).includes(plan.agents.paused) ? true : undefined),
    300_000,
    5000,
  ).catch(() => false);
  const shown = await words(runPath);
  const status = (await view()).runs?.find((r) => r.id === run);
  check("the run's page says what the page quotes", stopped === true, {
    page: plan.agents.paused,
    status: status?.status,
    reason: status?.pause_reason,
    seen: shown.slice(
      Math.max(0, shown.indexOf("This run is")),
      shown.indexOf("This run is") + 200,
    ),
  });
}
