---
title: "Use a ChatGPT subscription"
description: "Sign in with ChatGPT so a rig's agents can use your own ChatGPT plan."
type: how-to
sidebar:
  order: 4
---

If you pay for a ChatGPT Plus or Pro plan, Thermite's agents can work on that plan instead of a paid API key. You sign in with ChatGPT from the dashboard, and control keeps the login. Its models then run in **Pi**, **OpenCode v2** or **Codex**, the programs Thermite's agents work in.

A subscription is for your own Thermite only. A Thermite that several people use takes API keys.

:::note[Tested with a real subscription]
Sign in with ChatGPT was tested from start to end with a real plan: signed in, given to a rig, through the model check under Pi, and in a trial in the Codex CLI whose change the judge confirmed ([goal 009](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/_completed/009-subscription-sign-in-tests.goal)). A full plan, below, is tested against stand-ins only.
:::

## Before you start

- A ChatGPT Plus or Pro plan.
- You are signed in to Thermite's dashboard, in a browser where you can also sign in to ChatGPT.

## Sign in

1. Press the cog icon, **Settings**, at the foot of the sidebar. The **Providers** page opens.
2. In **Add a provider**, set **Type** to **ChatGPT subscription (Plus or Pro)**.
3. Enter a **Name**, for example `chatgpt-pro`.
4. Press **Sign in with ChatGPT ↗**.

   A ChatGPT page opens in a new tab. Sign in there, and allow Thermite to use your plan.

5. The tab then goes to an address that starts with `http://127.0.0.1:1455/auth/callback` and shows an error.

   That is expected: the address is meant for an app on your own computer, and nothing there needs to answer. It holds a one-time code that control needs. If a program on your computer already uses port 1455, close it before you sign in.

6. Copy that whole address from the tab's address bar. Go back to Thermite's tab and paste it into **The address the tab went to**. Do this soon: control waits 30 minutes for the address, but the code in it is ChatGPT's, and ChatGPT may end it sooner.
7. Tick **Unattended use**: "I allow Thermite's agents to use my ChatGPT plan when I am not there, for my own research." Its ⓘ says: "OpenAI asks apps to get your consent before they use your plan when you are not there. Thermite's agents work for hours without you: workers, the planner and the advisors, on the rigs you give its models."
8. Press **Finish the sign-in**.

The page shows `"chatgpt-pro" is signed in: its 6 models run in Pi, OpenCode v2 or Codex. Choose one for a rig below.` with your name and count. Control reads the models from OpenAI's list for your plan, so which ones you get, and how many, depends on OpenAI. The subscription's row under **Providers** lists them as `chatgpt:` and the model's name.

## Give a rig one of its models

1. In **Harness and model for each rig**, find the rig's row.
2. Choose the [worker harness](../../reference/glossary.md), the program the agents run in: **Pi**, **OpenCode v2** or **Codex**. Codex is the Codex CLI, OpenAI's own program for agents; see [Run the agents in Codex](#run-the-agents-in-codex). Claude Code does not take a ChatGPT subscription.
3. Choose a model from the group "chatgpt-pro (ChatGPT subscription: Pi, OpenCode or Codex)", and press **Use**.

Stay on the page: within a minute or two, the rig's row shows the new model, then the model check's result below it, with no refresh. To give the planner or an advisor the subscription, use **Edit rig**: see [Give each agent its own model](model-per-agent.md).

## Run the agents in Codex

A ChatGPT subscription runs in Pi unless you choose another harness. To run the workers in the Codex CLI instead:

