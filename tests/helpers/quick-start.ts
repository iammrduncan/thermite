/**
 * The quick start's steps, read from its pages. The quick-start acceptance
 * (scripts/acceptance/quick-start.mjs) follows the tutorials as a tester would: it runs each
 * page's shell blocks as written, and takes the values it types and the words it expects to see
 * from the pages' own text. So a change to a page that breaks its steps fails the test, and the
 * unit test (quick-start.test.ts) fails at once when a page no longer has what the test reads.
 *
 * Nothing here runs anything: it parses Markdown and rewrites command lines.
 */

/** A fenced block: its language, and its lines without the fence's indent. */
export interface Block {
  lang: string;
  lines: string[];
}

/** A `## ` section of a page. Numbered steps ("## 4. Sign in") have their number. */
export interface Step {
  n: number | null;
  heading: string;
  /** The section's text without its fenced blocks. */
  text: string;
  blocks: Block[];
}

/**
 * A page's sections in order, cut at its `## ` headings (and at `### ` too when `depth` is 3).
 * Text before the first heading is left out.
 */
export function pageSteps(markdown: string, depth: 2 | 3 = 2): Step[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const headingAt = depth === 3 ? /^#{2,3} (.+)$/ : /^## (.+)$/;
  const steps: Step[] = [];
  let current: Step | undefined;
  let fence: { indent: string; marks: string; block: Block } | undefined;
  for (const line of body.split("\n")) {
    if (fence) {
      if (line.trim() === fence.marks) {
        current?.blocks.push(fence.block);
        fence = undefined;
      } else
        fence.block.lines.push(
          line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line.trimStart(),
        );
      continue;
    }
    const open = /^(\s*)(`{3,})(\w*)/.exec(line);
    if (open) {
      fence = {
        indent: open[1] ?? "",
        marks: open[2] ?? "```",
        block: { lang: open[3] ?? "", lines: [] },
      };
      continue;
    }
    const heading = headingAt.exec(line);
    if (heading) {
      const title = (heading[1] ?? "").trim();
      const n = /^(\d+)\.\s/.exec(title);
      current = { n: n ? Number(n[1]) : null, heading: title, text: "", blocks: [] };
      steps.push(current);
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  if (fence) throw new Error("a fenced block is never closed");
  return steps;
}

/** The step with this number, or with a heading that starts with these words. */
export function step(steps: Step[], which: number | string, page: string): Step {
  const s = steps.find((x) =>
    typeof which === "number" ? x.n === which : x.heading.startsWith(which),
  );
  if (!s)
    throw new Error(
      `${page} has no step ${typeof which === "number" ? which : JSON.stringify(which)}`,
    );
  return s;
}

/** The step's fenced blocks in one language; at least one, else an error that names the step. */
export function blocks(s: Step, lang: string): Block[] {
  const found = s.blocks.filter((b) => b.lang === lang);
  if (!found.length) throw new Error(`step "${s.heading}" has no ${lang} block`);
  return found;
}

export type Engine = "docker" | "podman";

/** The engine a compose command line belongs to: `docker compose` (Docker) or Podman's. */
export const engineOf = (compose: string): Engine =>
  compose.trim().startsWith("docker") ? "docker" : "podman";

/**
 * A shell block's commands for one engine, as a tester with that engine types them:
 * - a line marked `# Docker` or `# Podman` is kept only for that engine;
 * - a line marked `# or: …` is the other engine's line when the comment names that engine;
 * - other comments and blank lines go;
 * - `docker compose` and `podman compose` at the start of a line become the tester's own compose
 *   command (for example `podman-compose`).
 */
export function commandsFor(lines: string[], compose: string): string[] {
  const engine = engineOf(compose);
  const out: string[] = [];
  for (const raw of lines) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const m = /^(.*?)\s+#\s+(.*)$/.exec(raw);
    let line = (m ? m[1] : raw)?.trim() ?? "";
    const comment = m?.[2]?.trim() ?? "";
    if (comment === "Docker" || comment === "Podman") {
      if (comment.toLowerCase() !== engine) continue;
    } else if (comment.startsWith("or: ")) {
      const other = comment.slice(4).trim();
      if (other.startsWith(`${engine} `) && !line.startsWith(`${engine} `)) line = other;
    }
    out.push(line.replace(/^(?:docker|podman) compose(?=\s|$)/, compose.trim()));
  }
  return out;
}

