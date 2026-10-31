---
title: "Withdraw bad evidence"
description: "Withdraw an attempt, or a judge job's measurements, that you found bad: see what it reaches, confirm it, and see what it changed."
type: how-to
sidebar:
  order: 17
---

Sometimes evidence the judge recorded turns out to be bad: a change that games the kit's check, or measurements taken while the rig's card ran slow. You withdraw it, and what rested on it follows: its verdicts are superseded, the champions built on it are reopened, and the run's champion moves back. Nothing is deleted: the old verdicts stay in the record, marked. Only you, the owner, can withdraw evidence; agents, an operator and the [advisors](../operate/advisors.md) can't.

You always see what a withdrawal reaches before it happens. The rig works it out and changes nothing; then you confirm exactly that.

## Before you start

Decide what is bad: the change itself, or one measurement of it.

- **The change is bad**, for example it reads the timer it is measured with. Withdraw the **attempt**. That is for good: the attempt, and every attempt built on it, get an `invalidated` verdict, are never judged again and can't become the champion. A trial still at work on top of it can submit, but its change is withdrawn as it arrives.
- **The measurement is bad**, for example the device throttled during one job. Withdraw that **judge job's measurements**. The attempts whose verdict rests on that job, and those built on them, get an `invalidated` verdict and go back to the judge's queue to be measured again. In a closed run nothing is measured again.

Then check:

- **Which job it was.** The form in step 1 lists the attempt's judge jobs that finished, each with its number and what it did; **Every event**, under **What happened to it** on the attempt's page, shows when each ran. A confirmed win rests on two jobs: its screen and its confirmation. Over REST, the rig's view (`GET /v1/rigs/<rig>/view`) lists the judge's jobs under `judge.jobs`, each with its `id` and `attempt`.
- **What depends on it.** In a hill climb, the run's **Overview** lists its **Champions**, with the change each one was. A champion that rested on the evidence is reopened, and every champion built on it too.
- **The champion's patch.** A champion you already downloaded or that a rig already published keeps its patch in the results repository and on control: nothing is deleted or rewritten there. If you applied it to your project, revert it yourself.

## 1. See what it reaches

1. Open **Campaigns**, the campaign, then the run. On the run's **Attempts** tab, press the attempt's row. Its page opens.
2. In the right column, under **Withdraw evidence**, press **Withdraw its evidence…**.
3. Choose what to withdraw: **This attempt, for good**, or **The measurements of judge job N**. Each judge job of the attempt that finished is listed, with what it did.
4. In **Why**, say why. The record keeps it, and every page that shows the withdrawal says it.
5. Press **See what it reaches**.

Nothing changes yet. Within a few seconds the box says what withdrawing it decides, as the rig worked it out:

```text
What withdrawing it decides
- Attempt a-0123abcd4567ef89 and the 1 attempt built on it (a-89ab01cd23ef4567) are withdrawn for good: none is judged again, and none can become the champion.
- 2 verdicts are superseded by an invalidated verdict. Nothing is deleted: the old verdicts stay in the record.
- Champions #2 (a-0123abcd4567ef89) and #3 (a-89ab01cd23ef4567) are reopened.
- The run's champion moves back from #3 to #1, the starting point: new trials build on it.
```

Under the sentences, each attempt it reaches is listed with its verdict and state now, and what becomes of it: **withdrawn for good**, **judged again** or **stays withdrawn**.

## 2. Confirm it

Press **Withdraw the evidence**. The rig does exactly what the box showed, in one step. If anything it reaches changed meanwhile, such as a new verdict for one of the attempts, the rig refuses: `The rig refused to withdraw it: what it reaches changed since the preview: preview it again, and confirm what it reaches now`. Press **See what it reaches** again, and confirm the new reach.

## From the command line, REST or MCP

`thermite invalidate` prints what it reaches; with `--yes` it then withdraws exactly that ([`invalidate`](../../reference/command-line.md#invalidate)):

```sh
npx thermite invalidate --control https://control.example.com --token-file ~/thermite-owner-token \
  --run sort-speed-1 --attempt a-0123abcd4567ef89 \
  --reason "it reads the timer it is measured with" --yes
```

To withdraw a job's measurements, give `--job N` instead of `--attempt`. Over REST, `POST /v1/commands` with the kind `invalidate_evidence` and `"preview": true` asks for the preview; `GET /v1/commands/<id>` gives its answer, and a second `POST` with `"reach"` set to the answer's `sha` withdraws it ([REST API](../../reference/rest-api.md#signed-commands)). MCP's `issue_command` and `command_status` do the same with the owner's token ([MCP tools](../../reference/mcp-tools.md#command-kinds-for-each-role)). [`invalidate_evidence`](../../reference/signed-commands.md#invalidate_evidence) gives every field, refusal and event.

## Check that it worked

- **The attempt's page** shows the chip **Withdrawn** and a block **Its evidence was withdrawn**: when, by you, why, what was withdrawn, the attempts it reached, the invalidated verdicts and the champions it reopened, and where the run's champion moved. An attempt reached because it was built on the withdrawn one shows the same block.
- **The run's History** says `You withdrew attempt a-0123abcd4567ef89: it reads the timer it is measured with. It and the 1 attempt built on it are withdrawn for good. Nothing is deleted.`, then `The run's champion moved back from #3 to #1, the starting point: its evidence was withdrawn. New trials build on #1.` A judge job it cancelled has its own line.
- **The run's Champions list** no longer shows the reopened champions, and the run's champion is the one it moved back to.
- **The knowledge base** says `Verdict: invalidated (withdrawn: <why>)` on each attempt's item, and the run's item says the best so far now.
- **The rig's next export** carries every step as events. [Verdicts and states](../../reference/verdicts.md#withdrawn-evidence) lists them.
