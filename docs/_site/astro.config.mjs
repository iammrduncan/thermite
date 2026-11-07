// @ts-check
// Thermite's documentation site. Pages live in src/content/docs/, one Diátaxis type each
// (src/content.config.ts). `npm run docs:build` at the repository root builds it into
// .dev/site/, and `npm run docs:check` checks what the build cannot.
import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";
import { fathom } from "./src/analytics.mjs";
import { fields as useCaseFields } from "./src/data/use-cases.mjs";
import { pageIndex } from "./src/page-index.mjs";
import { remarkRelativeLinks } from "./src/plugins/remark-relative-links.mjs";

const site = "https://usethermite.com";
const base = "/";
const repo = "https://github.com/iammrduncan/thermite";
// The version of Thermite the pages describe, shown beside the title: the root package.json's.
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export default defineConfig({
  site,
  base,
  outDir: "../../.dev/site",
  devToolbar: { enabled: false },
  vite: {
    // Mermaid is one large script, loaded only on pages with a diagram.
    build: { chunkSizeWarningLimit: 4096 },
    define: { __THERMITE_VERSION__: JSON.stringify(version) },
  },
  markdown: {
    // Pages link to each other with relative `.md` paths, so the links also work on GitHub and
    // in the Markdown copies. This turns them into site addresses.
    remarkPlugins: [[remarkRelativeLinks, { base }]],
  },
  // The roadmap page became the changelog: its old address leads there.
  redirects: { "/project/roadmap/": "/project/changelog/" },
  integrations: [
    // astro-mermaid must come before Starlight.
    mermaid({ theme: "neutral", autoTheme: true }),
    starlight({
      title: "Thermite",
      description:
        "Thermite runs research campaigns with AI agents. Agents propose changes; code they cannot touch measures them, judges them and keeps the best.",
      logo: { src: "./src/assets/logo.svg", alt: "Thermite" },
      favicon: "/favicon.svg",
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      head: [
        // Beside the SVG favicon: an ICO for browsers that take no SVG (Safari among them), and
        // the icon iOS shows for a saved page.
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "32x32" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        // Fathom Analytics (src/analytics.mjs).
        { tag: "script", attrs: fathom },
      ],
      social: [
        { icon: "github", label: "GitHub", href: repo },
        { icon: "discord", label: "Discord", href: "https://discord.gg/3Qs2uejUf9" },
      ],
      editLink: { baseUrl: `${repo}/edit/main/docs/_site/` },
      lastUpdated: true,
      customCss: ["./src/styles/custom.css"],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        // The first experience: install on one machine, a first campaign, a second machine.
        {
          label: "Get started",
          items: [
            { label: "1 · Install on one machine", link: "/tutorials/first-run/" },
            { label: "2 · Run your first campaign", link: "/tutorials/agents-with-a-free-model/" },
            { label: "3 · Add a second machine", link: "/tutorials/second-machine/" },
            { label: "4 · Tailscale / WireGuard", link: "/how-to/install/private-network/" },
          ],
        },
        { label: "Start here", link: "/start-here/" },
        // What Thermite can be used for, and what it has done: each overview is one of the site's own
        // pages (src/pages/), and the full pages are here. The use cases are grouped by field, from
        // the list the overview reads too.
        {
          label: "Use cases",
          items: [
            { label: "Overview", link: "/use-cases/" },
            { label: "Who it's for", items: [{ autogenerate: { directory: "use-cases/for" } }] },
            ...useCaseFields.map((f) => ({
              label: f.label,
              collapsed: true,
              items: [{ autogenerate: { directory: `use-cases/${f.key}` } }],
            })),
          ],
        },
        {
          label: "Studies",
          items: [{ label: "Overview", link: "/studies/" }, { autogenerate: { directory: "studies" } }],
        },
        { label: "Compare", items: [{ autogenerate: { directory: "compare" } }] },
        {
          label: "Tutorials",
          items: ["tutorials/first-goal-campaign", "tutorials/your-own-project"],
        },
        {
          label: "How-to guides",
          items: [
            { label: "Install and rigs", items: [{ autogenerate: { directory: "how-to/install" } }] },
            { label: "Models", items: [{ autogenerate: { directory: "how-to/models" } }] },
            {
              label: "Campaigns and kits",
              items: [{ autogenerate: { directory: "how-to/campaigns" } }],
            },
            { label: "Operate", items: [{ autogenerate: { directory: "how-to/operate" } }] },
            { label: "Automate", items: [{ autogenerate: { directory: "how-to/automate" } }] },
          ],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Explanation",
          collapsed: true,
          items: [{ autogenerate: { directory: "explanation" } }],
        },
        { label: "Project", collapsed: true, items: [{ autogenerate: { directory: "project" } }] },
      ],
      plugins: [
        starlightLinksValidator({
          // Relative links are turned into site addresses before the validator sees them.
          errorOnRelativeLinks: false,
          // Tutorials link to the dashboard on the reader's own computer.
          errorOnLocalLinks: false,
          // The site's own pages (src/pages/) are not Starlight's, so the validator can't see them.
          exclude: ["/", "/use-cases/", "/studies/"],
        }),
        starlightLlmsTxt({
          projectName: "Thermite",
          exclude: ["404"],
          description:
            "Thermite is an autoresearch harness. AI agents propose changes to a project; a judge the agents cannot touch measures each change and keeps the best. Many campaigns run at once on a fleet of rigs, and one control service shows and steers all of them.",
          details: pageIndex({ site, base }),
          customSets: [
            {
              label: "Use cases",
              paths: ["use-cases/**"],
              description:
                "what Thermite can be used for, by field (software, AI, science, healthcare, agriculture, energy, operations, robotics, finance), and who it is for",
            },
            {
              label: "Studies",
              paths: ["studies/**"],
              description: "campaigns Thermite has run, with their measured results",
            },
            {
              label: "Compare",
              paths: ["compare/**"],
              description: "how Thermite differs from other autoresearch tools, and where each fits",
            },
            {
              label: "Tutorials",
              paths: ["tutorials/**"],
              description: "learn Thermite by doing, one path each",
            },
            {
              label: "How-to guides",
              paths: ["how-to/**"],
              description: "the steps for one task each",
            },
            {
              label: "Reference",
              paths: ["reference/**"],
              description: "settings, files, commands, the API and MCP, described completely",
            },
            {
              label: "Explanation",
              paths: ["explanation/**"],
              description: "how Thermite works, and why",
            },
          ],
          optionalLinks: [
            {
              label: "Roadmap",
              url: `${repo}/blob/main/docs/plan/roadmap.md`,
              description: "what is planned, by version",
            },
          ],
        }),
      ],
    }),
  ],
});