/** One substitution of the test: the page's words, what the test types instead, and why. */
export interface Rewrite {
  from: string;
  to: string;
  why: string;
}

/**
 * A command line with the test's substitutions made. Each rewrite that applied is counted in
 * `hits`, so the test can say when a page no longer has what a rewrite is for.
 */
export function rewrite(line: string, rewrites: Rewrite[], hits: Map<string, number>): string {
  let out = line;
  for (const r of rewrites) {
    if (!out.includes(r.from)) continue;
    out = out.split(r.from).join(r.to);
    hits.set(r.from, (hits.get(r.from) ?? 0) + 1);
  }
  return out;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The value a step gives a field, as the tutorials write it: **Label**: `value`,
 * **Label** at `value`, **Label** shows `value`, **Label**, type `value`, or **Label** at **value**.
 */
export function field(text: string, label: string): string {
  const l = reEscape(label);
  const m =
    new RegExp(`\\*\\*${l}\\*\\*(?::|,? type| at| shows) \`([^\`]+)\``).exec(text) ??
    new RegExp(`\\*\\*${l}\\*\\* at \\*\\*([^*]+)\\*\\*`).exec(text);
  if (!m?.[1]) throw new Error(`the step gives no value for **${label}**`);
  return m[1];
}

/** The first code span in the text that starts with these words: what the page quotes. */
export function quoted(text: string, start: string): string {
  for (const m of text.matchAll(/`([^`\n]+)`/g)) if (m[1]?.startsWith(start)) return m[1] as string;
  throw new Error(`the step quotes nothing that starts with ${JSON.stringify(start)}`);
}

/** The code spans just before ` at **label**` or ` to **label**`: "keep `a` and `b` at **X**". */
export function spansBefore(text: string, label: string): string[] {
  const m = new RegExp(
    `((?:\`[^\`]+\`(?:,? and |, )?)+) (?:at|to) \\*\\*${reEscape(label)}\\*\\*`,
  ).exec(text);
  if (!m?.[1]) throw new Error(`the step names nothing at **${label}**`);
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1] as string);
}

/** The code spans in a run right after these words: "one each for `a`, `b` and `c`". */
export function spansAfter(text: string, words: string): string[] {
  const m = new RegExp(`${reEscape(words)} ((?:\`[^\`]+\`(?:,? and |, )?)+)`).exec(text);
  if (!m?.[1]) throw new Error(`the step names nothing after ${JSON.stringify(words)}`);
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1] as string);
}

/** The bold words, when the text names them: "press **Run it**". */
export function named(text: string, words: string): string {
  if (!text.includes(`**${words}**`)) throw new Error(`the step does not name **${words}**`);
  return words;
}

/** The first bold words after these words: "In its first list, choose **OpenCode v2**." */
export function boldAfter(text: string, words: string): string {
  const m = new RegExp(`${reEscape(words)}[^*]*?\\*\\*([^*]+)\\*\\*`).exec(text);
  if (!m?.[1]) throw new Error(`the step has no bold words after ${JSON.stringify(words)}`);
  return m[1];
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  rsaquo: "›",
  hellip: "…",
};

/** HTML's character references, decoded. */
function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (/^#x/i.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return NAMED[e.toLowerCase()] ?? all;
  });
}

/**
 * A page's text as a reader sees it: tags out, entities decoded, white space as single spaces.
 * Words in bold, italics, code or a link run on with the words around them; any other tag
 * separates words, as the page's layout does.
 */
export function pageText(html: string): string {
  const bare = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:a|abbr|b|code|em|i|kbd|mark|small|strong|sub|sup|u)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return entities(bare).replace(/\s+/g, " ").trim();
}

/** The value of a choice card on the New campaign page, found by its title: "Hill climb". */
export function cardValue(html: string, group: string, title: string): string {
  const m = new RegExp(
    `data-group="${reEscape(group)}" data-value="([^"]+)"[^>]*>(?:(?!</div>)[\\s\\S])*?<b>${reEscape(title)}</b>`,
  ).exec(html);
  if (!m?.[1]) throw new Error(`the page has no ${group} card titled ${JSON.stringify(title)}`);
  return entities(m[1]);
}

