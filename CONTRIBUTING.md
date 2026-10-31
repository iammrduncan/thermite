# Contributing to Thermite

Thank you for helping. Fixes, documentation, kits, bug reports and ideas are all welcome. This file has the essentials. The [Contributing page](docs/_site/src/content/docs/project/contributing.md) of the documentation explains each part, and the [contributor guide](docs/local-development.md) has every check and test.

## The terms

- Thermite is under the [MIT license](LICENSE). What you contribute is published under it.
- There is no contributor agreement to sign, and no sign-off line to add to your commits.
- Everyone in the project follows the [code of conduct](CODE_OF_CONDUCT.md), the Contributor Covenant 2.1.

## Before you start

- **A security problem?** Report it privately, as [SECURITY.md](SECURITY.md) says. Never in a public issue.
- **A bug?** Open an [issue](https://github.com/iammrduncan/thermite/issues/new/choose) with the bug report form. It asks for your system, the rig's check results and the logs.
- **A large change or a new idea?** Say what you plan in an issue or on [Discord](https://discord.gg/3Qs2uejUf9) first, so that it fits the [roadmap](docs/plan/roadmap.md). Each planned piece of work is a goal in [docs/plan/](docs/plan/README.md).
- **A new screen, or a real change to one?** Show a mockup in an issue first. The maintainers agree to the screen before it is built.

## Send a change

1. Fork the repository, and make a branch in your fork.
2. Set up your copy. You need Node.js 22.19 or later (22.22 or later to build the documentation site), git, and Docker or Podman:

   ```sh
   npm ci
   npm run check
   ```

3. Make the change in small commits. Each message says what the commit does.
4. Update the documentation in the same pull request: every page that describes what you changed, such as screens and their text, commands, settings, routes, events, errors and limits. [Writing the documentation](docs/writing-docs.md) says how. When the change draws on outside work, such as a paper, a system you studied, or a new dependency or bundled program, add it to [CREDITS.md](CREDITS.md) with its licence, and run `npm run docs:credits`.
5. Run the checks below, then open a pull request. Its form asks what the change does and why, which checks you ran, and which pages you changed.

## The checks

Run these from the repository root before each commit:

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | The TypeScript types |
| `npm run lint` | Style and common mistakes, with Biome. `npm run format` fixes what it can |
| `node scripts/test.mjs <files>` | The test files that your change touches |
| `npm run check:public` | That no tracked or staged file holds private names or addresses. Stage new files first |
| `npm run check:sizes` | That no file over 800 lines grows, and no file newly passes 800 lines. After a split, `npm run check:sizes -- --lower` lowers its recorded size |
| `npm run check:imports` | That no new import breaks the rule of the parts in CONVENTIONS.md, and that code outside a folder that is a module imports its `index.ts`. After a move, `npm run check:imports -- --lower` drops the exceptions that are gone |
| `npm run docs:build` and `npm run docs:check` | The documentation site, when you change it or anything that a page describes. Run `npm run docs:install` once first |

`npm run check` runs the typecheck, the lint, every test, the public check, the size check and the import check. Changes to containers, the judge, control or the agents also need a test that starts containers: the [contributor guide](docs/local-development.md) and [AGENTS.md](AGENTS.md#checks) say which.

## The rules every change keeps

- **Agents propose; code judges.** Nothing that an agent can write reaches a measurement, a verdict, completion or a promotion. [CONVENTIONS.md](CONVENTIONS.md) lists this rule and the others that every review checks.
- **No default caps.** Nothing ends or cuts research short by default: no turn, submission, failure, time or spending limit unless someone sets it.
- **The repository is public, and so are commit messages.** Never put in them machine, host or cluster names, IP or MAC addresses, internal domains, account or secret names, secret values, private repository paths, or descriptions of a deployment's security gaps. Use made-up names, such as `gpu-host-1` and `control.example.com`. `npm run check:public` finds most slips in files, but not in commit messages.
- **Pages describe only what exists.** A planned feature gets one line and a link to its goal.

If you work with a coding agent, it reads [AGENTS.md](AGENTS.md), which holds the same rules.
