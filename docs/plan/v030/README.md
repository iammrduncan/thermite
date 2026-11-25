# v0.3.0's plans: what is current

v0.3.0's plans were written over several days, and later ones change earlier ones. This page sorts them. Read the current page first; an older page is background, and where it differs from a newer one, the newer one holds.

## Current: under discussion

| Page | What it holds |
| --- | --- |
| [decisions.md](decisions.md) | The architecture and technology decisions for the code's structure: what is settled, the recommended option, the technology against fxbot's, and the 17 decisions still open, each with the owner's call. The repository's copy of the maintainers' working document; last brought in step on 2026-11-25. |

## Current: agreed, and being built

| Page | What it holds | Agreed |
| --- | --- | --- |
| [The run sheet](../v030_release_plan.md) | The 35 steps to the tag, one goal at a time, and the column **State** that says where each stands. | 2026-11-12 |
| [The release plan](../release-v0.3.0.md) | What v0.3.0 is, why, and its goals. | 2026-11-10, rewritten 2026-11-12 |
| [The app's build plan](../app-build-plan.md) | How the dashboard's app is built from the agreed mockup. | 2026-11-12 |
| [Goal 258's design](../goal-258-design.md) | A run owns its agents and its compute: the control plane and the runner, in ten steps. | 2026-11-12 |
| [The UI refresh guide](../ui-refresh-guide.md) | The screens: the review's findings and the rules for screens. | 2026-11-10 |
| [The code structure guide](../code-structure-guide.md) | Six changes of shape inside today's tree (goals 244 and 254 to 257). They are steps of the run sheet, whatever tree is chosen. | 2026-11-10 |

## Earlier: proposals and background

| Page | What it holds | Superseded by |
| --- | --- | --- |
| [options/](options/README.md) | Four options for the code's structure and [the way there](options/the-way-there.md), with [option 4 drawn as a page](options/option-4.html). Proposals of 2026-11-15; none chosen. | Their questions continue as rows 1 to 10 of [decisions.md](decisions.md). Their list of what is "never open to a plugin" was a proposal, not a settled decision, and is reopened as decision 16. |
| [v030_idea.txt](../v030_idea.txt) | The owner's first sketch of the tree, 2026-11-15. | Drawn out as [option 1](options/option-1-the-tree-as-drawn.md). |

When a decision is made, it goes into the plan it changes in the same commit, and its row in [decisions.md](decisions.md) says so. When a proposal here is overtaken, its page says so at the top and this table moves it.