/** A form on a dashboard page, as a browser would send it: its address and its fields. */
export interface PageForm {
  action: string;
  fields: Record<string, string>;
  /** Each select's options: their values by the words they show. */
  options: Record<string, Record<string, string>>;
}

/**
 * The form that holds a button with these words (and, when given, this text too), with its
 * hidden and filled-in fields and each select's chosen option. Enough for the dashboard's plain
 * forms; it does not run the page's scripts.
 */
export function formWith(html: string, button: string, holding?: string): PageForm {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const [, attrs = "", inner = ""] = m;
    const buttons = [...inner.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((b) =>
      pageText(b[1] ?? ""),
    );
    if (!buttons.includes(button) || (holding && !inner.includes(holding))) continue;
    const attr = (s: string, name: string) =>
      new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s)?.[1] ?? "";
    const fields: Record<string, string> = {};
    const options: Record<string, Record<string, string>> = {};
    for (const i of inner.matchAll(/<input\b([^>]*)>/g)) {
      const a = i[1] ?? "";
      const name = attr(a, "name");
      const type = attr(a, "type") || "text";
      const unchecked = (type === "checkbox" || type === "radio") && !/\schecked\b/.test(a);
      if (!name || type === "file" || unchecked) continue;
      fields[name] = entities(attr(a, "value"));
    }
    for (const s of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attr(s[1] ?? "", "name");
      if (!name) continue;
      const shown: Record<string, string> = {};
      let first: string | undefined;
      for (const o of (s[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
        const words = pageText(o[2] ?? "");
        // An option without a value sends its words.
        const value = /(?:^|\s)value="/.test(o[1] ?? "")
          ? entities(attr(o[1] ?? "", "value"))
          : words;
        shown[words] = value;
        first ??= value;
        if (/\sselected\b/.test(o[1] ?? "")) fields[name] = value;
      }
      options[name] = shown;
      if (!(name in fields) && first !== undefined) fields[name] = first;
    }
    return { action: entities(attr(attrs, "action")), fields, options };
  }
  throw new Error(
    `the page has no form with a ${JSON.stringify(button)} button${holding ? ` and ${JSON.stringify(holding)}` : ""}`,
  );
}

// ---------------------------------------------------------------- what the acceptance reads

/** The pages the quick start goes through, under docs/_site/src/content/docs/. */
export const PAGES = {
  firstRun: "tutorials/first-run.md",
  agents: "tutorials/agents-with-a-free-model.md",
  install: "how-to/install/one-machine.md",
  troubleshoot: "how-to/operate/troubleshoot.md",
} as const;

/**
 * Everything the acceptance takes from the pages: the commands it runs (as the pages write them,
 * before commandsFor and the rewrites), the values it types, the buttons it presses and the words
 * it expects to see. Each field says where it comes from.
 */
export interface QuickStartPlan {
  /** The repository's web address, from the release download: https://github.com/owner/thermite. */
  repo: string;
  firstRun: {
    /** 1. Get Thermite: make the folder and download the compose file. */
    get: string[];
    /** The compose file's first line, as the page quotes it: `# Thermite 0.1.0`. */
    firstLine: string;
    /** 2. Make your local tokens: the init command, and the last line it prints. */
    init: string[];
    initDone: string;
    /** 3. Start Thermite: each shell block in order, and the services `ps` shows as Up. */
    start: string[][];
    services: string[];
    /** 4. Sign in: show the token, the dashboard's address, its form, and Overview's first line. */
    token: string[];
    dashboard: string;
    tokenLabel: string;
    signIn: string;
    overview: string;
    /** 5. Meet your rig: its name, and the words that say it is live. */
    rig: string;
    live: string;
    /** 6. Run the judge's smoke check: the check, its button, its result and its campaign. */
    smokeCheck: string;
    runIt: string;
    smokePassed: string;
    smokeCampaign: string;
    /** 7. See what the judge decided: each outcome's count under How the judge decided. */
    verdicts: Record<string, number>;
    /** 8. Stop or keep Thermite: stop it. */
    down: string[];
  };
  agents: {
    /** 1. Add a model provider: the provider's name, the button, and the words it says. */
    providerName: string;
    addProvider: string;
    providerSaved: string;
    /** 2. Give the rig a model: the row's words before, the worker harness, and the button. */
    noModel: string;
    harness: string;
    use: string;
    /** 3. Check that the model works: words of the passed check. */
    modelPassed: string[];
    /** 4. Get the sample and pack its kit: the commands, the release tag and the archive. */
    source: string[];
    tag: string;
    kitArchive: string;
    /** 5. Name the campaign. */
    mode: string;
    campaign: string;
    title: string;
    /** 6. Point it at the sample. */
    repository: string;
    startFrom: string;
    folder: string;
    access: string;
    lookUp: string;
    /** How many files Look it up finds in the folder. */
    folderFiles: number;
    editable: string;
    forbidden: string[];
    /** 7. Upload the kit: the card, the field, the summary and how each case and the score are used. */
    kitCard: string;
    kitField: string;
    kitSummary: string;
    measured: string[];
    hidden: string[];
    score: string;
    better: string;
    minEffectPercent: number;
    /** 8. Start the campaign. */
    lanes: number;
    startButton: string;
    starting: string;
    /** 11. Pause the campaign: the button, the reason typed and the words the run then shows. */
    pause: string;
    pauseReason: string;
    paused: string;
    /** The New campaign page's labels these steps name. */
    formLabels: string[];
  };
  /** The command line, built in the source folder: the lines after `cd thermite-source`. */
  commandLine: string[];
  /** Check the machine: the doctor's command, and its last line when nothing failed. */
  doctor: string[];
  doctorOk: string;
}

/** The lines of a step's shell blocks, in order. */
const shell = (s: Step) => blocks(s, "sh").flatMap((b) => b.lines);
/** The first line that matches, from the lines given. */
function lineWith(lines: string[], pattern: RegExp, what: string): string {
  const line = lines.find((l) => pattern.test(l));
  if (!line) throw new Error(`no command ${what}`);
  return line;
}
/** The first code span after these words: "sums the kit up: `…`". */
function spanAfter(text: string, words: string): string {
  const m = new RegExp(`${reEscape(words)}\\s*\`([^\`]+)\``).exec(text);
  if (!m?.[1]) throw new Error(`the step quotes nothing after ${JSON.stringify(words)}`);
  return m[1];
}

/** Reads the plan from the pages. `read` gives a page's Markdown by its path under PAGES. */
export function quickStartPlan(read: (page: string) => string): QuickStartPlan {
  const first = pageSteps(read(PAGES.firstRun));
  const agents = pageSteps(read(PAGES.agents));
  const install = pageSteps(read(PAGES.install), 3);
  const trouble = pageSteps(read(PAGES.troubleshoot));
  const f = (n: number) => step(first, n, PAGES.firstRun);
  const a = (n: number) => step(agents, n, PAGES.agents);

  const get = shell(f(1));
  const download = lineWith(get, /\/releases\/latest\/download\/compose\.yaml/, "downloads");
  const repo = /(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/releases\//.exec(download)?.[1];
  if (!repo) throw new Error(`step 1 downloads from no GitHub repository: ${download}`);

  const s4 = f(4);
  const dashboard = /<(http:\/\/127\.0\.0\.1:\d+)\/ui>/.exec(s4.text)?.[1];
  if (!dashboard) throw new Error("step 4 gives no dashboard address on 127.0.0.1");
  const s5 = f(5);
  const rig = boldAfter(s5.text, "in the sidebar, then");
  const decided = f(7)
    .text.split(/\n\s*\n/)
    .find((p) => p.includes("**How the judge decided**"));
  if (!decided)
    throw new Error("step 7 does not count the verdicts under **How the judge decided**");
  const verdicts: Record<string, number> = {};
  for (const m of decided.matchAll(/`([a-z][a-z0-9 ]*?) (\d+)`/g))
    verdicts[m[1] as string] = Number(m[2]);
  if (!Object.keys(verdicts).length) throw new Error("step 7 counts no verdicts");

  const s1 = a(1);
  const providerName = field(s1.text, "Name");
  const s4a = a(4);
  const source = shell(s4a);
  const clone = lineWith(source, /^git clone --branch /, "clones the source");
  const tag = /--branch (\S+)/.exec(clone)?.[1] ?? "";
  const pack = lineWith(source, /^tar -czf /, "packs the kit");
  const kitArchive = /-czf (\S+)/.exec(pack)?.[1] ?? "";
  const s6 = a(6);
  const found = /(\d+) files? in (\S+?)\. /.exec(quoted(s6.text, "· "));
  const folder = field(s6.text, "Folder in the repository");
  if (!found || found[2] !== folder)
    throw new Error("step 6's Look it up does not count the files of the folder it names");
  const forbidden = blocks(s6, "text")[0]?.lines.filter((l) => l.trim()) ?? [];
  const s7 = a(7);
  const s8 = a(8);
  const s11 = a(11);
  const percent = Number(field(s7.text, "Smallest gain that counts (%)"));
  if (!Number.isFinite(percent)) throw new Error("step 7's smallest gain is not a number");
  const lanes = Number(field(s8.text, "Agents working at once"));
  if (!Number.isInteger(lanes)) throw new Error("step 8's agents working at once is not a number");

  const lines = step(install, "The command line", PAGES.install);
  const cmd = shell(lines);
  const at = cmd.indexOf("cd thermite-source");
  if (at < 0)
    throw new Error(`${PAGES.install}: The command line does not cd into thermite-source`);
  const machine = step(trouble, "Check the machine", PAGES.troubleshoot);
  const doctor = shell(machine);
  lineWith(doctor, /thermite doctor .*--model-url /, "runs thermite doctor with --model-url");

  return {
    repo,
    firstRun: {
      get,
      firstLine: quoted(f(1).text, "# Thermite "),
      init: shell(f(2)),
      initDone: quoted(f(2).text, "local init:"),
      start: blocks(f(3), "sh").map((b) => b.lines),
      services: spansAfter(f(3).text, "one each for"),
      token: shell(s4),
      dashboard,
      tokenLabel: named(s4.text, "Admin token"),
      signIn: named(s4.text, "Sign in"),
      overview: quoted(s4.text, "nothing needs you"),
      rig,
      live: quoted(s5.text, `${rig} is live`).split(";")[0] as string,
      smokeCheck: named(f(6).text, "Judge smoke"),
      runIt: named(f(6).text, "Run it"),
      smokePassed: quoted(f(6).text, "smoke on ").split(" (run")[0] as string,
      smokeCampaign: quoted(f(6).text, "rig-check-").split(" ")[0] as string,
      verdicts,
      down: shell(f(8)),
    },
    agents: {
      providerName,
      addProvider: named(s1.text, "Add and list its models"),
      providerSaved: quoted(s1.text, `"${providerName}" is saved`),
      noModel: quoted(a(2).text, "Its agents have no model"),
      harness: boldAfter(a(2).text, "In its first list, choose"),
      use: named(a(2).text, "Use"),
      modelPassed: [quoted(a(3).text, "answered with a correct tool call"), quoted(a(3).text, "(")],
      source,
      tag,
      kitArchive,
      mode: boldAfter(a(5).text, "Keep"),
      campaign: field(a(5).text, "Campaign name"),
      title: field(a(5).text, "Title"),
      repository: field(s6.text, "Repository"),
      startFrom: field(s6.text, "Start from"),
      folder,
      access: boldAfter(s6.text, "**Repository access**: keep"),
      lookUp: named(s6.text, "Look it up"),
      folderFiles: Number(found[1]),
      editable: field(s6.text, "Files the agents may change"),
      forbidden,
      kitCard: boldAfter(s7.text, "Choose the card"),
      kitField: named(s7.text, "Kit archive"),
      kitSummary: spanAfter(s7.text, "sums the kit up:"),
      measured: spansBefore(s7.text, "Measured"),
      hidden: spansBefore(s7.text, "Hidden test"),
      score: field(s7.text, "The score"),
      better: field(s7.text, "Better is"),
      minEffectPercent: percent,
      lanes,
      startButton: named(s8.text, "Start the campaign"),
      starting: quoted(s8.text, "Starting "),
      pause: named(s11.text, "Pause the run"),
      pauseReason: field(s11.text, "why (optional)"),
      paused: quoted(s11.text, "This run is paused:"),
      formLabels: [
        "Campaign name",
        "Title",
        "Repository",
        "Start from",
        "Folder in the repository",
        "Repository access",
        "Files the agents may change",
        "Lines never allowed",
        "Agents working at once",
      ].map((label) => named(`${a(5).text}${s6.text}${s8.text}`, label)),
    },
    commandLine: cmd.slice(at + 1),
    doctor,
    doctorOk: quoted(machine.text, "No check failed."),
  };
}
