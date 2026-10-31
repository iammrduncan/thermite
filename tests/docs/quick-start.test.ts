import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  blocks,
  boldAfter,
  cardValue,
  commandsFor,
  engineOf,
  field,
  formWith,
  named,
  PAGES,
  pageSteps,
  pageText,
  quickStartPlan,
  quoted,
  rewrite,
  spansAfter,
  spansBefore,
  step,
} from "../helpers/quick-start.ts";

const DOCS = join(import.meta.dirname, "..", "..", "docs", "_site", "src", "content", "docs");
const read = (page: string) => readFileSync(join(DOCS, page), "utf8");

describe("the quick start's pages", () => {
  test("give the acceptance every command, value and word it follows", () => {
    const plan = quickStartPlan(read);
    assert.match(plan.repo, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    // Each engine's tester types a whole set of compose commands.
    for (const compose of ["docker compose", "podman compose", "podman-compose"]) {
      const typed = [
        ...commandsFor(plan.firstRun.init, compose),
        ...plan.firstRun.start.flatMap((b) => commandsFor(b, compose)),
        ...commandsFor(plan.firstRun.down, compose),
      ];
      assert.deepEqual(
        typed.map((c) => c.slice(compose.length + 1)),
        ["run --rm init", "up -d", "ps", "down"],
        compose,
      );
    }
    assert.ok(plan.firstRun.get.some((l) => l.startsWith("curl ")));
    assert.match(plan.firstRun.firstLine, /^# Thermite \d+\.\d+\.\d+/);
    assert.match(plan.firstRun.initDone, /^local init: \.dev ready \(\d+ made, 0 kept\)$/);
    assert.deepEqual(plan.firstRun.services, ["control", "nats", "harness", "supervisor"]);
    assert.deepEqual(plan.firstRun.token, ["cat .dev/secrets/control-admin-token"]);
    // The judge's thirteen verdicts, as step 7 counts them, add up to what step 6's check says.
    const all = Number(/all (\d+) candidates/.exec(plan.firstRun.smokePassed)?.[1]);
    const counted = Object.values(plan.firstRun.verdicts).reduce((x, y) => x + y, 0);
    assert.equal(counted, all);
    // The sample: the release tag the source is cloned at is the one the campaign starts from.
    assert.equal(plan.agents.tag, plan.agents.startFrom);
    assert.equal(plan.agents.repository, `${plan.repo}.git`);
    assert.ok(plan.agents.source.some((l) => l.includes(plan.agents.kitArchive)));
    assert.deepEqual(plan.agents.forbidden, ["__real_", "__wrap_", "thermite_ref_calls"]);
    assert.ok(plan.agents.lanes >= 1);
    assert.deepEqual(plan.commandLine.slice(-2), ["npm ci", "npm run build"]);
  });

  test("the sample's folder holds as many files as Look it up says", () => {
    const plan = quickStartPlan(read);
    const count = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true }).reduce(
        (n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1),
        0,
      );
    assert.equal(
      count(join(import.meta.dirname, "..", "..", plan.agents.folder)),
      plan.agents.folderFiles,
    );
  });

  test("a page that loses what the acceptance reads stops the plan, and says where", () => {
    const without = (page: string, from: string, to: string) => (p: string) =>
      p === page ? read(p).replace(from, to) : read(p);
    assert.throws(
      () => quickStartPlan(without(PAGES.firstRun, "## 2. Make your local tokens", "Tokens")),
      /first-run\.md has no step 2/,
    );
    assert.throws(
      () =>
        quickStartPlan(
          without(PAGES.firstRun, "releases/latest/download/compose.yaml", "compose.yaml"),
        ),
      /no command downloads/,
    );
    assert.throws(
      () => quickStartPlan(without(PAGES.agents, "**Campaign name**", "**Name of the campaign**")),
      /no value for \*\*Campaign name\*\*/,
    );
    assert.throws(
      () => quickStartPlan(without(PAGES.agents, "· 4 files in", "· 4 files under")),
      /does not count the files/,
    );
  });
});

