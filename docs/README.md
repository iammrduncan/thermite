# Thermite documentation

Thermite is an autoresearch harness. Agents propose changes, and code they cannot touch measures, judges and keeps the best results. Many research campaigns run at once across a fleet of machines, and one control service shows and steers all of them.

**Status:** v0.1.0, the first public release, is out. Work goes on toward v0.1.1; the [plan](plan/README.md) says what comes next.

## The documentation site

The documentation is a website at [usethermite.com](https://usethermite.com), built from [`_site/`](_site/src/content/docs/index.mdx). Every page is a Markdown file, so you can also read it here on GitHub. It follows [Diátaxis](https://diataxis.fr/):

| Section | Start with | For |
| --- | --- | --- |
| [Start here](_site/src/content/docs/start-here.md) | | Finding your path |
| [Tutorials](_site/src/content/docs/tutorials/) | [Install on one machine](_site/src/content/docs/tutorials/first-run.md) | Learning by doing |
| [How-to guides](_site/src/content/docs/how-to/) | [The one-machine stack](_site/src/content/docs/how-to/install/one-machine.md) | Doing one task |
| [Reference](_site/src/content/docs/reference/) | [Settings](_site/src/content/docs/reference/settings.md) | Looking things up |
| [Explanation](_site/src/content/docs/explanation/) | [What Thermite is](_site/src/content/docs/explanation/what-thermite-is.md) | Understanding how and why |

Agents can read the whole site through `llms.txt` and `llms-full.txt` at the site's root.

## In this folder

| Page | What it covers |
| --- | --- |
| [Writing the documentation](writing-docs.md) | How the site is built and checked, and the rules every page follows |
| [Contributor guide](local-development.md) | For people working on Thermite: the checks, the compose stack, the dashboard demo and the acceptance tests. [CONTRIBUTING.md](../CONTRIBUTING.md) has the essentials |
| [How Thermite is planned](plan/README.md) | The roadmap, the release plan, the settled decisions, and a goal for each roadmap item |
