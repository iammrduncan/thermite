import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageText } from "../../../tests/helpers/quick-start.ts";
import { latestVerdicts, lifecycles, until } from "../lib/smoke-env.mjs";
import { check, control, plan, rig, section, version } from "./context.mjs";
import { checkDone, cookie, events, page, press, setToken, token, words } from "./dashboard.mjs";
import { cd, cwd, hits, rewrites, typed } from "./processes.mjs";

/** The tester's thermite folder, from step 1 on: step 8 and the clean-up stop the stack there. */
export let thermiteDir = "";

/** Your first run, steps 1 to 7: from the release bundle to the judge's smoke check's verdicts. */
export async function firstRun() {
  // ------------------------------------------------ Your first run
  section("Your first run, 1: get Thermite");
  await typed(plan.firstRun.get, "step 1");
  thermiteDir = cwd;
  const firstLine = readFileSync(join(thermiteDir, "compose.yaml"), "utf8").split("\n")[0];
  // The page's example names its own release; this bundle's is this checkout's version.
  const names = plan.firstRun.firstLine.replace(/\d+\.\d+\.\d+\S*$/, version);
  check(
    "the compose file's first line names the release, as the page shows it",
    firstLine.startsWith(names) && !/[\w.-]/.test(firstLine.charAt(names.length)),
    { firstLine, page: plan.firstRun.firstLine },
  );

  section("Your first run, 2: make your local tokens");
  const init = await typed(plan.firstRun.init, "step 2");
  const initDone = init
    .split("\n")
    .filter((l) => l.startsWith("local init:"))
    .at(-1);
  check("init's last line is the page's", initDone === plan.firstRun.initDone, {
    printed: initDone,
    page: plan.firstRun.initDone,
  });

  section("Your first run, 3: start Thermite");
  let listed = "";
  for (const [i, block] of plan.firstRun.start.entries())
    listed = await typed(block, `step 3, block ${i + 1}`);
  const lines = listed.split("\n");
  const notUp = plan.firstRun.services.filter(
    (s) => !lines.some((l) => l.includes(s) && /\bUp\b/.test(l)),
  );
  check("ps lists the page's containers as Up", !notUp.length, {
    services: plan.firstRun.services,
    notUp,
  });

  section("Your first run, 4: sign in");
  setToken((await typed(plan.firstRun.token, "step 4", { secret: true })).trim());
  check("the owner's token is in .dev/secrets", token.length >= 32);
  await until(
    "control answers",
    async () => (await fetch(`${control}/v1/health`)).ok,
    120_000,
    2000,
  );
  const login = await page("/ui/login");
  check(
    "the sign-in page has the Admin token field",
    pageText(login.html).includes(plan.firstRun.tokenLabel),
  );
  const signed = await press(login.html, plan.firstRun.signIn, undefined, { token });
  check(
    "Sign in takes the token",
    signed.status === 303 && signed.location === "/ui" && cookie !== "",
    { status: signed.status, location: signed.location },
  );
  const overview = await until(
    "Overview's first line",
    async () => ((await words("/ui")).includes(plan.firstRun.overview) ? true : undefined),
    300_000,
    5000,
  ).catch(() => false);
  check("Overview says what the page says", overview === true, {
    page: plan.firstRun.overview,
    seen: (await words("/ui")).slice(0, 300),
  });

  section("Your first run, 5: meet your rig");
  const live = await until(
    "the rig is live",
    async () => ((await words(`/ui/rigs/${rig}`)).includes(plan.firstRun.live) ? true : undefined),
    180_000,
    5000,
  ).catch(() => false);
  check(`the rig's page says "${plan.firstRun.live}"`, live === true);
  const isolation = await checkDone("isolation", 600_000);
  check("Isolation passed by itself at the rig's start", isolation.ok === true, isolation.summary);

  section("Your first run, 6: run the judge's smoke check");
  const rigPage = await page(`/ui/rigs/${rig}`);
  check(
    "the rig's page has the Judge smoke check",
    pageText(rigPage.html).includes(plan.firstRun.smokeCheck),
  );
  const ran = await press(rigPage.html, plan.firstRun.runIt, 'name="check" value="smoke"');
  check("Run it sends the command", ran.status === 303, {
    status: ran.status,
    text: ran.text.slice(0, 200),
  });
  const smoke = await checkDone("smoke", 1_200_000);
  check(
    "Judge smoke passed, in the page's words",
    smoke.ok === true && String(smoke.summary).startsWith(plan.firstRun.smokePassed),
    smoke.summary,
  );
  const smokeRun = (await events()).find(
    (e) => e.kind === "run_created" && String(e.subject).startsWith("check-smoke-"),
  );
  check(
    "the check's campaign is the one the page names",
    smokeRun?.body?.campaign === plan.firstRun.smokeCampaign,
    { campaign: smokeRun?.body?.campaign, page: plan.firstRun.smokeCampaign },
  );

  section("Your first run, 7: see what the judge decided");
  const evs = await events();
  const verdicts = latestVerdicts(evs);
  const life = lifecycles(evs);
  // A candidate the kit lets end in more than one way (its `accept`) counts as its first, as the
  // check judged it and as the page counts it: on a busy machine a change that tests the rig
  // itself can come out inconclusive or regress, not neutral.
  const candidates = Object.values(
    JSON.parse(readFileSync("kits/smoke-cpu/candidates/candidates.json", "utf8")),
  );
  const counted = {};
  for (const e of evs.filter(
    (x) => x.kind === "attempt_recorded" && x.body.run === smokeRun.subject,
  )) {
    const verdict = verdicts[e.subject];
    const accepts = candidates.find((c) => c.hypothesis === e.body.hypothesis)?.accept ?? [];
    const word =
      life[e.subject] === "rejected_v0"
        ? "rejected v0"
        : String(accepts.includes(verdict) ? accepts[0] : (verdict ?? life[e.subject])).replace(
            /_/g,
            " ",
          );
    counted[word] = (counted[word] ?? 0) + 1;
  }
  const same = (x, y) =>
    JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
  check(
    "How the judge decided counts what the page counts",
    same(counted, plan.firstRun.verdicts),
    { counted, page: plan.firstRun.verdicts },
  );
}

/**
 * Your first run, step 8, after Hand the work to agents: stop Thermite. Then every change the test
 * made to the pages' commands must still be needed.
 */
export async function stopThermite() {
  section("Your first run, 8: stop Thermite");
  cd(thermiteDir);
  await typed(plan.firstRun.down, "step 8");
  for (const r of rewrites)
    check(`the pages still need the test's change: ${r.why}`, (hits.get(r.from) ?? 0) > 0, r.from);
}
