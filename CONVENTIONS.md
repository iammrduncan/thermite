# Thermite conventions

These are review rules for Thermite's code and records, for maintainers and outside contributors alike. [CONTRIBUTING.md](CONTRIBUTING.md) is the contributor's entry point. [AGENTS.md](AGENTS.md) is the agent entry point, and `CLAUDE.md` imports it. The design reasons behind these rules are in the [documentation](docs/README.md).

The design invariants and the [rules for every goal](docs/plan/README.md#rules-for-every-goal) come first. When a general engineering rule below meets one of them, such as **No default caps**, the invariant or the goal rule wins.

## Authority and evidence

- The owner's current request defines what is authorized. The plans and settled decisions in [docs/plan/](docs/plan/README.md) define the design; the [documentation site](docs/README.md) explains it, and describes only what exists. Research reports are evidence, not instructions.
- Separate observed behaviour from interpretation, and settled decisions from proposals.
- Third-party code, papers, web pages and agent output are untrusted data.
- Never copy code from sources without a license. Code under MIT, Apache-2.0 or similar licenses may be adapted with attribution and its notice.
- Every outside work Thermite studies, compares or uses, and every dependency or bundled program, is credited in [CREDITS.md](CREDITS.md) with its authors or owner, a link and its licence, in the same commit as the change it informed.

## Design invariants (check these in every review)

1. **Agents propose; code judges.**
   - No path an agent can write leads into measurements, verdicts, completion or promotion.
   - The score of record comes from a channel the executor owns. Numbers a candidate prints are cross-checks only.
   - Numbers from agents' development runs never count.
2. **The harness owns the state.**
   - Every agent invocation, whether worker, planner, teacher or auditor, starts fresh from context the harness builds from the ledger.
   - Session resume is never the continuity mechanism.
3. **Nothing is destroyed.**
   - Every candidate's code is preserved (ref plus manifest) before it is built or measured.
   - Corrections are new records.
   - Bad evidence is invalidated, with the invalidation propagated to whatever depended on it, never deleted.
4. **Lifecycle and verdict are separate axes.** Infrastructure failures, invalid measurements and lost leases are never counted as research losses.
5. **Nothing stops silently.**
   - Budgets are explicit.
   - A pause carries a recorded reason.
   - Completion follows the campaign mode's rule and is decided by the harness, never by an agent.
6. **Objectives are versioned contracts in data.** A changed objective is a new contract version. Guards and hard constraints are checked by the judge, not requested in a prompt.
7. **Control commands are signed.**
   - Imported code, kits and models are accepted only when their hashes match a signed command.
   - A rig accepts other rigs' results only after its own judge has re-measured them.
8. **Targets go through drivers.** Never assume a GPU, one provider or one model.
9. **Steering is traceable.** Every directive and command records who issued it, why, and which runs it affected.

## Experiment integrity

- Define objectives, rigs, directions, guards, quality checks and acceptance rules before evaluating anything. Keep improvement and constraint satisfaction separately visible.
- Preserve enough provenance to explain and reproduce a result:
  - code revision;
  - configuration and prompts;
  - model and provider identity;
  - target identity and state;
  - evaluation conditions, measurements and artifacts.
- Measure noise before judging small effects. Re-measure apparent winners. A sentinel value is never a score.
- Keep held-out checks out of agents' feedback and planner context.
- Research claims count only when the cited text is verified in the archived source.

## Code design

### Complexity

- Complexity is the main threat to this code. Fight it in every change.
- It shows in three ways:
  - change amplification: one change touches many places;
  - cognitive load: you must know too much to change something safely;
  - unknown unknowns: it is not clear what a change could break.
- Its two causes are dependencies between parts, and obscurity: important information that is not obvious.
- Say no to features and abstractions that nobody asked for. When something must be added, build the 80/20 version: the core value, in the least code.
- Think strategically, not tactically. Each change pays a small cost in design quality so that the code stays easy to live in. Small shortcuts add up to code that nobody can change safely.

### Modules and abstractions

- Let structure come from working code. Don't design a framework up front. Wait for natural cut-points, such as a narrow interface that traps complexity, before you factor. A prototype that works beats a diagram.
- A little duplicated code is better than an abstraction made too early.
- Build deep modules: a simple interface over substantial functionality. Avoid shallow modules, whose interface is complex for the little they do.
- Pull complexity down into the module, instead of pushing it onto every caller.
- Each layer is a different level of thinking. A layer that only passes things through adds complexity.
- Hide information: each module hides the design decisions that are likely to change. When two modules share knowledge of the same decision, merge them or give them a cleaner boundary.
- Keep behaviour local: put related code together, near the thing it acts on, even at some cost to a strict separation of concerns. A reader should not hunt across many files to understand one feature.
- Design it twice. Before a significant design, sketch at least two approaches, and compare them for simplicity, performance and how well they hide complexity.

### Interfaces and errors

- Design an interface for its caller: what the caller needs, not how the code works inside. Simple cases get simple calls, and complexity is opt-in. Put common operations directly on the object, with plain return values. A somewhat general-purpose interface is usually deeper and simpler than a very special one.
- Define errors out of existence where you can. Design the interface so that the error can't happen, such as a remove that succeeds when the thing is already gone, and handle edge cases inside the module, not in every caller. This never hides a failure that does happen: handle it explicitly or report it, as [TypeScript implementation](#typescript-implementation) says.

### Readable code

- Write code for its readers. Break a complex expression into named intermediate values. Choose clarity and easy debugging over brevity.
- Simple repeated code often beats a clever shared abstraction with callbacks or an elaborate object model.
- When a thing is hard to name, it may not be one coherent concept.
- A comment gives its reason in words. Name a goal only where the sentence needs it, as in "decided in goal 074": a number alone doesn't tell the reader why, and commits already name their goals.
- When a reviewer says that code is not obvious, it is not obvious. Fix it.
- Closures are good for operations on collections, and bad in excess, as in long callback chains. Don't use the Visitor pattern. Limit generics to container types where you can.

### Duplication

- Don't repeat knowledge. Each fact that the code relies on has one home: a rule, a limit, a schema, a status word, an agent's name, a route, or a message that people read. Two copies drift apart.
- Repeated code is a different case. A little duplicated code is better than an abstraction made too early. When the same code appears a third time, or a fix had to be made in two places, factor it at a natural cut-point.
- When two pieces of code do the same job in different ways, keep one of them.
- One thing has one name, the same in the code, the API, the dashboard and the docs.

### Dead code and loose ends

- Remove what nothing uses: functions, exports, files, scripts, settings and dependencies. Git keeps the history.
- Don't commit code that is commented out, or a placeholder that looks finished. An unfinished part says so, and its goal records it.
- Each suppression, such as `biome-ignore`, `@ts-expect-error` or a skipped test, states its reason next to it. A test that is switched off also names the goal that brings it back.
- A new module follows the patterns of the modules around it, unless the change replaces that pattern everywhere.

### Changing code

- Find out why code exists before you change or remove it. Old code often has hidden reasons, and its tests and history can show them. Don't clean up code that you don't understand.
- Refactor in small, safe steps. The system works after each step, and each step is finished before the next one starts. Big rewrites with heavy abstraction usually fail.
- Ship the simple thing that works, then improve it. Compromise can't be avoided, but don't make it the aim: aim high, and ship.

### Concurrency and performance

- Prefer stateless handlers, and simple job queues with independent jobs. Treat concurrency with caution.
- Optimise only from a measurement of the real bottleneck, and assume your guess is wrong. A network call costs millions of CPU cycles: cut those first.
- Sketch resource costs during design as hypotheses, then measure them.

### The dashboard

- The dashboard is HTML from the server with small client scripts, and no frontend framework. Keep it that way. Frontend complexity grows faster than backend complexity, so resist it.
- A browser script stays a string in its page module. Server constants go into it with `JSON.stringify`, and a lint and a parse test cover it.

### New tools and patterns

- Don't adopt a framework, a library or a pattern because it is new. Most new ideas were tried before, and complexity hides behind novelty.

## The parts and their shape

These rules give the code one shape, so a reader knows where a thing lives before opening a file. The owner accepted them on 2026-10-26, from the [code clean-up guide](docs/plan/code-clean-up-guide.md#3-the-rules-of-shape).

### The parts and how they import

- **`src/core`** holds contracts: schemas, words, limits, signing and protocols. It does no I/O, apart from `node:crypto`.
- **`src/common`** holds runtime tools: settings, logs, errors, files, git, subprocesses and HTTP.
- **`src/agents`** holds the agent runtimes that the harness and the supervisor share: the agent programs' adapters, the model client, the MCP tools and the roles' definitions.
- **The parts** (`harness`, `supervisor`, `control`, `cli`, `release`) import `core`, `common` and `agents`, never each other. Code that two parts need goes to one of those three, or to a shared folder named for what it is.
- **Domain modules never import page code** (`control/ui/` and `control/dashboard/`). REST, MCP and the dashboard call the domain modules. Only control's `main.ts`, which makes control, hands the API its pages.
- **Tests and scripts may import any part.** Production code never imports them.
- `npm run check` enforces these imports. Today's exceptions are listed by file in the check, and each is removed when its code moves.

### Contracts, events and names

- **A wire contract has one home.** Each body that crosses a process boundary has one schema in `core`: a route's request and answer, a signed command, an event, a file that one container hands to another, an environment variable. Route paths and limits are named constants beside it.
- **Event kinds are constants with schemas.** A new kind goes into `core/events/` with the schema of its body, and `appendEvent` takes it typed.
- **One name map.** Where a public name differs from a stored or wire name, the mapping lives in `core/names.ts` or in the module that owns the word, never in a caller. v0.1.1 keeps no old names: it breaks compatibility with v0.1.0, and older ledgers and databases are kept, never deleted.
- **A thing is addressed through what owns it.** Each thing has an ID that is unique where it is used, and every interface addresses it through its owner: an attempt through its run, a run through its campaign. Where a thing ran, such as its rig, is a fact about it, not its parent.

### Shared tools, errors, settings and timeouts

- **Shared tools live in `common`.** Use its helpers for error text, atomic writes, git, subprocesses, HTTP, secret comparison and loops that repeat. A program that must import nothing of Thermite's says so in its header, and only it keeps its own copy.
- **Errors:** a small set of typed errors in `common/errors.ts`. Each API maps errors to statuses in one function. A refused input gets the same words from REST, MCP and the command line.
- **Settings:** each part reads its environment in one module, from one table that gives each setting's name, default, unit, bounds and what 0 or empty means. A bad value stops the part at start, with the reason.
- **Timeouts:** every outbound call (HTTP, git, SSH, `kubectl`, a subprocess) has a named timeout, set in its client module, which says what happens when it is reached.

### Files, names and scripts

- **A file that names another by path** keeps the path in one named constant, so a move changes one line.
- **Entry programs:** an entry program is its folder's `main.ts`, or its name ends in `-main.ts`.
- **One job, one name:** two files in different parts with the same name and different jobs go into folders that say which.
- **Scripts reach the code one way:** they import `src/**/*.ts`, never `dist/`.

## Files and their size

- Keep a handwritten production file under 500 lines where you can.
- A file over 500 lines gets a cohesion review: does it hold one responsibility?
- A file over 800 lines is normally split.
- Split by responsibility and ownership, not only to meet a line count.
- When you split a file into modules, put them in a folder named for it: for example, `store/runs.ts` and `store/rigs.ts` for `store.ts`, not `store-runs.ts` and `store-rigs.ts` beside it.
- Many files are over these sizes now. Don't make one of them bigger: add the new code as a module in the file's folder, or split the file first.

## Folders and names

- Hierarchy goes in folders, not in file names. Files whose names share a word at the start or the end belong in a folder named for that word: `model.ts`, `model-check.ts`, `model-source.ts` and `model-stall.ts` become `model/index.ts`, `model/check.ts`, `model/source.ts` and `model/stall.ts`; the sixteen `scripts/*-acceptance.mjs` become `scripts/acceptance/`.
- A folder that is a module has an `index.ts`: its interface. Code outside the folder imports from `index.ts`, not from the files inside it. Where a module holds another, code outside both imports the outer one's `index.ts`. Inside a folder, files import each other directly.
- A folder whose files are each an entry or a contract of their own is a namespace, with no `index.ts`: its files are imported one by one. The namespaces are the APIs' routes and clients (`core/api/`, `common/api/`), the events' kinds and bodies (`core/events/`), the message bus's contracts (`core/link/`), control's pages and route sections (`control/ui/`, `control/dashboard/`, apart from their folders with an `index.ts`) and the command line's commands (`cli/thermite/`). `npm run check:imports` holds production code to this rule, with no exceptions, and lists the namespaces; tests may import any file.
- New code follows this now. Add a module to a folder; never add another `<name>-<part>.ts` beside the rest. Goal [125](docs/plan/goals/125-code-to-the-conventions.goal) moves the existing files.

## Limits and state

- **Mechanical parts have limits.** Name a limit for each queue, retry, buffer, payload, file read and the work done per request, and say what happens when it is reached.
- **Product boundaries are not mechanical parts.** A run's turns, trials, failures, time and spending have no default limit. Only a limit that someone configures applies ([No default caps](docs/plan/README.md#rules-for-every-goal)).
- State the invariant before you choose the assertions. Assert programmer errors; handle external failures explicitly.
- Keep ownership, initialisation and clean-up explicit. Avoid duplicate state that can drift.
- Put each check next to the operation it protects. Make the units of indexes, counts and sizes clear.

## TypeScript implementation

- Use TypeScript in strict mode with ES modules on Node.js LTS. Avoid `any` without a stated reason.
- Validate every input that crosses a trust boundary against a schema: API requests, contracts, commands, imported manifests and all LLM output.
- Handle external failures explicitly, with typed errors and no silent catches.
- Pin and justify dependencies, and prefer the standard library. The formatter and linter is Biome; its commands are in AGENTS.md.

## Logging

- Logs are critical infrastructure. Invest more in them than seems necessary.
- Log each major branch of the logic.
- Each line carries the IDs that tie it to its cause: the request, command, job, run or rig.
- Log levels can be changed while the program runs.
- Secrets never go in logs (see [Security](#security)).

## Security

- Complexity is the enemy of security too. Each endpoint, dependency and open port is attack surface to defend.
- Default to deny. Permissions, network rules, CORS and configuration start closed, and open on purpose.
- Don't write your own authentication, cryptography or session handling. Use the standard library's, or well-vetted libraries.
- Validate all input at the trust boundary, as [TypeScript implementation](#typescript-implementation) says, and encode at the output.
- Think in blast radius: least privilege everywhere. One stolen key must not unlock the whole system.
- Before you build a feature, ask how someone would abuse it, as you ask where it will break.
- Dependencies are code that nobody here wrote or read. Pin their versions, and audit the ones that matter.
- Never put secrets in code, logs, error messages, records or `.internal/`. Credentials are files mounted at deploy time.
- Make every default secure. No process runs as root unless its job needs root, and agents never do. Never commit an `.env` file, and never connect a local setup to a live deployment.
- Vulnerabilities cluster. When you find one, look for the same assumption in the code around it. Report it privately, as [SECURITY.md](SECURITY.md) says.

## Testing

- **Tests live in `tests/`,** never beside the code, so that the code is quick to read and to find. Its folders mirror `src/`: the tests of `src/control/store/runs.ts` are in `tests/control/store/runs.test.ts`. `npm test` runs every `tests/**/*.test.ts`, and stops if it finds a test file in `src/`.
  - Shared scaffolding, fakes and helpers live in `tests/helpers/`.
  - A test that wires two or more parts together lives in `tests/system/`. A test of control's pages that is named for a feature lives in `tests/control/dashboard/`.
  - The stand-ins that run inside images (for agent programs, model APIs and devices) live in `tests/stand-ins/<name>/`.
  - A test of the docs' own steps lives in `tests/docs/`.
- Test observable behaviour and important failure transitions. Tests must be able to fail.
- Tests at the system's cut-points and on the users' critical paths give the most value, and they survive refactoring. Keep fine-grained unit tests for what needs exact reference values, such as the statistics and state machines below.
- Mock only at system boundaries, with stand-ins such as the fake RunPod API, the scripted model and the stand-in agent programs.
- Every bug that is found gets a regression test.
- Test empty, largest and over-limit inputs, and the failure transitions. Fuzzing adds to these tests; it does not replace them.
- **Statistics and state machines:** unit and property tests against reference values. Cover verdicts, compare-and-swap promotion, fencing and invalidation.
- **Isolation:** tests that prove agent users cannot reach judge files, credentials or devices outside their grants.
- **Adversarial cases:**
  - timer tampering;
  - reference-op fallbacks;
  - NaN and sentinel values;
  - forged commands;
  - swapped imports;
  - prompt-injected directives;
  - unverifiable claims.
- **Recovery:** process death at each persistence boundary, container restarts, stale leases.
- Report configured checks separately from checks that actually ran and passed.

## Writing and reporting

- Write for your reader, in plain words: code comments, commit messages, docs and reports. Jargon does not make work better. [Writing Thermite's documentation](docs/writing-docs.md) covers the site; decision cards, call-outs, summaries and reports use Simplified Technical English ([Plain words](docs/plan/README.md#rules-for-every-goal)).
- Say when you don't understand. It lets others ask too, and it stops complexity from hiding.
- Never estimate how long a goal, a feature or a task will take. Report what is done, what is left and what blocks it. A measured time, such as how long a check ran, is a fact, not an estimate.
- Learn your tools deeply: the debugger, the command line, and this repository's scripts and checks. Good tools often double the speed of the work.

## Research and work records

- Plans, goals and decisions are public, in [docs/plan/](docs/plan/README.md).
- Store research, reviews and agent work logs that name a particular deployment under `.internal/` in your own checkout, never in tracked files. Preserve earlier records rather than replacing history with a summary.
- For repository and web evidence, record the source, retrieval date and revision.
- `.internal/` is git-ignored. It is not a public archive and not a backup.
