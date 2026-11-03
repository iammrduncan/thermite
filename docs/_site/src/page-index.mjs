// The page list for llms.txt: every page with its Markdown copy's address and its description,
// grouped like the sidebar. It reads each page's front matter, which keeps `title`, `description`
// and `sidebar.order` on one line each (`npm run docs:check` makes sure).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fields } from "./data/use-cases.mjs";

const docsRoot = fileURLToPath(new URL("./content/docs/", import.meta.url));

const sections = [
  { dir: "", label: "Start" },
  { dir: "use-cases/for", label: "Use cases: who Thermite is for" },
  ...fields.map((f) => ({ dir: `use-cases/${f.key}`, label: `Use cases: ${f.label}` })),
  { dir: "studies", label: "Studies: what Thermite has done" },
  { dir: "tutorials", label: "Tutorials: learn by doing" },
  { dir: "how-to/install", label: "How-to guides: install and rigs" },
  { dir: "how-to/models", label: "How-to guides: models" },
  { dir: "how-to/campaigns", label: "How-to guides: campaigns and kits" },
  { dir: "how-to/operate", label: "How-to guides: operate" },
  { dir: "how-to/automate", label: "How-to guides: automate" },
  { dir: "reference", label: "Reference" },
  { dir: "explanation", label: "Explanation: how it works, and why" },
  { dir: "project", label: "Project" },
];

/** @param {string} text */
function frontMatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  /** @param {RegExp} pattern */
  const field = (pattern) => {
    const value = pattern.exec(block)?.[1]?.trim() ?? "";
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    return value;
  };
  return {
    title: field(/^title:\s*(.+)$/m),
    description: field(/^description:\s*(.+)$/m),
    order: Number(field(/^\s+order:\s*(\d+)\s*$/m) || 999),
  };
}

/** @param {{ site: string, base: string }} options */
export function pageIndex({ site, base }) {
  const root = `${site}${base.replace(/\/$/, "")}`;
  const lines = [
    "Every page below is also published as Markdown: its address is the page's address with `.md` at the end, as in these links.",
  ];
  for (const { dir, label } of sections) {
    const folder = path.join(docsRoot, dir);
    if (!fs.existsSync(folder)) continue;
    const pages = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name) && entry.name !== "404.md")
      .map((entry) => {
        // A folder's index page lives at the folder's address, as Starlight serves it.
        const slug = path.posix.join(dir, entry.name.replace(/\.mdx?$/, "")).replace(/\/index$/, "");
        return { slug, ...frontMatter(fs.readFileSync(path.join(folder, entry.name), "utf8")) };
      })
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    if (pages.length === 0) continue;
    lines.push("", `**${label}**`, "");
    for (const page of pages) {
      lines.push(`- [${page.title}](${root}/${page.slug}.md): ${page.description}`);
    }
  }
  return lines.join("\n");
}