1. On **Providers**, in the rig's row of **Harness and model for each rig**, choose **Codex** and the subscription's model, and press **Use**. On the rig's **Edit rig** page, it is **Codex** in the workers' **Runs in**. An agent can do the same over MCP with [`set_rig_model`](../../reference/mcp-tools.md#set_rig_model) and `harness: "codex"`.
2. After a minute, the model check runs in Codex. When it passes, its result says `<model> answered with a correct tool call in <seconds> s (Codex)`.

Then:

- Each worker's trial runs in Codex, as the lane's own user, and submits with [`thermite-trial`](../../reference/command-line.md#thermite-trial).
- The planner runs in Codex too, unless you give it a model of its own on **Edit rig**. Its **Runs in** says "as the workers (Codex)".
- Research workers keep running in Pi, with the same model.
- Codex never gets the subscription's token. It reaches OpenAI through the harness's proxy, with its trial's own token, and the proxy adds the token on the way out.

The published harness images carry the Codex CLI. An image you build with an empty `CODEX_VERSION` does not ([build arguments](../../reference/settings.md#build-arguments)).

## How the login is kept

Control exchanges the code for the login, seals it, and renews it from then on. Only control renews it. A rig whose agents use the subscription gets a token that lasts one hour, and control gives it a fresh one while it uses it. The row on **Providers** says "control renews the login" while all is well.

If the login ends, for example because you disconnected Thermite in ChatGPT, the row shows "its ChatGPT sign-in ended" and the reason, ending "sign in again". To sign in again:

1. Open the subscription's row and press **Sign in with ChatGPT ↗** there.
2. Sign in, copy the address the tab goes to, and paste it into **The address the tab went to** in the same row.
3. Press **Finish the sign-in**. You gave your consent the first time, so there is no box to tick.

## Watch the plan's usage

A ChatGPT plan has usage windows, such as 5 hours and a week. The subscription's row on **Providers** shows them on its closed line, such as `5-hour 42%` and `Weekly 81%`; a window at 80% or more is marked. Open the row to see each window with how much is used and when it resets, the plan's name, and how long ago OpenAI answered.

Control asks ChatGPT's usage endpoint for them, the one the Codex CLI reads for its own sign-in, with the subscription's access token. It asks when you open **Providers**, or when the MCP tool [`providers`](../../reference/mcp-tools.md#providers) is called, at most once in 5 minutes, and sends the token nowhere else. That endpoint is not documented for apps, and OpenAI has refused it for Thermite's sign-in: the row then says `No usage from OpenAI: ChatGPT's usage endpoint refused this sign-in: HTTP 401`, and links to ChatGPT's own page, **Settings › Usage**, which shows the plan's usage. If OpenAI is slow to answer, the row says `OpenAI has not answered yet`: reload the page a moment later.

## When the plan is full

When the plan is full, the agents on the subscription wait and try again every 15 minutes. No new trial (a worker's session) or plan of that run starts while they wait, for at most one trial's length at a time (24 hours when neither the campaign nor the rig sets one); the rig's other runs go on until they meet the full plan too. To end a wait early, press **Resume now** on the run's page ([End a wait for the provider](../campaigns/steer-a-run.md#end-a-wait-for-the-provider)). Nothing pays for more.

A trial at work waits in its own conversation, in OpenCode v2 and Codex as in Pi, and goes on after the wait. Its **Live** says `waiting until 03:14:20 UTC: the provider's rate limit (…). The trial goes on in the same conversation.`

## Sign out

Open the subscription's row and press **Sign out and delete**. Control ends the login at OpenAI and deletes the subscription. The page says `"chatgpt-pro" deleted. OpenAI confirmed the sign-out.`

If it says instead that "OpenAI did not confirm the sign-out", disconnect Thermite yourself in ChatGPT, under **Settings › Security and login › Sign in with ChatGPT**.

If a rig or an agent still uses the subscription, the row says "In use: give its rigs another model before deleting it." Give them another model first.

## If something goes wrong

| You see | What to do |
| --- | --- |
| "Tick the box that allows Thermite's agents to use your plan when you are not there: OpenAI asks apps for your consent." | Tick **Unattended use**, then paste the address again. |
| "The address must start with http://127.0.0.1:1455/auth/callback." | Copy the address from the tab that ChatGPT sent you to, not another one. |
| "Control did not start this sign-in, or it is older than 30 minutes: press Sign in with ChatGPT again." | Start again from **Sign in with ChatGPT ↗**. A restart of control in between also causes this. |
| "ChatGPT did not allow the sign-in" and a reason | You declined, or ChatGPT refused. Sign in again and allow Thermite. |
| "The address has no sign-in code in it." | Copy the whole address, including everything after `?`. |
| "The sign-in failed:" and a reason | Control could not exchange the code for the login. Start again from **Sign in with ChatGPT ↗**. |
| "Claude Code runs only with a Claude subscription here: choose Pi, OpenCode v2 or Codex for this provider." | Choose **Pi**, **OpenCode v2** or **Codex** for that rig. |
| The model check fails right after you chose **Codex** | Check that the rig's harness image has the Codex CLI. The published images do; an image built with an empty `CODEX_VERSION` does not. Without it, the check and the agents' trials say: *this rig's harness image has no Codex CLI: build the image with the Codex option (CODEX_VERSION, which the published images set), or give the rig another harness on Edit rig*. |