describe("reading a page", () => {
  const page = [
    "---",
    "title: x",
    "---",
    "Intro, left out.",
    "## What you need",
    "Nothing.",
    "## 1. Start",
    "Run this:",
    "```sh",
    "docker compose up -d   # Docker",
    "podman compose up -d   # Podman",
    "```",
    "1. Then this, indented in a list:",
    "",
    "   ```sh",
    "   docker compose ps     # or: podman compose ps",
    "   # a comment line",
    "   ```",
    "### A part of step 1",
    "More.",
    "## 2. Next",
    "```text",
    "a",
    "```",
  ].join("\n");

  test("cuts it into steps with their blocks, numbered or not", () => {
    const steps = pageSteps(page);
    assert.deepEqual(
      steps.map((s) => [s.n, s.heading]),
      [
        [null, "What you need"],
        [1, "1. Start"],
        [2, "2. Next"],
      ],
    );
    const one = step(steps, 1, "p.md");
    assert.deepEqual(
      blocks(one, "sh").map((b) => b.lines),
      [
        ["docker compose up -d   # Docker", "podman compose up -d   # Podman"],
        ["docker compose ps     # or: podman compose ps", "# a comment line"],
      ],
    );
    assert.match(one.text, /A part of step 1/);
    assert.throws(() => blocks(step(steps, 2, "p.md"), "sh"), /step "2. Next" has no sh block/);
    assert.throws(() => step(steps, 3, "p.md"), /p\.md has no step 3/);
    // At depth 3, the ### heading starts a section of its own.
    assert.equal(step(pageSteps(page, 3), "A part", "p.md").text.trim(), "More.");
    assert.throws(() => pageSteps("## 1. x\n```sh\nopen\n"), /never closed/);
  });

  test("gives each engine its own commands", () => {
    const lines = [
      "docker compose run --rm init     # Docker",
      "podman compose run --rm init     # Podman",
      "docker compose ps                # or: podman compose ps",
      "# only a comment",
      "",
      "cat .dev/secrets/x               # shows it",
    ];
    assert.equal(engineOf("podman-compose"), "podman");
    assert.equal(engineOf("docker compose"), "docker");
    assert.deepEqual(commandsFor(lines, "docker compose"), [
      "docker compose run --rm init",
      "docker compose ps",
      "cat .dev/secrets/x",
    ]);
    assert.deepEqual(commandsFor(lines, "podman compose"), [
      "podman compose run --rm init",
      "podman compose ps",
      "cat .dev/secrets/x",
    ]);
    assert.deepEqual(commandsFor(lines, "podman-compose"), [
      "podman-compose run --rm init",
      "podman-compose ps",
      "cat .dev/secrets/x",
    ]);
  });

  test("rewrites only what it names, and counts each rewrite", () => {
    const hits = new Map<string, number>();
    const rw = [{ from: "https://example.com/r", to: "http://127.0.0.1:1/r", why: "local" }];
    assert.equal(
      rewrite("curl https://example.com/r/a https://example.com/r/b", rw, hits),
      "curl http://127.0.0.1:1/r/a http://127.0.0.1:1/r/b",
    );
    assert.equal(rewrite("ls", rw, hits), "ls");
    assert.equal(hits.get("https://example.com/r"), 1);
  });

  test("finds the values, quotes and bold words a step gives", () => {
    const text = [
      "2. **Campaign name**: `matmul-agents`",
      "Keep **Better is** at **higher**, and **Smallest gain that counts (%)** at `5`.",
      "**The score** shows `flops_per_s: a rate (FLOP/s)`.",
      "In its field **why (optional)**, type `seen enough`, then press **Pause the run**.",
      "Its last line is `local init: .dev ready (17 made, 0 kept)`.",
      "Keep `small` and `large` at **Measured**, and set `held` to **Hidden test**.",
      "You see one each for `control`, `harness` and `supervisor`.",
      "In its first list, choose **OpenCode v2**.",
    ].join("\n");
    assert.equal(field(text, "Campaign name"), "matmul-agents");
    assert.equal(field(text, "Better is"), "higher");
    assert.equal(field(text, "Smallest gain that counts (%)"), "5");
    assert.equal(field(text, "The score"), "flops_per_s: a rate (FLOP/s)");
    assert.equal(field(text, "why (optional)"), "seen enough");
    assert.throws(() => field(text, "Title"), /no value for \*\*Title\*\*/);
    assert.equal(quoted(text, "local init:"), "local init: .dev ready (17 made, 0 kept)");
    assert.throws(() => quoted(text, "nothing"), /quotes nothing/);
    assert.deepEqual(spansBefore(text, "Measured"), ["small", "large"]);
    assert.deepEqual(spansBefore(text, "Hidden test"), ["held"]);
    assert.deepEqual(spansAfter(text, "one each for"), ["control", "harness", "supervisor"]);
    assert.equal(boldAfter(text, "In its first list, choose"), "OpenCode v2");
    assert.equal(named(text, "Pause the run"), "Pause the run");
    assert.throws(() => named(text, "Resume"), /does not name \*\*Resume\*\*/);
  });
});

