# <Phase or Feature Title>

**Track:** `Feature / Plugin` | `Phase / Architecture`  
**Status:** `Draft` | `In Review (Gate 5)` | `Approved` | `Building` | `Built (YYYY-MM-DD)`  
**Intake (Gate 1):** Issue `#NNN` · Requirements `REQ-NNN` ([`requirements.md`](../requirements.md)) · Wave / Goal `v1.x / Goal N`  
**UX Mockup (Gate 4):** [`mockups/index.html`](../mockups/index.html) *(or `N/A — non-visual`)* · **LOC bound:** `<= NNN`

- **<Headline outcome 1>:** one concrete sentence on what the user can do.
- **<Headline outcome 2>:** one concrete sentence on behavior or safety boundary.
- **<Headline outcome 3>:** one concrete sentence on idle cost / rollback / defaults.

**What prompted this:** Quote the GitHub issue, user friction, or owner ask verbatim (public-safe only).

---

## 0. Core or plugin (Gate 3)

**Placement:** `Plugin (<name>)` *(default)* | `Core` — explain why in 2–4 lines against [`README.md`](../README.md) §1 & [`decisions.md`](../decisions.md) §1.
- **Smallest `PluginApi` hook needed:** `None` *(or exact signature + `minThermite` / `plugin-breaks.json` note)*.
- **Idle cost when disabled/uninstalled:** `0` processes, `0` timers, `0` tables, `0` UI bytes *(state exact overhead if core)*.

## 1. Research & prior art (Gate 2)

- **Thermite today:** exact files, schemas, or contracts inspected (`packages/...`).
- **Prior art:** relevant patterns from `fxbot`, `libfx`, Pi, opencode, or specs (credit in `CREDITS.md` if adopted).
- **Spikes / measurements:** exact latency, memory, or recall numbers measured (and plainly state what was *not* tested).

## 2. Key takeaways

1. **<Decision 1>:** concrete takeaway tied directly to Section 1 evidence.
2. **<Decision 2>:** concrete takeaway tied directly to Section 1 evidence.
3. **<Decision 3>:** concrete takeaway tied directly to Section 1 evidence.

## 3. Contract, UX & implementation

### `core/api` actions & `PolicyGrant` (Gate 3 — Surface Parity)

| `ActionDef` name | HTTP / MCP / CLI | `PolicyGrant` capability | Idempotent? |
| --- | --- | --- | --- |
| `<domain>.<verb>` | `POST /v1/...` · `<domain>_<verb>` · `thermite ...` | `<core or plugin>:<verb>` | Yes / No |

- **Agent wall check:** confirm internal `run_worker` / `run_advisor` agents cannot invoke Door actions or mutate Judge code.

### UX & IA check (Gate 4 — delete subsection only if non-visual)

- **Nav / plugin slot:** one of the 5 core nav slots (`Home`, `Compute`, `Knowledge`, `Campaigns`, `Setup`) or one of the 6 named plugin slots (`nav.item`, `shell.corner`, `run.header.action`, `run.inspector.tab`, `knowledge.toolbar`, `setup.section`).
- **Clutter & subtraction:** what this adds to existing screens, and what gets removed, merged, or collapsed.
- **One home, one word:** single primary home for new facts/actions; terminology matches [`design-plan.md`](../design-plan.md).
- **Mockup verification:** light & dark (`@iammrduncan/magnesium` `thermite.css`) at `1440px` and `390px`, covering empty, dense, and error states.

### Files, schema & cut line

| Package / path | Change | Est. LOC |
| --- | --- | ---: |
| `packages/...` or `plugins/<name>/...` | <single-job responsibility> | `~NN` |

- **Schema / migrations:** `plugin_<name>` migration file(s) *(or core migration + upgrade note)*.
- **Not in this phase:** explicit out-of-scope list. **Cut order if LOC bound is pressured:** drop `<X>` first; keep `<Y>`.

## 4. Checklist (Gate 6)

**M1. Core logic / contract**
- [ ] Pure Sans-I/O reducer / schema / policy tests pass in `< 1s` (proving happy path, refusal, and failure recovery).
- [ ] Unified `core/api` parity verified across REST, policy-filtered MCP, typed client, and CLI.

**M2. Integration, UI & docs**
- [ ] Conformance / proof gates pass (`wall.selfTest()`, judge A/A, or `HarnessPlugin` suite where applicable).
- [ ] *(If visual)* Real browser check at `1440px` & `390px` in light/dark: zero console errors, zero overflow, empty/error states verified.
- [ ] `< 2 min` checks pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:ui` (if UI), `node scripts/checks/public.mjs --untracked` (`0` hits).
- [ ] Docs (`docs/_site/`), generated API reference, and `CREDITS.md` updated in the same commit; `REQ-NNN` updated in [`requirements.md`](../requirements.md).

**Human checks (owner runs before moving to `phases/_completed/`)**
- [ ] <Concrete real-world flow, hardware, or UX judgment check not covered by automated tests.>

## 5. Open questions & Owner Sign-Off (Gate 5 — Hard Stop)

1. **<Open question 1>?** *Recommended default:* <option> — <1-line rationale>.
2. **<Open question 2>?** *Recommended default:* <option> — <1-line rationale>.

- **Owner Sign-Off:** `[ ] Approved to build` — Owner: `<name>` · Date: `YYYY-MM-DD` · Decisions locked: `<notes or link to decisions.md>`.

---

## What the build changed

*Fill during Gate 6 close-out before `git mv` to `docs/plan/v1/phases/_completed/<slug>.md`.*
- **Plan vs. built deltas:** <what changed during implementation and why>.
- **Actual LOC vs. bound:** `<actual> / <bound> LOC`.
- **Not tested / follow-ups:** <anything left to human checks or deferred to `#NNN`>.
