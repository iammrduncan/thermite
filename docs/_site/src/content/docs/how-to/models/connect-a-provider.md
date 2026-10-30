---
title: "Connect a model provider"
description: "Add an OpenAI-compatible, Anthropic or OpenCode provider on the Providers page and give a rig one of its models."
type: how-to
sidebar:
  order: 2
---

A **model provider** is a service that runs AI models: a hosted API, a gateway, or a model server on your own computer. You add each provider once, on the dashboard's **Providers** page. Control then reads the provider's model list, and you give each [rig](../../reference/glossary.md) the model its agents use.

This guide covers providers reached with an API key, or with no key for OpenCode's free models. For subscriptions, see [Use a Claude subscription](claude-subscription.md) and [Use a ChatGPT subscription](chatgpt-subscription.md). Not sure which model to use? Start with [Choose a model](choose-a-model.md).

## Before you start

- You are signed in to the dashboard, and the rig reports to control.
- You have the provider's base URL and API key. OpenCode's free models need neither.
- If the key is paid, decide how you will limit spending before you start a campaign on this model. Nothing stops research by default. What works on every rig: a stop time for each campaign (**Stop after (hours)** on the **New campaign** page, or `budget.wall_hours`), a spending limit at the provider if it has one, and **Pause** on the run.
- Don't count on the contract's money budget alone: `budget.llm_usd` counts only the workers' trials (their working sessions), never the planner or the advisors, and only on a rig that has token prices. Rigs that control sets up can't have them yet. See [Set a budget or a stop time](../campaigns/budget-and-stop-time.md) and [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).

## Add the provider

1. Press the cog icon, **Settings**, at the foot of the sidebar.

   The **Providers** page opens. Its blocks, in order: **Providers**, **Model prices**, **Add a provider**, **MCP servers**, **Add an MCP server** and **Harness and model for each rig**.

2. In **Add a provider**, choose the **Type**. The group **Models by API key** has three types:

   | Type | Use it for | Base URL | API key |
   | --- | --- | --- | --- |
   | **OpenAI-compatible** | Most model servers and gateways: vLLM, LiteLLM, OpenRouter, Ollama | Required, ending in `/v1` | Required |
   | **Anthropic** | Anthropic's own API | Leave empty for `https://api.anthropic.com` | Required |
   | **OpenCode (its own models)** | OpenCode's own service. Its models run only in OpenCode v2 | Leave empty for `https://opencode.ai/zen/v1` | Leave empty for the free models |

   The list's other groups hold subscriptions, Git access and the places where rigs run. MCP servers, such as GBrain, have a block of their own lower on the page, **Add an MCP server**: see [Give agents MCP tools](../campaigns/give-agents-mcp-tools.md).

3. Fill in the fields. Each label has an ⓘ icon; hover over it to read its description:

   | Field | Its ⓘ says | Example |
   | --- | --- | --- |
   | **Name** | "How it shows in Thermite, and how rigs and campaigns refer to it: for example my-litellm or github-deploy. Letters, digits, dots, dashes and underscores: capitals become lowercase and spaces become dashes." | `my-litellm` |
   | **Base URL** | "Where the provider's API is: for an OpenAI-compatible server, the address ending in /v1. Anthropic and OpenCode: leave it empty for their own." | `https://llm.example.com/v1` |
   | **API key** | "The provider's key. Control seals it at once and never shows it again. OpenCode: leave it empty for its free models." | |

   For a model server on the same computer as Thermite, use `http://host.docker.internal:PORT/v1`, or `host.containers.internal` with Podman. Inside a container, `localhost` is the container itself. An OpenAI-compatible provider always needs a key: if your server checks none, type any word without spaces.

4. Press **Add and list its models**.

   Control seals the key and reads the provider's model list at once. The page shows `"my-litellm" is saved and lists 12 models. Choose one for a rig below.` with your name and count.

   The provider now has a row under **Providers**: its name and type, how many models it lists, its base URL, the end of its key (for example `key …abcd`; OpenCode without a key shows `no key: its free models`), `not HTTPS` for an `http://` address, and which rigs use it. Open the row to see each model.