describe("reading a dashboard page", () => {
  test("its text is what a reader sees", () => {
    assert.equal(
      pageText(
        "<style>b{}</style><p>nothing needs you &middot; 0 runs</p>\n<script>x()</script><b>1&nbsp;of&#32;1</b> &lt;ok&gt; &#x2026;",
      ),
      "nothing needs you · 0 runs 1 of 1 <ok> …",
    );
    // Bold and links run on with their sentence; blocks and other tags part words.
    assert.equal(
      pageText(
        '<div class="small">This run is <b>paused: x</b>. See <a href="/y">the run</a>.</div><span>passed</span><span>Isolation</span>',
      ),
      "This run is paused: x. See the run. passed Isolation",
    );
  });

  test("finds the form by its button, with what a browser sends", () => {
    const html = [
      '<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="c1"><input type="hidden" name="check" value="isolation"><button>Run it</button></form>',
      '<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="c1"><input type="hidden" name="check" value="smoke"><button>Run it</button></form>',
      '<form method="post" action="/ui/settings/rigs?x=1&amp;y=2"><input type="hidden" name="rig" value="local-1"><input name="note"><input type="checkbox" name="off"><input type="checkbox" name="on" checked><input type="file" name="f">',
      '<select name="harness"><option value="pi">Pi</option><option value="opencode" selected>OpenCode v2</option></select>',
      '<select name="choice" aria-label="model"><option value="a|b">b &amp; c</option></select>',
      '<select name="lanes"><option>1</option><option selected>2</option></select><button class="x">Use</button></form>',
    ].join("");
    const smoke = formWith(html, "Run it", 'value="smoke"');
    assert.equal(smoke.action, "/ui/commands");
    assert.deepEqual(smoke.fields, { csrf: "c1", check: "smoke" });
    assert.equal(formWith(html, "Run it").fields.check, "isolation");
    const use = formWith(html, "Use");
    assert.equal(use.action, "/ui/settings/rigs?x=1&y=2");
    assert.deepEqual(use.fields, {
      rig: "local-1",
      note: "",
      on: "",
      harness: "opencode",
      choice: "a|b",
      lanes: "2",
    });
    assert.deepEqual(use.options.harness, { Pi: "pi", "OpenCode v2": "opencode" });
    assert.deepEqual(use.options.choice, { "b & c": "a|b" });
    assert.throws(() => formWith(html, "Pause"), /no form with a "Pause" button/);
  });

  test("finds a choice card's value by its title", () => {
    const html =
      '<div class="ch on" data-group="mode" data-value="hill_climb" tabindex="0"><span class="dotx"></span><span><b>Hill climb</b><span class="muted">x</span></span></div><div class="ch" data-group="mode" data-value="goal" tabindex="0"><span><b>Goal</b></span></div>';
    assert.equal(cardValue(html, "mode", "Hill climb"), "hill_climb");
    assert.equal(cardValue(html, "mode", "Goal"), "goal");
    assert.throws(() => cardValue(html, "kit", "Goal"), /no kit card titled "Goal"/);
  });
});
