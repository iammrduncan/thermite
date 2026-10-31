---
title: "Use a Claude subscription"
description: "Let a rig's agents work through your own Claude subscription, inside Claude Code."
type: how-to
sidebar:
  order: 3
---

If you pay for a Claude Pro or Max plan, Thermite's agents can work on that plan instead of a paid API key. Anthropic allows a subscription only in its own program, so these agents run inside **Claude Code**. You make a token on your own computer, paste it into the dashboard, and give a [rig](../../reference/glossary.md) one of its models.

A subscription is for your own Thermite only. A Thermite that several people use takes API keys.

:::note[Tested with a real subscription]
A real Claude subscription was tested from start to end in Claude Code: signed in, given to a rig, through the model check, and in trials whose changes the judge confirmed ([goal 009](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/_completed/009-subscription-sign-in-tests.goal)). A full usage window, below, is tested against a stand-in for Anthropic's service only.
:::

## Before you start

- A Claude Pro or Max plan, and Node.js on your own computer.
- A rig whose images have Claude Code in them. Thermite's images leave it out unless you build them with it: see step 2. The published images, which a release's `compose.yaml` runs, never carry it, so the local stack must run from the source code ([Running Thermite locally](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md)).

## 1. Make a token

On your own computer, not on the rig:

1. Install Claude Code, if it is not installed:

   ```sh
   npm install -g @anthropic-ai/claude-code
   ```

2. Run `claude setup-token` and sign in with your Claude account in the browser.
3. Copy the token it prints. It starts with `sk-ant-` and is good for one year.

Control cannot open Anthropic's sign-in page for you, which is why you make the token yourself.

## 2. Build the images with Claude Code

Claude Code is not open source, so Thermite's images carry it only when you build them with the build option `CLAUDE_CODE_VERSION`. The harness image needs it for the workers and the planner. The supervisor image needs it for advisors on the subscription.

1. Find the newest version of the package the build downloads:

   ```sh
   npm view @anthropic-ai/claude-code-linux-x64 version
   ```

   On an arm64 machine the build downloads `@anthropic-ai/claude-code-linux-arm64` instead.

2. On the local stack built from the source code, put the option in an override file next to the repository's `compose.yaml`, with that version:

   ```yaml title="compose.claude.yaml"
   services:
     harness:
       build:
         args:
           CLAUDE_CODE_VERSION: "<version>"
     supervisor:
       build:
         args:
           CLAUDE_CODE_VERSION: "<version>"
   ```

3. Build the images and start the stack with both files:

   ```sh
   docker compose -f compose.yaml -f compose.claude.yaml up -d --build   # or: podman compose -f … -f … up -d --build
   ```