## Give a rig one of its models

1. In **Harness and model for each rig**, find the rig's row.
2. Choose the **worker harness**, the program the agents run in: **Pi**, **OpenCode v2**, **Claude Code** or **Codex**. Pi is the default. **Codex**, the Codex CLI, takes an OpenAI-compatible provider whose server answers OpenAI's Responses API (`/responses`), as OpenAI's own API does. [Choose a model](choose-a-model.md#where-the-agents-run) says which worker harness works with which provider.
3. Choose the model. The list groups the models by provider. A group marked "OpenCode harness only" needs **OpenCode v2**. Without a key, OpenCode serves only the models whose names end in `-free`.
4. Press **Use**.

   The button turns into **Sending…**, and a line at the top of the page shows `rig-1 takes my-model from "my-litellm" under Pi within a minute, and checks it.`

5. Wait a minute or two on the page: the row follows the rig by itself, with no refresh. Until the rig takes the model, its row says "taking my-model under Pi". Then its model check shows as it runs, such as "Its model check is running · 12 s."

The rig's row now says "Its agents run under Pi with my-model from my-litellm." Below it you see the model check's result, for example "Its model check passed 1m ago: my-model answered with a correct tool call in 3.2 s". Press **Check** to run it again.

You can also give a rig its agents' model where you start a run:

- under **The agents' model** on the **New campaign** page ([Start a campaign from the dashboard](../campaigns/start-from-dashboard.md#5-where-it-runs));
- in a campaign's **Start a run** panel, which shows **The agents' model** when the chosen rig has no model and **Agents** is **On**. Its ⓘ says: "For a rig with no model for its agents: the model to give it, as on its Edit rig page. Control gives it to the rig, which takes it within a minute; then start the run again here." Control gives the rig the model and says "rig-1 takes my-model within a minute; Settings › Providers shows it taking the model until then. Then start the run again." The run doesn't start yet: when the rig's row here says it runs the model, open **Start a run** again and press **Start the run**.

An agent can do it over MCP with [`set_rig_model`](../../reference/mcp-tools.md#set_rig_model). All three work like **Use** here.

**Start a run** starts a run with agents only once the rig has taken the model that control gave it, wherever you gave it: with **Use** here, on **Edit rig**, over MCP, or in an earlier **Start a run** or its twins (`agents_model` over REST and MCP, `--provider` and `--model` on `thermite run start`). Pressed too early, **Start the run** answers **Not started.** "rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that." Until then, **Start the campaign** on the **New campaign** page saves the campaign without starting it, and says "Saved. rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then). Then start the run here."

A failed check says `Its model check FAILED`, then why. With OpenCode's free models, two reasons are common:

- `Rate limit exceeded. Please try again later.`: OpenCode limits free use. Press **Check** a few minutes later, or choose another model.
- `Model unavailable: opencode/<model>`: OpenCode lists that model but does not serve it. Choose another.

For other reasons, see [Check a rig](../operate/check-a-rig.md#read-the-result).

This gives the model to the rig's workers and, unless it has its own, to its planner. To give each agent its own model and effort, use the rig's **Edit rig** page: see [Give each agent its own model](model-per-agent.md).

### How the rig gets the model

Control keeps your choice, and writes the rig's model, with the key, to the rig's config on the message bus within about 5 seconds, sealed to the rig; the rig's supervisor hands it to the rig's harness container as it comes. Only rigs that use one of a provider's models ever receive its key. The harness checks a new model at once, and each new trial and plan uses it. A trial that is already running keeps the model it started with.

## Cap the model's context window

The [context window](../../reference/glossary.md) is how much the model reads in one request, in tokens. Control takes it from the provider's model list: open the provider's row to see it after each model, such as `· 205k`. To run a model at a smaller window, for example to compare two models at the same window, give the rig the model again with a cap. On the dashboard, each agent's **Context** cell on the rig's **Edit rig** page sets it: see [Set an agent's context window and compaction](model-per-agent.md#set-an-agents-context-window-and-compaction). Over the REST API:

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' \
  -d '{"provider": "my-litellm", "model": "my-model", "context_window": 131072}' \
  http://127.0.0.1:8800/v1/rigs/rig-1/model
```

Control answers with the window the rig gets, and says so in words:

```json
{"rig":"rig-1","agent":"workers","model":"my-model","context_window":131072,"compact_at":null,"said":"rig-1 takes my-model from \"my-litellm\" under Pi within a minute, and checks it. Its context window: 131,072 tokens (capped; the provider allows 204,800).","agents":{…}}
```

An agent does the same with [`set_rig_model`](../../reference/mcp-tools.md#set_rig_model) and `context_window: 131072`. The token for each is in [Tokens](../../reference/tokens.md).

- The cap is at least 4,096 tokens, and at most the provider's window. A larger one is refused: `my-model takes at most 204,800 tokens.` When the provider lists no window, control uses the cap as given.
- Each request sets the cap anew. Give the model again without `context_window` and the cap goes: the rig gets the provider's window.
- **Use** on this page keeps the cap while the rig keeps the same model, and another model there removes it. On **Edit rig**, the workers' **Context** cell shows the cap and changes it.
- This cap is for the workers' model, and for the planner when it follows the workers. The planner with its own model and each advisor take their own cap, with `agent` in the same request: see [Set an agent's context window and compaction](model-per-agent.md#set-an-agents-context-window-and-compaction).
- A campaign can set its own window for all its runs; each agent then works with the lower of the two. See [Set a campaign's own context window](model-per-agent.md#set-a-campaigns-own-context-window).

After a minute, the rig's row under **Harness and model for each rig** says "Its agents run under Pi with my-model from my-litellm. Its context window: 131,072 tokens (capped; the provider allows 204,800)." The model check's details record the window the rig runs with: see [Rig checks](../../reference/rig-checks.md#model-route-check).

:::note
Agents in Pi keep to the window: when a reply limit is known, each reply is limited to the room left, and near the window the conversation is compacted and the trial goes on (see the next section). OpenCode v2, Codex and Claude Code get the window in their own settings, with limits of their own: Claude Code takes no window below 100,000 tokens, Codex none above what the model takes (272,000 tokens for a model it does not know), and OpenCode's own models keep the window OpenCode knows. To compare models at exactly one window, run both rigs in Pi.
:::

## Set when a conversation is compacted

A trial's conversation grows with every tool call and result. Near the model's context window, the conversation is **compacted**: the harness keeps the whole conversation as a document in the run's research folder, replaces the older turns with a summary that names that document, and the trial goes on. In OpenCode v2, Codex and Claude Code the program compacts on its own, and Thermite still keeps its conversation there and tells its summary to name the file. No trial ends, and no agent is told to submit, because its conversation grew.

By default this happens at 80% of the window. To compact at another share, type it in **Compact at** in the agent's **Context** cell on **Edit rig**, or give the rig the model again with `compact_at`, a whole percent from 50 to 95:

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' \
  -d '{"provider": "my-litellm", "model": "my-model", "context_window": 131072, "compact_at": 70}' \
  http://127.0.0.1:8800/v1/rigs/rig-1/model
```

Control answers with the point it keeps, and says it in words: `"compact_at":70` and "Its conversations are compacted at 70% of the window." An agent does the same with [`set_rig_model`](../../reference/mcp-tools.md#set_rig_model) and `compact_at: 70`.

- A point outside 50 to 95 is refused: `The compaction point is a whole percent of the context window, from 50 to 95.`
- Each request sets the point anew, as it sets the cap. Give the model again without `compact_at` and the rig goes back to 80%.
- A rig whose harness is older than this point refuses a model route with `compact_at`: set it only on rigs on images that have it. A route without it is unchanged.
- **Use** on this page keeps the point while the rig keeps the same model, and another model there removes it. On **Edit rig**, the workers' **Context** cell shows the point and changes it.
- This point is for the workers' model, and for the planner when it follows the workers. The planner with its own model and each advisor take their own point, and a campaign can set its own for all its runs: see [Give each agent its own model](model-per-agent.md#set-an-agents-context-window-and-compaction).

After a minute, the rig's row under **Harness and model for each rig** ends with "Its conversations are compacted at 70% of the window." Each compaction has a line in the run's **History**, and one in **Live** with the summary after it, such as "Claude Code compacted the conversation (compaction 1) at about 160,512 tokens, down to about 18,204. The trial goes on. The conversation before it is kept in the run's research folder, compactions/t-…-1.md." [Limits and pacing](../../reference/limits-and-pacing.md#compaction) lists what each harness takes, and how each one's conversation is kept: Pi, OpenCode v2, Codex and Claude Code each compact in their own way.

## Add a model the list leaves out

Some providers serve models that their list does not show. Open the provider's row and type the model's id in **A model it does not list**. Its ⓘ says: "Some providers serve models their list leaves out. Add one by its id at the provider; it shows as yours." Press **Add it**. The model shows in the row with "· yours".

## Give a model its price

[Model usage](../../reference/model-use.md) costs each call at its model's price. When the provider's list gives prices, as OpenRouter's and Nous Portal's do, control keeps them with the list and uses them. OpenAI's own list, Anthropic's and OpenCode Zen's give none, so their models' calls show `no price` until you set one, in US dollars for a million tokens. A provider whose list makes every model free says `free, from the provider` in its row.

1. Open **Settings › Providers**. Under the providers, **Model prices** lists every model of every provider that is not a subscription, in $ for a million tokens. Its **Price from** column says `provider's list`, `free`, `yours` or `no price`.
2. In the model's row, type its **In** and **Out** prices, and **Cached in** if the provider charges less for tokens it reads from its cache (empty: the **In** price). A model whose list gives a price shows it as text: it can't be changed here.
3. Press **Save prices**.

The line beside the button says `Saved. Every cost follows.`, and the model's **Price from** reads `yours`. The run pages, the campaign pages and **Metrics** cost every call of the model at the new price, the earlier ones too. To remove your price, empty its three fields and press **Save prices**: its calls show `no price` again.

To set a price without the dashboard, send it to control:

```sh
curl -sS -X POST https://control.example.com/v1/model-prices \
  -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" -H "Content-Type: application/json" \
  -d '{"provider": "lab", "model": "small-model", "input": 1, "cached_input": 0.1, "output": 2}'
```

The answer says the price in words: "small-model of lab costs 1 USD per million tokens in, 0.1 USD cached and 2 USD out. Model usage prices all its calls at it." The MCP tool [`set_model_price`](../../reference/mcp-tools.md#set_model_price) does the same. A subscription's calls (a Claude or ChatGPT provider) are on its plan and take no price: its row says `On a plan: its calls show their tokens, and “on a plan” for cost.`

## Refresh, change or delete a provider

Open the provider's row:

- **Refresh models** reads the provider's list again. If the list fails, the row keeps its last list and shows the error in red.
- To change the type, the base URL or the key, edit the fields and press **Save and list its models**. Leave **API key** empty to keep the current key.
- **Delete this provider** removes it. A provider that a rig or an agent uses shows "In use: give its rigs another model before deleting it." instead. Give those rigs and agents another model first.

## If something goes wrong

Errors show in a card that starts with **Not done.**

| You see | What to do |
| --- | --- |
| "A new provider needs its API key." | Enter a key. Only OpenCode's own provider may have none. |
| "An OpenAI-compatible provider needs its base URL." | Enter the address, ending in `/v1`. |
| "The base URL is http or https, with no credentials, query or fragment in it." | Remove any `user:password@`, `?…` or `#…` from the address. |
| "…could not list its models: HTTP 401 (is the key right?)" (or 403) | Check the key. |
| "…could not list its models: HTTP 404 (is the base URL right?)" | Check the address. An OpenAI-compatible one ends in `/v1`. |
| "…could not list its models: no answer in 15 s" or "could not reach it to list its models" | Control cannot reach the address. For a server on your computer, use `host.docker.internal`, not `localhost`. |
| "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig." | Choose **OpenCode v2** for that rig. |
| "Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider." | Choose **Pi** or **OpenCode v2**. For a ChatGPT subscription or an OpenAI-compatible provider it says "… choose Pi, OpenCode v2 or Codex for this provider.": **Codex** works there too. |
| "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider." | Choose **Pi** or **OpenCode v2** for an Anthropic or OpenCode provider. |

The provider is saved even when its list fails. Fix the cause, then press **Refresh models**.

## Use the rig's own settings instead

A rig can also take its model from its own settings, the `THERMITE_MODEL_*` variables. The rig uses them only while control gives it no model: choose **its own settings** in the rig's model list to go back to them. They suit a rig that you set up and keep yourself, or a test without the dashboard.

| Setting | What it holds |
| --- | --- |
| `THERMITE_MODEL_BASE_URL` | The provider's address, ending in `/v1` |
| `THERMITE_MODEL` | The model's name at the provider |
| `THERMITE_MODEL_API_KEY_FILE` | A file holding the key. On the local stack: `.dev/secrets/model-api-key` |
| `THERMITE_MODEL_CONTEXT_WINDOW` | The model's context per request. `0` means unknown |
| `THERMITE_MODEL_COMPACT_AT` | The share of the window, in percent (50 to 95), at which an agent's conversation is compacted. Unset: 80 |
| `THERMITE_MODEL_MAX_TOKENS` | The longest reply, thinking included. Default: none sent, so the provider's own limit applies (Anthropic's API gets 32,000). A model from control takes the model's maximum output from the provider's list |
| `THERMITE_MODEL_REASONING_EFFORT` | `none`, `low`, `medium` or `high`. Unset: nothing is sent |
| `THERMITE_MODEL_API` | `openai` (the default), `anthropic`, `opencode`, `claude` or `chatgpt` |
| `THERMITE_AGENT_HARNESS` | `pi` (the default), `opencode`, `claude-code` or `codex` |

The rig needs the base URL, the model and a key, or its agents have no model. On the local stack, set the first two in your shell or in a `.env` file next to `compose.yaml`, put the key in `.dev/secrets/model-api-key`, and start the stack again, with your `-f` options if you use [override files](../install/one-machine.md#settings-and-override-files):

```sh
THERMITE_MODEL_BASE_URL=http://host.docker.internal:8000/v1 THERMITE_MODEL=my-model \
  docker compose up -d
```

If the rig has a model from control, choose **its own settings** for it in **Harness and model for each rig** and press **Use**. Within a minute the rig's row says "Its agents use the rig's own settings (my-model, under Pi)", followed by the model check's result.

If you change only the key file, restart the harness so that it reads the file again: `docker compose restart harness`.

The local `compose.yaml` passes `THERMITE_MODEL_BASE_URL`, `THERMITE_MODEL`, `THERMITE_MODEL_API_KEY_FILE`, `THERMITE_MODEL_CONTEXT_WINDOW`, `THERMITE_MODEL_MAX_TOKENS` and `THERMITE_MODEL_REASONING_EFFORT` to the rig ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). To set `THERMITE_MODEL_COMPACT_AT`, `THERMITE_MODEL_API` or `THERMITE_AGENT_HARNESS` on the local stack, put them on the harness container in an override file next to `compose.yaml`. For example, to run the workers in OpenCode v2:

```yaml title="compose.model.yaml"
services:
  harness:
    environment:
      THERMITE_AGENT_HARNESS: opencode
```

Then start the stack with both files, and name both in every later `up`:

```sh
docker compose -f compose.yaml -f compose.model.yaml up -d   # or: podman compose -f … -f … up -d
```

The [settings reference](../../reference/settings.md) describes every setting.