Name this file in every later `up --build`, also when you update Thermite ([Stop, start and update](../install/one-machine.md#stop-start-and-update)), together with any other override file you use. A build without it leaves Claude Code out: `compose.yaml` has no setting for it yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).

For rigs that control sets up on your machines or clusters, build the images with the option and push them to a registry that is not public, since Claude Code is not open source. Control gives rigs no registry login, so the machines' Podman, or the cluster's nodes, must be able to pull from that registry on their own. See [Push the images to your own registry](../install/own-registry.md).

## 3. Add the subscription

1. Press the cog icon, **Settings**, at the foot of the sidebar. The **Providers** page opens.
2. In **Add a provider**, set **Type** to **Claude subscription (Pro or Max)**.
3. Enter a **Name**, for example `claude-max`.
4. Paste the token into **Token from claude setup-token**. Its ⓘ says: "The long-lived token that Claude Code prints. Control seals it at once and never shows it again. Only Claude Code, Anthropic's own program, uses it on the rigs: Anthropic does not allow other programs to use a subscription."
5. Press **Add the subscription**.

The page shows `"claude-max" is saved: its 5 models run only in Claude Code. Choose one for a rig below.` Control makes no call to Anthropic with the token. Its list of models is fixed. `opus-5.5` and `opus-5.5[1m]` are the same model with the same context, so either one will do:

| Model | Context |
| --- | --- |
| `claude-code:opus-5.5` | 1M tokens |
| `claude-code:opus-5.5[1m]` | 1M tokens, the same model |
| `claude-code:sonnet-5.5` | 1M tokens |
| `claude-code:haiku-5.5` | 200k tokens |
| `claude-code:fable-5.1` | 1M tokens |

## 4. Give a rig one of its models

1. In **Harness and model for each rig**, find the rig's row.
2. Choose a model from the group "claude-max (Claude subscription: runs in Claude Code)". Thermite sets the [worker harness](../../reference/glossary.md), the program the agents run in, to **Claude Code** for you.
3. Press **Use**.

The page shows `rig-1 takes sonnet-5.5 from "claude-max" under Claude Code within a minute, and checks it.` Stay on the page: within a minute or two, the rig's row shows the new model, then the model check's result below it, with no refresh, for example "Its model check passed 1m ago: claude-sonnet-5-5 answered with a correct tool call in 6.1 s (Claude Code)".

To give the planner or an advisor the subscription, and to set an effort, use **Edit rig**: see [Give each agent its own model](model-per-agent.md).

Control gives a rig the token only while one of its agents uses the subscription. On the rig, Claude Code runs as the agent's own user with its own sandbox off: the rig's isolation holds the commands it runs, and the token reaches Claude Code on a file descriptor, never in an environment variable. An advisor's Claude Code runs in the supervisor's container as an advisor user of its own, which can't read the supervisor's files, with none of its own tools, also with its sandbox off and the token on a file descriptor ([Who holds your keys](../../explanation/who-holds-your-keys.md#subscriptions)).

## Watch the usage windows

A Claude plan has a 5-hour window and a weekly window. The subscription's row on **Providers** shows them on its closed line, such as `5-hour 42%` and `Weekly 81%`; a window at 80% or more is marked. Open the row to see "5-hour window" and "Weekly window", each with how much is used and when it resets, as Claude Code on a rig last reported it: Claude Code reports a window with each answer that changes it, and the rig keeps the other window from earlier answers. Control makes no call to Anthropic with the token, so before any agent uses the subscription, the row says "No usage reported yet". The MCP tool [`providers`](../../reference/mcp-tools.md#providers) gives the same windows.

When a window is full, its run's agents wait until the window resets: no new trial (one worker's session) or plan of that run starts until then. A wait lasts at most one trial's length (24 hours when neither the campaign nor the rig sets one); if the window is still full then, the next trial meets it, and the run waits again. Each run on the rig waits once one of its own trials meets the full window. **Live** in the sidebar, the dashboard's view of the agents at work ([glossary](../../reference/glossary.md)), shows "agents wait for the subscription's usage window to reset at" and the time. To end a wait early, press **Resume now** on the run's page ([End a wait for the provider](../campaigns/steer-a-run.md#end-a-wait-for-the-provider)).

What becomes of the trial that hit the window depends on how the rig runs Claude Code:

- **In its own terminal**, the default, the trial waits with it. Claude Code waits for the reset and goes on by itself in the same session, as Thermite's settings for it ask (`autoContinueAtUsageLimit`); the trial's **Live** says `waiting until 15:45:00 UTC: the provider's rate limit (…). The trial goes on in the same conversation.` Thermite reads the wait and its reset from Claude Code's transcript, never from its screen, and types nothing into Claude Code meanwhile. Your own input to its terminal waits for the reset too, unless you send it at once ([Watch and steer an agent in its terminal](../campaigns/agent-terminal.md#while-the-program-waits-for-its-usage-window)). If Claude Code has not gone on 3 minutes after the reset, the rig stops it, with nothing typed into it, and goes on in its session in a new terminal. The trial ends instead when the reset is more than a day away (a weekly window, where Claude Code would show a menu that waits for a key, which nothing answers), when it comes after the trial's own end, when Claude Code gives no time it resets, or when the rig drains.
- **Headless**, the trial that hit the window ends.

Nothing pays for more: the agents go on after the reset, and the rig never answers Claude Code's menus about its usage. That holds while usage credits are off on the Claude account (on claude.ai, under **Settings › Usage**): keep them off on the subscription Thermite uses.

Many agents can share one plan, and so can several rigs. On **Edit rig**, a note says how many of the rig's agent sessions at a time can use the subscription. More workers at a time fill a window faster.

## Replace or remove the token

- **Replace it**: run `claude setup-token` again, open the subscription's row, paste the new token into **New token from claude setup-token**, and press **Replace the token**. The new token works at once. Do this before the old one's year ends.
- **Remove the subscription**: press **Delete this subscription** in its row. If a rig or an agent still uses it, the row says "In use: give its rigs another model before deleting it." Give them another model first.

## If something goes wrong

| You see | What to do |
| --- | --- |
| "That is not a token from claude setup-token: it starts with sk-ant-." | Copy the token that `claude setup-token` printed, not another key. |
| "The token has spaces or is too long: paste only what claude setup-token printed." | Paste the token alone, on one line. |
| The model check fails right after you chose the model | Check that the rig's harness image was built with `CLAUDE_CODE_VERSION`. The check then says: *this rig's harness image has no Claude Code: build the image with the Claude Code option (CLAUDE_CODE_VERSION), or give the rig another harness on Edit rig*. |
| The model check fails with *its tool call did not print the word*, and the model's answer says the Bash sandbox failed to start: *Failed to create bridge sockets after 5 attempts* | The rig's harness image is from a Thermite version that turned on Claude Code's own sandbox, which cannot start in a rig. Rebuild the images from this version: Claude Code then runs the agent's commands inside the rig's own isolation, without its sandbox. |
| The model check fails with: *Claude Code needs bubblewrap to keep the agent's commands away from its sign-in* | The same: the harness image is from an older Thermite. Rebuild the images from this version. |
| An advisor on the subscription fails with *EACCES: permission denied, mkdir '/tmp/claude-10001'* | The rig runs the one-container rig image from an older Thermite, which gave Claude Code no temporary folder of its own. Rebuild the image from this version. |
| The model check fails with "the subscription's usage window is full until" a time | Wait for the reset, or use another model meanwhile. |
| A trial ends with "Claude Code's usage window is full until" a time, "more than a day away" | A weekly window: the run waits for its reset. Wait, or give the rig another model meanwhile on **Edit rig**. |
| A research campaign's trials end with "research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research" | Research workers run in Pi or OpenCode v2, never in Claude Code. Give the rig another model for research. |
