import type { Hono } from "hono";
import { KEY_PROVIDER_TYPES } from "../../../core/agents.ts";
import { compactAtWords } from "../../../core/compaction.ts";
import { isFree } from "../../../core/usage.ts";
import { type ClusterFacts, clusterLine } from "../../clusters/index.ts";
import {
  checkRow,
  checkRowsOf,
  checkWaits,
  modelFollowUrl,
  takingModel,
} from "../../command-progress.ts";
import {
  factsLine,
  fingerprint as fingerprintOf,
  type MachineFacts,
  missing,
  RECIPES,
  type RecipeId,
  recipeScript,
  scriptSha,
} from "../../machines/index.ts";
import {
  ANTHROPIC_BASE,
  CHATGPT_REDIRECT,
  capWords,
  isOpencodeOwn,
} from "../../providers/index.ts";
import { HARNESS_NAMES } from "../../rigs/index.ts";
import {
  cheapestGpu,
  DEFAULT_DISK_GB,
  type RunpodFacts,
  runpodLine,
  type TestView,
} from "../../runpod/index.ts";
import {
  HARNESSES,
  type Machine,
  type ModelProvider,
  type ProviderType,
} from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { ago, esc } from "../../ui/components/index.ts";
import { usageBlock, usageChips } from "../../ui/providers/usage.ts";
import { checkFollowUrl, modelCheckHtml } from "../../ui/rigs/checks.ts";
import { modelPricesBlock } from "../../ui/usage.ts";
import type { Dashboard } from "../context.ts";
import { mcpSettingsBlocks } from "./mcp-servers.ts";
import { reachBlock } from "./reach.ts";
import { modelPrefix, TYPES, UNCHECKED_LABEL, UNCHECKED_TIP, usd } from "./shared.ts";

/**
 * Settings › Providers: what can be added, the providers with their rows, the harness and model
 * for each rig, model prices and MCP servers.
 */
export function settingsPageRoutes(app: Hono, dash: Dashboard): void {
  const { cmdForm, csrf, mcpServers, opts, page, parts, said, store, views } = dash;

  // ---------------------------------------------------------------- settings: model providers
  /** The types reached with an API key (a subscription is added differently). */
  const KEY_TYPES = KEY_PROVIDER_TYPES;
  const TYPE_TIP =
    "What kind of provider it is. OpenAI-compatible covers most model servers (vLLM, LiteLLM, OpenRouter, Ollama). Anthropic is Anthropic's own API. OpenCode is OpenCode's own service, whose free models need the OpenCode harness.";
  const BASE_TIP =
    "Where the provider's API is: for an OpenAI-compatible server, the address ending in /v1. Anthropic and OpenCode: leave it empty for their own.";
  /** The add form's button and what it says happens, by type (the page script shows them). */
  const ADD_SAYS = {
    openai: [
      "Add and list its models",
      "Control seals the key and reads the provider's model list at once, and again when you press Refresh models.",
    ],
    anthropic: [
      "Add and list its models",
      "Control seals the key and reads Anthropic's model list with it.",
    ],
    opencode: [
      "Add and list its models",
      "OpenCode's free models need no key, and run only in the OpenCode harness. Control reads its model list at once.",
    ],
    gitkey: [
      "Make the key",
      "Control makes an SSH key pair and shows its public half: add it to the repository (or the account) as a read-only deploy key. The private half stays sealed in control and goes only to rigs running a campaign that uses it.",
    ],
    ssh: [
      "Add and read its host key",
      "Control reads the machine's host key for you to compare and trust. Then it logs in and reads the machine: its system, GPUs, container engine and NVIDIA's toolkit, and whether it reaches control. It changes nothing, and installs nothing unless you allow it.",
    ],
    k8s: [
      "Add and check the cluster",
      "Control reads the cluster with this kubeconfig: its version, its nodes and their GPUs, DRA device classes, storage classes, and whether it may create namespaces or deploy into the slots you name. It changes nothing.",
    ],
    runpod: [
      "Add and read the account",
      "Control seals the key and reads, with it, RunPod's GPU types with their prices and stock, its data centers, your network volumes and your pods. It starts nothing and spends nothing.",
    ],
    chatgpt: [
      "Finish the sign-in",
      "Control exchanges the code for the login, seals it and renews it from now on (only control does). Rigs whose agents use one of its models get a token that lasts one hour, renewed while they use it. Its models then show in each rig's model list as chatgpt:<model>.",
    ],
    claude: [
      "Add the subscription",
      "Control seals the token. It makes no call to Anthropic with it: only Claude Code, on the rigs whose agents use one of its models, uses it. Its models then show in each rig's model list as claude-code:<model>.",
    ],
    gittoken: [
      "Add the token",
      "Control seals the token. It goes only to rigs running a campaign that uses it. Use a token that can only read the repositories you need.",
    ],
  } satisfies Record<string, [string, string]>;
  const typeSelect = (sel?: ProviderType) =>
    `<select name="type">${KEY_TYPES.map((t) => `<option value="${t}"${t === sel ? " selected" : ""}>${t === "opencode" ? "OpenCode (its own models)" : TYPES[t]}</option>`).join("")}</select>`;

  app.get("/ui/settings", async (c) => {
    const now = Date.now();
    const vs = views();
    const t = csrf(c);
    const providers = store.modelProviders.list();
    const usage = new Map(
      await Promise.all(
        providers.map(async (p) => [p.name, await opts.parts.planUsage.of(p)] as const),
      ),
    );
    const gitCount =
      store.gitAccess.list().length +
      store.machines.list().length +
      store.clusters.list().length +
      store.gpuClouds.list().length;
    const given = store.agentModels.byRig();
    /** The rigs whose workers or other agents use one of the provider's models. */
    const usersOf = (name: string) =>
      vs
        .map((u) => u.id)
        .filter(
          (rig) =>
            given[rig]?.provider === name ||
            Object.values(store.agentModels.byRole(rig)).some((r) => r?.provider === name),
        );
    // What an MCP server's form did is said in its own block (at=mcp), where the page opens.
    const atMcp = c.req.query("at") === "mcp";
    // So is what Save prices did (at=prices), in Model prices.
    const atPrices = c.req.query("at") === "prices";
    // And what the addresses cluster rigs may reach said (at=reach), in theirs.
    const elsewhere = atMcp || atPrices || c.req.query("at") === "reach";
    const ok = elsewhere ? undefined : c.req.query("ok");
    const error = elsewhere ? undefined : said(c);
    // Model prices (goal 075): one table under the providers, for every model not on a plan.
    const prices = modelPricesBlock({
      providers,
      owner: store.usage.prices(),
      csrf: t,
      flash: !atPrices
        ? undefined
        : c.req.query("error")
          ? { kind: "bad", text: String(c.req.query("error")) }
          : c.req.query("ok") === "saved"
            ? { kind: "saved" }
            : c.req.query("ok") === "same"
              ? { kind: "same" }
              : undefined,
    });
    const allFree = (p: ModelProvider) =>
      p.models.length > 0 && p.models.every((m) => m.price && isFree(m.price));
    const PLAN_LINE = `<div class="muted small" style="margin-top:10px">On a plan: its calls show their tokens, and “on a plan” for cost.</div>`;
    const note = error
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not done.</b> ${esc(error)}</div>`
      : ok
        ? `<div class="card" style="margin-bottom:16px"><b class="ok">${esc(ok)}</b></div>`
        : "";
    /** A Claude subscription: its token's hint, its models, what its rigs report of its usage. */
    const claudeRow = (p: (typeof providers)[number], rigs: string[]) => {
      const pName = encodeURIComponent(p.name);
      const windows = usageBlock("claude", usage.get(p.name), now);
      return `<details class="dq" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Subscription</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· Claude subscription</span></span><span class="dq-why">${p.models.length} models · runs only in Claude Code, Anthropic's own program</span><span class="dq-sub"><span class="chip">token ${esc(p.key_hint)}</span>${usageChips(usage.get(p.name))}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
</summary><div class="dq-body">${windows}${PLAN_LINE}
<div class="chips" style="margin:12px 0">${p.models.map((m) => `<span class="chip">claude-code:${esc(m.id)}</span>`).join("")}</div>
<form method="post" action="/ui/settings/providers" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}"><input type="hidden" name="type" value="claude">
<label>${infoLabel("New token from claude setup-token", "A new token replaces the old one at once; control seals it and never shows it again. Tokens from claude setup-token last one year.")}<input name="claude_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the token ending ${esc(p.key_hint)}"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Replace the token</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this subscription</button></form>`
}</div></details>`;
    };
    /** A ChatGPT subscription: its sign-in, its models, and how to sign in again. */
    const chatgptRow = (p: (typeof providers)[number], rigs: string[]) => {
      const pName = encodeURIComponent(p.name);
      const status = p.models_error
        ? `<span class="dq-why bad">${esc(p.models_error)}</span>`
        : `<span class="dq-why">${p.models.length} model${p.models.length === 1 ? "" : "s"} · runs in Pi, OpenCode v2 or Codex · control renews the login</span>`;
      return `<details class="dq${p.models_error ? " dq-bad" : ""}" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Subscription</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· ChatGPT subscription</span></span>${status}<span class="dq-sub"><span class="chip">sign-in ${esc(p.key_hint)}</span>${usageChips(usage.get(p.name))}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
<span class="dq-side"><span class="dq-btns"><form class="inline" method="post" action="/ui/settings/providers/${pName}/refresh"><input type="hidden" name="csrf" value="${t}"><button>Refresh models</button></form></span></span>
</summary><div class="dq-body">${usageBlock("chatgpt", usage.get(p.name), now)}${PLAN_LINE}
<div class="chips" style="margin:12px 0">${p.models.map((m) => `<span class="chip">chatgpt:${esc(m.id)}</span>`).join("")}</div>
<form method="post" action="/ui/settings/add" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}"><input type="hidden" name="type" value="chatgpt"><input type="hidden" name="chatgpt_consent" value="1">
<div style="grid-column:1/-1" class="small">To sign in again (for example after the login ended): <a href="/ui/settings/chatgpt/start?name=${pName}" target="_blank" rel="noopener">Sign in with ChatGPT ↗</a>, then paste the address the tab goes to.</div>
<label style="grid-column:1/-1">${infoLabel("The address the tab went to", `After the sign-in, the tab goes to an address that starts with ${CHATGPT_REDIRECT} and shows an error. Copy that whole address and paste it here.`)}<input name="chatgpt_url" maxlength="4096" placeholder="${esc(CHATGPT_REDIRECT)}?code=…"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Finish the sign-in</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Sign out and delete</button></form>`
}</div></details>`;
    };
    const providerRows = providers
      .map((p) => {
        const rigs = usersOf(p.name);
        if (p.type === "claude") return claudeRow(p, rigs);
        if (p.type === "chatgpt") return chatgptRow(p, rigs);
        const status = p.models_error
          ? `<span class="dq-why bad">${esc(p.models_error)}${p.models.length ? ` (keeping its last list of ${p.models.length})` : ""}</span>`
          : `<span class="dq-why">${p.models.length} model${p.models.length === 1 ? "" : "s"}${allFree(p) ? " · free, from the provider" : ""}${p.models_at ? ` · listed ${esc(ago(p.models_at, now))} ago` : ""}</span>`;
        const list = p.models.length
          ? `<div class="chips">${p.models
              .map(
                (m) =>
                  `<span class="chip"${m.added ? ' title="added by you; the provider does not list it"' : ""}>${esc(m.id)}${m.context_window ? ` <span class="muted">· ${Math.round(m.context_window / 1000)}k</span>` : ""}${m.added ? ` <span class="muted">· yours</span>` : ""}</span>`,
              )
              .join("")}</div>`
          : "";
        const pName = encodeURIComponent(p.name);
        return `<details class="dq${p.models_error ? " dq-bad" : ""}" data-k="provider-${esc(p.name)}"><summary>
<span class="dq-kind"><span class="kind m">Models</span></span>
<span class="dq-main"><span class="dq-head">${esc(p.name)} <span class="muted" style="font-weight:400">· ${esc(TYPES[p.type])}</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(p.base_url || ANTHROPIC_BASE)}</span><span class="chip">${p.key_hint ? `key ${esc(p.key_hint)}` : "no key: its free models"}</span>${p.type === "opencode" ? `<span class="chip info">runs in the OpenCode harness</span>` : isOpencodeOwn(p) ? `<span class="chip info">OpenCode's own: its free models run in the OpenCode harness</span>` : ""}${p.base_url.startsWith("http://") ? `<span class="chip warn">not HTTPS</span>` : ""}<span class="dq-where">${rigs.length ? `used by ${rigs.map((x) => esc(x)).join(", ")}` : "no rig uses it"}</span></span></span>
<span class="dq-side"><span class="dq-btns"><form class="inline" method="post" action="/ui/settings/providers/${pName}/refresh"><input type="hidden" name="csrf" value="${t}"><button>Refresh models</button></form></span></span>
</summary><div class="dq-body">${list}
<form method="post" action="/ui/settings/providers/${pName}/models" class="form-grid"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("A model it does not list", "Some providers serve models their list leaves out. Add one by its id at the provider; it shows as yours.")}<input name="model" maxlength="200" placeholder="its id at the provider"></label><div class="form-end"><button>Add it</button></div></form>
<form method="post" action="/ui/settings/providers" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="name" value="${esc(p.name)}">
<label>${infoLabel("Type", TYPE_TIP)}${typeSelect(p.type)}</label>
<label>${infoLabel("Base URL", BASE_TIP)}<input name="base_url" maxlength="500" value="${esc(p.base_url)}"></label>
<label>${infoLabel("API key", "Control seals a new key at once and never shows it again. Leave it empty to keep the current one.")}<input name="api_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the key ending ${esc(p.key_hint)}"></label>
<div class="form-end row" style="gap:8px"><button class="primary">Save and list its models</button></div></form>
${
  rigs.length
    ? `<div class="muted small">In use: give its rigs another model before deleting it.</div>`
    : `<form class="inline" method="post" action="/ui/settings/providers/${pName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this provider</button></form>`
}</div></details>`;
      })
      .join("");
    const models = "openai anthropic opencode";
    const addForm = `<form method="post" action="/ui/settings/add" class="form-grid" autocomplete="off" id="prov-add" data-says="${esc(JSON.stringify(ADD_SAYS))}"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("Type", `${TYPE_TIP} Git access lets rigs fetch private repositories: a deploy key control makes, or an HTTPS token you paste. MCP servers have their own block, below.`)}<select name="type" id="ptype"><optgroup label="Models by API key">${KEY_TYPES.map((x) => `<option value="${x}">${x === "opencode" ? "OpenCode (its own models)" : TYPES[x]}</option>`).join("")}</optgroup><optgroup label="Subscriptions"><option value="claude">Claude subscription (Pro or Max)</option><option value="chatgpt">ChatGPT subscription (Plus or Pro)</option></optgroup><optgroup label="Git access"><option value="gitkey">A deploy key (control makes it)</option><option value="gittoken">An access token (HTTPS)</option></optgroup><optgroup label="Where rigs run"><option value="ssh">A machine over SSH</option><option value="k8s">A Kubernetes cluster</option><option value="runpod">RunPod (a GPU cloud)</option></optgroup></select></label>
<label>${infoLabel("Name", "How it shows in Thermite, and how rigs and campaigns refer to it: for example my-litellm or github-deploy. Letters, digits, dots, dashes and underscores: capitals become lowercase and spaces become dashes.")}<input name="name" required maxlength="64" pattern="\\s*[A-Za-z0-9][A-Za-z0-9._ \\-]*\\s*" title="Letters, digits, dots, dashes, underscores and spaces" placeholder="for example my-litellm"></label>
<label data-for="${models}">${infoLabel("Base URL", BASE_TIP)}<input name="base_url" maxlength="500" placeholder="https://…/v1 (Anthropic and OpenCode: empty for their own)"></label>
<label data-for="${models}">${infoLabel("API key", "The provider's key. Control seals it at once and never shows it again. OpenCode: leave it empty for its free models.")}<input name="api_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="gitkey gittoken" hidden>${infoLabel("Host", "The Git server this access is for, such as github.com: its name alone. Control and the rigs use the key or token only for repositories on this host, and refuse any other.")}<input name="host" maxlength="253" placeholder="github.com"></label>
<label data-for="gittoken" hidden>${infoLabel("Token", "An access token for the Git host, read-only if the host allows. Control seals it at once and never shows it again.")}<input name="token" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="gittoken" hidden>${infoLabel("User name", "The name the host expects with the token. GitHub takes x-access-token (the default); GitLab takes oauth2.")}<input name="username" maxlength="100" placeholder="x-access-token"></label>
<label data-for="ssh" hidden>${infoLabel("Address", "The machine's host name or IP address, as control reaches it.")}<input name="address" maxlength="253" placeholder="gpu-box.example.com"></label>
<label data-for="ssh" hidden>${infoLabel("SSH port", "The port its SSH server listens on: usually 22.")}<input name="port" value="22" maxlength="5"></label>
<label data-for="ssh" hidden>${infoLabel("User", "The account control logs in as. Give Thermite an account of its own if you can. It needs sudo without a password only to install what is missing, and only when you allow each install; rigs run as this user with rootless Podman.")}<input name="user" maxlength="32" placeholder="thermite"></label>
<label data-for="k8s" hidden style="grid-column:1/-1">${infoLabel("Kubeconfig", "A kubeconfig for the cluster. Control seals it at once and never shows it again. Give it only the rights the placement needs: to create namespaces and, in them, deployments, services, secrets, volume claims and network policies; or, for slots, a role in each slot.")}<textarea name="kubeconfig" class="mono" rows="4" maxlength="262144" placeholder="apiVersion: v1&#10;kind: Config&#10;…"></textarea></label>
<label data-for="k8s" hidden>${infoLabel("Context", "Which cluster and user in the kubeconfig to use. Empty: its current context.")}<input name="context" maxlength="253" placeholder="its current context"></label>
<label data-for="k8s" hidden>${infoLabel("Placement", "Where each rig goes. Namespaces control creates: one namespace per rig, with its own network rules. Slots: namespaces the cluster's operators made for Thermite, with their own quotas and rules; control only deploys into a free one.")}<select name="placement"><option value="created">A namespace control creates for each rig</option><option value="slot">Slots the cluster's operators made</option></select></label>
<label data-for="k8s" hidden>${infoLabel("Namespace for each rig", "For created namespaces: the name of each rig's namespace. {rig} becomes the rig's name.")}<input name="namespace_pattern" maxlength="63" value="thermite-{rig}"></label>
<label data-for="k8s" hidden>${infoLabel("Slots", "For slots: the slot namespaces, separated by commas. Control checks that it may deploy into each one.")}<input name="slots" maxlength="2000" placeholder="thermite-slot-1, thermite-slot-2"></label>
<label data-for="k8s" hidden style="grid-column:1/-1">${infoLabel("Unchecked connection", UNCHECKED_TIP)}<span class="row small" style="gap:8px"><input type="checkbox" name="unchecked" value="1" style="height:auto;width:auto"> ${UNCHECKED_LABEL}.</span></label>
<div data-for="claude" hidden class="card flat" style="grid-column:1/-1;padding:12px 14px"><b>Get the token on your own computer.</b> <span class="muted small">Control cannot open Anthropic's sign-in page for you.</span><ol class="small" style="margin:8px 0 0 18px;line-height:1.7"><li>Install Claude Code there, if it is not installed: <code>npm install -g @anthropic-ai/claude-code</code></li><li>Run <code>claude setup-token</code> and sign in with your Claude account in the browser.</li><li>Copy the token it prints, and paste it below. It is good for one year.</li></ol></div>
<label data-for="claude" hidden style="grid-column:1/-1">${infoLabel("Token from claude setup-token", "The long-lived token that Claude Code prints. Control seals it at once and never shows it again. Only Claude Code, Anthropic's own program, uses it on the rigs: Anthropic does not allow other programs to use a subscription.")}<input name="claude_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="sk-ant-oat01-… never shown again"></label>
<div data-for="chatgpt" hidden class="card flat" style="grid-column:1/-1;padding:12px 14px"><b>Sign in with ChatGPT, then paste one address.</b> <span class="muted small">For your own use only: a Thermite that several people use takes API keys.</span><ol class="small" style="margin:8px 0 0 18px;line-height:1.7"><li>Press <b>Sign in with ChatGPT</b>. A ChatGPT page opens in a new tab. Sign in there and allow Thermite.</li><li>The tab then goes to an address that starts with <code>${esc(CHATGPT_REDIRECT)}</code> and shows an error. That is expected: the address is for an app on your own computer.</li><li>Copy that whole address from the tab's address bar, and paste it below.</li></ol><div class="act" style="margin-top:10px"><a class="btn sm" href="/ui/settings/chatgpt/start" target="_blank" rel="noopener">Sign in with ChatGPT ↗</a></div></div>
<label data-for="chatgpt" hidden style="grid-column:1/-1">${infoLabel("The address the tab went to", `After the sign-in, the tab goes to an address that starts with ${CHATGPT_REDIRECT} and shows an error. Copy that whole address and paste it here. It holds a one-time code that control exchanges for the login; it works for a few minutes only.`)}<input name="chatgpt_url" maxlength="4096" placeholder="${esc(CHATGPT_REDIRECT)}?code=…"></label>
<label data-for="chatgpt" hidden style="grid-column:1/-1">${infoLabel("Unattended use", "OpenAI asks apps to get your consent before they use your plan when you are not there. Thermite's agents work for hours without you: workers, the planner and the advisors, on the rigs you give its models.")}<span class="row small" style="gap:8px"><input type="checkbox" name="chatgpt_consent" value="1" style="height:auto;width:auto"> I allow Thermite's agents to use my ChatGPT plan when I am not there, for my own research.</span></label>
<label data-for="runpod" hidden>${infoLabel("RunPod API key", "A key from RunPod's console (Settings, API Keys). Control seals it at once and never shows it again. Control reads the account with it, and starts test pods only when you ask: for those the key must be allowed to write.")}<input name="runpod_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="never shown again"></label>
<label data-for="ssh" hidden style="grid-column:1/-1">${infoLabel("Private key", "The SSH private key for that user, without a passphrase. Control seals it at once and never shows it again. Leave it empty and control makes a key: add its public half, shown next, to the user's ~/.ssh/authorized_keys on the machine.")}<textarea name="private_key" class="mono" rows="4" maxlength="16384" placeholder="empty: control makes a key"></textarea></label>
<div class="nc-does" id="pdo" style="grid-column:1/-1"><b>What happens.</b> ${ADD_SAYS.openai[1]}</div>
<div class="form-end"><button class="primary" id="padd">${ADD_SAYS.openai[0]}</button></div></form>`;
    const options = (want: { provider: string; model: string } | undefined) =>
      `<option value=""${want ? "" : " selected"}>its own settings</option>${providers
        .filter((p) => p.models.length)
        .map(
          (p) =>
            `<optgroup label="${esc(p.name)}${p.type === "claude" ? " (Claude subscription: runs in Claude Code)" : p.type === "chatgpt" ? " (ChatGPT subscription: Pi, OpenCode or Codex)" : p.type === "opencode" ? " (OpenCode harness only)" : isOpencodeOwn(p) ? " (free models: OpenCode harness only)" : ""}">${p.models
              .map(
                (m) =>
                  `<option value="${esc(`${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`)}"${want?.provider === p.name && want.model === m.id ? " selected" : ""}>${modelPrefix(p.type)}${esc(m.id)}</option>`,
              )
              .join("")}</optgroup>`,
        )
        .join("")}`;
    const rigRows = vs
      .map((u) => {
        const m = u.model;
        const want = given[u.id];
        // A cap on the model's context window (goal 070), once the rig runs that model.
        const capped =
          want?.contextCap && m?.name === want.provider && m.model === want.model
            ? capWords(
                store.modelProviders.get(want.provider)?.models.find((x) => x.id === want.model)
                  ?.context_window ?? 0,
                want.contextCap,
              )
            : undefined;
        // Its compaction point (goal 070), with the model it was set with.
        const compacts =
          want && m?.name === want.provider && m.model === want.model
            ? ` Its conversations are compacted at ${compactAtWords(want.compactAt)}.`
            : "";
        const uses = !m
          ? "Its harness does not report its model (it needs a newer image)."
          : m.source === "control"
            ? `Its agents run under ${HARNESS_NAMES[m.harness]} with ${m.model} from ${m.name}.${capped ? ` Its context window: ${capped}.` : ""}${compacts}`
            : m.source === "environment"
              ? `Its agents use the rig's own settings (${m.model}, under ${HARNESS_NAMES[m.harness]}).`
              : "Its agents have no model: they wait.";
        const taking = takingModel(m, want);
        const moving = !taking
          ? ""
          : want
            ? ` <span class="chip info">taking ${esc(want.model)} under ${esc(HARNESS_NAMES[want.harness])}</span>`
            : ` <span class="chip info">going back to its own settings</span>`;
        // The model check in its state now: sent, running, its result, or why it did not run.
        const chk =
          checkRowsOf(store, u.id, u.checks, now).model ??
          checkRow("model", undefined, undefined, now);
        const waits = checkWaits(chk);
        const bad = chk.state === "failed" || chk.state === "refused" || chk.state === "expired";
        // The page follows the rig while it takes the model, then its check (goal 080).
        const follow = taking
          ? ` data-follow="${esc(modelFollowUrl(u.id))}" data-follow-state="taking"`
          : waits
            ? ` data-follow="${esc(checkFollowUrl(u.id, "model"))}" data-follow-state="${chk.state}"`
            : "";
        return `<div class="ck rr-route"${follow}><span class="ck-res"><a href="/ui/rigs/${encodeURIComponent(u.id)}"><b>${esc(u.id)}</b></a></span><span class="ck-main"><span>${esc(uses)}${moving}</span><span class="ck-sum ${bad ? "bad" : ""}">${modelCheckHtml(chk, now)}</span></span><span class="route-acts"><form class="inline" method="post" action="/ui/settings/rigs" data-act><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="rig" value="${esc(u.id)}"><select name="harness" class="harness" aria-label="harness for ${esc(u.id)}">${HARNESSES.map((h) => `<option value="${h}"${(want?.harness ?? "pi") === h ? " selected" : ""}>${HARNESS_NAMES[h]}</option>`).join("")}</select><select name="choice" aria-label="model for ${esc(u.id)}">${options(want)}</select><button>Use</button></form>${cmdForm(c, { rig: u.id, kind: "rig_check", fields: { check: "model" }, label: "Check", back: "/ui/settings", disabled: waits })}</span></div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Providers",
        active: "settings",
        crumbs: [{ href: "/ui/settings", text: "Settings" }],
      },
      `<p class="run-said">Providers are what Thermite uses: model providers serve the agents' models, Git access lets rigs fetch private repositories, and machines, clusters and GPU clouds are where rigs run. MCP servers give the agents tools from outside Thermite. Add each once with its sign-in or key. Control seals every secret, never shows it again, and gives a rig only what it uses. Then choose, for each rig, the harness its agents run in (Pi, OpenCode v2, Claude Code or Codex) and their model.</p>
${note}
<div class="block"><div class="head"><h2>Providers</h2><span class="n">${providers.length + gitCount}</span><span class="right">models are read from each provider itself</span></div>${providers.length + gitCount ? `<div class="dqs">${providerRows}${gitRows(t)}${machineRows(t)}${clusterRows(t)}${cloudRows(t)}</div>` : `<div class="card"><div class="empty">No provider yet: add one below.</div></div>`}</div>
${prices}
<div class="block"><div class="head"><h2>Add a provider</h2></div><div class="card">${addForm}</div></div>
${mcpSettingsBlocks(store, mcpServers, t, now, (k) => (k === "error" ? said(c) : c.req.query(k)))}
${reachBlock(store, t, now, (k) => c.req.query(k))}
<div class="block" data-part="routes"><div class="head"><h2>Harness and model for each rig</h2><span class="right">a rig takes a change within a minute; then check it</span></div><div class="card flat">${rigRows || `<div class="empty">No rig has reported yet.</div>`}</div></div>
<script src="/ui/assets/providers.js" defer></script>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- Git access (Settings)
  const gitRows = (t: string) =>
    store.gitAccess
      .list()
      .map((g) => {
        const users = store.campaigns.usingGitAccess(g.name);
        const gName = encodeURIComponent(g.name);
        const ssh = g.kind === "ssh";
        return `<details class="dq" data-k="git-${esc(g.name)}"><summary>
<span class="dq-kind"><span class="kind g">Git access</span></span>
<span class="dq-main"><span class="dq-head">${esc(g.name)} <span class="muted" style="font-weight:400">· ${ssh ? "SSH deploy key" : "HTTPS token"}</span></span><span class="dq-why">${ssh ? `fingerprint ${esc(g.fingerprint ?? "")}` : `token ${esc(g.hint)}${g.username ? ` · user ${esc(g.username)}` : ""}`}</span><span class="dq-sub"><span class="dq-where">${g.host ? `for ${esc(g.host)} only` : `<b class="bad">for no host yet</b>`}, ${ssh ? "with ssh:// and git@host:path addresses" : "with https:// addresses"}</span><span class="dq-where">${users.length ? `used by ${users.map((x) => esc(x)).join(", ")}` : "no campaign uses it"}</span></span></span>
</summary><div class="dq-body">${
          g.host
            ? ""
            : `<form method="post" action="/ui/settings/git/${gName}/host" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("Host", "The Git server this access is for, such as github.com. Until it has one, control and the rigs use it nowhere: campaigns that name it can't start.")}<input name="host" required maxlength="253" placeholder="github.com"></label><div class="form-end"><button class="primary">Set the host</button></div></form>`
        }${
          ssh && g.public_key
            ? `<div class="muted small" style="margin:0 0 4px">Add this public key to the repository (or the account) as a <b>read-only</b> deploy key. Its private half stays sealed in control.</div><pre class="json" style="white-space:pre-wrap;word-break:break-all">${esc(g.public_key)}</pre>`
            : ""
        }
<form method="post" action="/ui/settings/git/${gName}/test" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("Try it on a repository", `Control reads the repository's branches with this ${ssh ? "key" : "token"}, as a rig would fetch it, and says what it found. Nothing is changed or kept.`)}<input name="url" required maxlength="500" placeholder="${ssh ? "git@github.com:you/project.git" : "https://github.com/you/project.git"}"></label><div class="form-end"><button>Try it</button></div></form>${
          ssh
            ? ""
            : `
<form method="post" action="/ui/settings/git/${gName}/token" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("New token", "Replaces the token under the same name, so campaigns that use it keep working. Control seals it at once and never shows it again.")}<input name="token" type="password" autocomplete="new-password" maxlength="4096" required placeholder="replaces the token ending ${esc(g.hint)}"></label><div class="form-end"><button class="primary">Replace the token</button></div></form>`
        }
${
  users.length
    ? `<div class="muted small">In use by ${users.map((x) => esc(x)).join(", ")}: their runs fetch with it, so it can't be deleted.</div>`
    : `<form class="inline" method="post" action="/ui/settings/git/${gName}/delete"><input type="hidden" name="csrf" value="${t}"><button class="danger">Delete this Git access</button></form>`
}</div></details>`;
      })
      .join("");
  // ---------------------------------------------------------------- machines (Providers)
  // A machine control sets rigs up on, over SSH. Its host key is trusted once by the owner;
  // its facts come from a read-only check (machines/facts.ts).
  const kib = (n: number) => `${Math.round(n / 1024 / 1024)} GB`;
  const machineFacts = (m: Machine, t: string) => {
    const f = m.facts as MachineFacts | null;
    if (!f) return "";
    const need = missing(f);
    const installs = store.machines.installs(m.name);
    const running = installs.find((i) => i.started_at && !i.finished_at);
    const last = installs.find((i) => i.finished_at);
    const mName = encodeURIComponent(m.name);
    // Each missing piece: what control would run, and the owner's yes or no.
    const asks = running
      ? `<div class="card" style="margin-top:10px"><b>Installing ${esc(RECIPES[running.recipe as RecipeId]?.title ?? running.recipe)}</b>, as ${esc(running.approved_by)} allowed ${esc(ago(running.approved_at, Date.now()))} ago. This page shows when it is done.</div>`
      : need
          .map((id) => {
            const r = RECIPES[id];
            const s = recipeScript(id, f);
            if ("error" in s)
              return `<div class="card warn" style="margin-top:10px"><b>${esc(r.title)} is missing.</b> ${esc(r.why)} Control won't install it: ${esc(s.error)}.</div>`;
            return `<div class="card warn" style="margin-top:10px"><b>May control install ${esc(r.title)}?</b> ${esc(r.why)} Control would run exactly this on ${esc(m.name)}, and nothing else:<pre class="json" style="white-space:pre-wrap;margin:8px 0">${esc(s.script)}</pre><div class="act"><form class="inline" method="post" action="/ui/settings/machines/${mName}/install"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="recipe" value="${id}"><input type="hidden" name="sha" value="${scriptSha(s.script)}"><button class="sm primary">Install it</button></form><form class="inline" method="post" action="/ui/settings/machines/${mName}/decline"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="recipe" value="${id}"><button class="sm">Don't install: I'll do it myself</button></form></div><div class="muted small" style="margin-top:6px">Your yes is recorded with your name, for this script on this machine, and used once.</div></div>`;
          })
          .join("");
    const lastRun = last
      ? `<div class="muted small" style="margin-top:10px">Last install: ${esc(RECIPES[last.recipe as RecipeId]?.title ?? last.recipe)}, allowed by ${esc(last.approved_by)}, ${last.ok ? `<span class="chip ok">done</span>` : `<span class="chip bad">failed</span>`} ${esc(ago(last.finished_at ?? "", Date.now()))} ago.${last.ok ? "" : `</div><pre class="json" style="white-space:pre-wrap;max-height:200px;overflow:auto">${esc(last.output ?? "")}</pre><div>`}</div>`
      : "";
    const yes = (ok: boolean, text: string) =>
      `<span class="chip ${ok ? "ok" : "warn"}">${esc(text)}</span>`;
    const control = !parts.publicUrl
      ? `<span class="muted">control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL), so this was not checked</span>`
      : `${esc(parts.publicUrl)} ${yes(f.reaches_control === "200", f.reaches_control === "200" ? "reached" : `not reached (${f.reaches_control ?? "no answer"})`)}`;
    return `<dl class="facts" style="margin-top:4px">
<dt>System</dt><dd>${esc(f.os)} · kernel ${esc(f.kernel)} · ${esc(f.arch)} · ${f.cpus} CPUs · ${kib(f.mem_kib)} memory · ${kib(f.disk_free_kib)} free for ${esc(f.user)}</dd>
<dt>GPUs</dt><dd>${
      f.gpus.length
        ? `${f.gpus.map((g) => `GPU ${g.index}: ${esc(g.name)}, ${Math.round(g.memory_mib / 1024)} GB, ${g.busy_pct}% busy, ${g.used_mib} MiB in use`).join("<br>")}<br><span class="muted">driver ${esc(f.driver ?? "?")} · CUDA ${esc(f.cuda ?? "?")}</span>`
        : `none: rigs here measure on the CPU`
    }</dd>
<dt>Containers</dt><dd>${f.podman ? yes(true, `Podman ${f.podman}`) : yes(false, "Podman missing")}${f.docker ? ` <span class="muted">Docker ${esc(f.docker)} (rigs use Podman)</span>` : ""}${f.gpus.length ? ` ${yes(Boolean(f.nvidia_ctk && f.cdi), f.nvidia_ctk ? (f.cdi ? `NVIDIA container toolkit ${f.nvidia_ctk} · CDI` : "NVIDIA container toolkit, no CDI spec") : "NVIDIA container toolkit missing")}` : ""}</dd>
<dt>Services</dt><dd>${f.systemd ? `systemd ${esc(f.systemd)}` : yes(false, "no systemd: control runs rigs as systemd services, so a rig can't run here")}${f.root || f.linger === undefined ? "" : ` · ${f.linger ? yes(true, "lingering on") : yes(false, "lingering off: rigs would stop when the user logs out")}`}</dd>
<dt>Rights</dt><dd>${f.root ? "root" : f.sudo ? "sudo without a password (used only for installs you allow)" : "no sudo: control can't install anything, only report what is missing"}</dd>
<dt>Reaches control</dt><dd>${control}</dd>
</dl>${need.length ? `<div class="muted" style="margin-top:10px"><b>Missing for a rig:</b> ${need.map((x) => esc(RECIPES[x].title)).join("; ")}.</div>` : ""}${asks}${lastRun}`;
  };
  const machineRows = (t: string) =>
    store.machines
      .list()
      .map((m) => {
        const mName = encodeURIComponent(m.name);
        const trusted = m.host_keys.length > 0;
        const f = m.facts as MachineFacts | null;
        const changed =
          trusted &&
          m.seen_host_keys.length > 0 &&
          m.seen_host_keys.join("\n") !== m.host_keys.join("\n");
        const keyList = (lines: string[]) =>
          lines
            .map((l) => {
              const [, type, key] = l.split(/\s+/);
              return `<code>${esc(fingerprintOf(key ?? ""))}</code> <span class="muted">(${esc((type ?? "").replace(/^ssh-/, "").toUpperCase())})</span>`;
            })
            .join("<br>");
        const status = !trusted
          ? `<span class="dq-why bad">its host key is not trusted yet: open it to compare and trust it</span>`
          : m.check_error
            ? `<span class="dq-why bad">${esc(m.check_error)}${f ? " (showing the last check)" : ""}</span>`
            : f
              ? `<span class="dq-why">${esc(factsLine(f))}${m.checked_at ? ` · checked ${esc(ago(m.checked_at, Date.now()))} ago` : ""}</span>`
              : `<span class="dq-why">not checked yet</span>`;
        const form = (action: string, label: string, primary = false, extra = "") =>
          `<form class="inline" method="post" action="/ui/settings/machines/${mName}/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="sm${primary ? " primary" : ""}">${label}</button></form>`;
        const trust = (lines: string[], label: string) =>
          form(
            "trust",
            label,
            true,
            `<input type="hidden" name="seen" value="${esc(lines.join("\n"))}">`,
          );
        const hostKey = !trusted
          ? m.seen_host_keys.length
            ? `<div class="card warn" style="margin-bottom:10px"><b>Check the host key.</b> The machine presented:<br>${keyList(m.seen_host_keys)}<br>If you know its fingerprint (on the machine: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>), compare it. Control pins these keys, and later refuses a machine that presents another. <div class="act" style="margin-top:8px">${trust(m.seen_host_keys, "It matches: trust it")}${form("scan", "Read it again")}</div></div>`
            : `<div class="card warn" style="margin-bottom:10px"><b>No SSH server answered</b> at ${esc(m.address)} port ${m.port}. <div class="act" style="margin-top:8px">${form("scan", "Read its host key again")}</div></div>`
          : changed
            ? `<div class="card warn" style="margin-bottom:10px"><b>The machine now presents a different host key:</b><br>${keyList(m.seen_host_keys)}<br>If the machine was reinstalled, compare it and trust the new key. If not, someone may be in between: don't. <div class="act" style="margin-top:8px">${trust(m.seen_host_keys, "Trust the new key")}</div></div>`
            : "";
        return `<details class="dq${!trusted || m.check_error ? " dq-bad" : ""}" data-k="machine-${esc(m.name)}"${!trusted ? " open" : ""}><summary>
<span class="dq-kind"><span class="kind r">Machine</span></span>
<span class="dq-main"><span class="dq-head">${esc(m.name)} <span class="muted" style="font-weight:400">· SSH</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(m.user)}@${esc(m.address)}${m.port === 22 ? "" : `:${m.port}`}</span><span class="chip">key ${esc(m.key_fingerprint.slice(-6))}</span>${trusted ? `<span class="dq-where">host key ${esc(fingerprintOf(m.host_keys[0]?.split(/\s+/)[2] ?? "").slice(0, 19))}…</span>` : ""}</span></span>
<span class="dq-side"><span class="dq-btns">${trusted ? form("check", "Check again") : ""}</span></span>
</summary><div class="dq-body">${hostKey}${machineFacts(m, t)}
<div class="muted small" style="margin:10px 0 4px">Control logs in as ${esc(m.user)} with this key. Put this line in that user's <code>~/.ssh/authorized_keys</code> on the machine: <code>restrict</code> turns off forwarding and terminals, which control does not use.</div><pre class="json" style="white-space:pre-wrap;word-break:break-all">restrict ${esc(m.public_key)}</pre>
${form("delete", "Delete this machine", false).replace('class="sm"', 'class="sm danger"')}</div></details>`;
      })
      .join("");

  // ---------------------------------------------------------------- clusters (Providers)
  // A Kubernetes cluster control sets rigs up on, with its kubeconfig sealed. Its facts come from
  // a read-only check (clusters/facts.ts).
  const clusterRows = (t: string) =>
    store.clusters
      .list()
      .map((k) => {
        const f = k.facts as ClusterFacts | null;
        const kName = encodeURIComponent(k.name);
        const rigsHere = store.clusters.rigs(k.name).filter((r) => r.status !== "removed");
        const unchecked = k.unchecked
          ? ` <span class="chip warn" title="${esc(k.unchecked.what.join("; "))}">connection not checked: you accepted it ${esc(ago(k.unchecked.at, Date.now()))} ago</span>`
          : "";
        const status = k.check_error
          ? `<span class="dq-why bad">${esc(k.check_error)}${f ? " (showing the last check)" : ""}</span>`
          : f
            ? `<span class="dq-why">${esc(clusterLine(f))}${k.checked_at ? ` · checked ${esc(ago(k.checked_at, Date.now()))} ago` : ""}</span>`
            : `<span class="dq-why">not checked yet</span>`;
        const where =
          k.placement === "created"
            ? `a namespace for each rig: ${k.namespace_pattern}`
            : `slots: ${k.slots.join(", ") || "none named"}`;
        const yes = (ok: boolean, text: string) =>
          `<span class="chip ${ok ? "ok" : "warn"}">${esc(text)}</span>`;
        const facts = f
          ? `<dl class="facts"><dt>Version</dt><dd>${esc(f.version)}</dd><dt>Nodes</dt><dd>${
              f.nodes
                .map(
                  (n) =>
                    `${esc(n.name)}: ${n.ready ? "ready" : `<span class="bad">not ready</span>`}, ${esc(n.cpu)} CPUs, ${esc(n.memory)} memory${n.gpus ? `, <b>${n.gpus} GPU${n.gpus === 1 ? "" : "s"}</b>${n.gpu_product ? ` (${esc(n.gpu_product)})` : ""}` : ""}`,
                )
                .join("<br>") || "none listed (the kubeconfig may not read nodes)"
            }</dd><dt>GPUs</dt><dd>${f.nodes.some((n) => n.gpus) ? yes(true, "NVIDIA's device plugin") : yes(false, "no device-plugin GPUs")} ${f.device_classes.length ? yes(true, `DRA: ${f.device_classes.join(", ")}`) : `<span class="muted">no DRA device classes</span>`}</dd><dt>Storage</dt><dd>${f.storage_classes.map((s) => `${esc(s.name)}${s.default ? " (default)" : ""}`).join(", ") || yes(false, "no storage class")}</dd><dt>Placement</dt><dd>${
              k.placement === "created"
                ? f.can_create_namespaces
                  ? yes(true, "control may create namespaces")
                  : yes(
                      false,
                      "control may not create namespaces: use slots, or give the kubeconfig that right",
                    )
                : f.slots
                    .map(
                      (s) =>
                        `${esc(s.namespace)}: ${s.usable ? (s.used_by ? `used by rig ${esc(s.used_by)}` : s.network_ok === false ? yes(false, `refused: ${s.network_why ?? "its network rules don't keep the harness off the cluster"}`) : yes(true, "free")) : yes(false, "control may not deploy here")}`,
                    )
                    .join("<br>") || "no slots named"
            }</dd></dl>`
          : "";
        const form = (action: string, label: string, cls = "sm") =>
          `<form class="inline" method="post" action="/ui/settings/clusters/${kName}/${action}"><input type="hidden" name="csrf" value="${t}"><button class="${cls}">${label}</button></form>`;
        return `<details class="dq${k.check_error ? " dq-bad" : ""}" data-k="cluster-${esc(k.name)}"><summary>
<span class="dq-kind"><span class="kind r">Cluster</span></span>
<span class="dq-main"><span class="dq-head">${esc(k.name)} <span class="muted" style="font-weight:400">· Kubernetes</span></span>${status}<span class="dq-sub"><span class="dq-where">${esc(k.context || "its current context")}</span><span class="dq-where">${esc(where)}</span><span class="dq-where">${rigsHere.length ? `runs ${rigsHere.map((r) => esc(r.rig)).join(", ")}` : "no rig yet"}</span>${unchecked}</span></span>
<span class="dq-side"><span class="dq-btns">${form("check", "Check again")}</span></span>
</summary><div class="dq-body">${facts}${
          k.placement === "slot"
            ? `<form method="post" action="/ui/settings/clusters/${kName}/slots" class="form-grid" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}"><label style="grid-column:1/-1">${infoLabel("Slots", "The namespaces the cluster's operators made for Thermite, which control may use, one rig each: names separated by commas or spaces. Control reads each one again when you save.")}<input name="slots" value="${esc(k.slots.join(", "))}"></label><div class="form-end"><button>Save the slots</button></div></form>`
            : ""
        }${
          rigsHere.length
            ? `<div class="muted small" style="margin-top:10px">In use by ${rigsHere.map((r) => esc(r.rig)).join(", ")}: remove those rigs before deleting it.</div>`
            : `<div style="margin-top:10px">${form("delete", "Delete this cluster", "sm danger")}</div>`
        }</div></details>`;
      })
      .join("");

  // ---------------------------------------------------------------- GPU clouds (Providers)
  // RunPod, read with the owner's key (runpod.ts): GPU types, prices and stock, data centers,
  // network volumes and pods. Control starts nothing there yet.
  const STOCK: Record<string, string> = {
    HIGH: "high",
    MEDIUM: "medium",
    LOW: "low",
    NONE: "none",
  };
  // Test pods: the quick form, and each test with what it found.
  const testPodForm = (gName: string, f: RunpodFacts | null, t: string) => {
    const cheapest = f ? cheapestGpu(f, "SECURE") : undefined;
    const options = (f?.gpus ?? [])
      .filter((x) => x.secure || x.community)
      .map(
        (x) =>
          `<option value="${esc(x.id)}" data-secure="${x.secure ? (x.price_secure ?? "") : ""}" data-community="${x.community ? (x.price_community ?? "") : ""}">${esc(x.name)} · ${x.memory_gb} GB · Secure ${x.secure ? usd(x.price_secure) : "–"}, Community ${x.community ? usd(x.price_community) : "–"}${x.availability ? ` · Secure stock ${esc(STOCK[x.availability] ?? x.availability)}` : ""}</option>`,
      )
      .join("");
    return `<form method="post" action="/ui/settings/clouds/${gName}/test" class="form-grid" data-test-pod autocomplete="off" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("GPU", "The GPU type of the test pod. The cheapest in stock is enough: the test checks the platform, not speed.")}<select name="gpu"><option value="" data-secure="${cheapest?.price_secure ?? ""}" data-community="">${cheapest ? `The cheapest in stock: ${esc(cheapest.name)}` : "The cheapest in stock"}</option>${options}</select></label>
<label>${infoLabel("Cloud", "Secure cloud runs in RunPod's own data centers. Community cloud runs on hosts other people rent out: cheaper, less predictable. Rigs whose judge times code belong on Secure.")}<select name="cloud_type"><option value="SECURE">Secure</option><option value="COMMUNITY">Community</option></select></label>
<label style="grid-column:1/-1">${infoLabel("Image", "What the pod runs: Thermite's CUDA harness image, or the one-container rig image that a rig on RunPod starts from. Its isolation self-test then also checks the supervisor's places. The image must be at a registry RunPod can pull from. Control's THERMITE_RUNPOD_TEST_IMAGE setting fills it in.")}<input name="image" required maxlength="300" value="${esc(opts.runpodTests?.defaultImage() ?? "")}" placeholder="for example ghcr.io/you/thermite-harness:1a2b3c4d5e6f-cuda"></label>
<label>${infoLabel("Disk (GB)", "The pod's container disk, gone with the pod. The harness image needs about 15 GB.")}<input name="disk_gb" type="number" min="10" max="2000" value="${DEFAULT_DISK_GB}"></label>
<label>${infoLabel("End it after (minutes)", "Optional. Control removes the pod after this many minutes, whatever the test is doing. Empty: the pod runs until the test ends, or until you end it here.")}<input name="stop_after_minutes" type="number" min="5" placeholder="no limit"></label>
<label style="grid-column:1/-1">${infoLabel("Stop and start it again", "After the first report, control stops the pod and starts it again, to see that it gets its GPU back. RunPod can start a stopped pod without a GPU when someone took it meanwhile.")}<span class="row small" style="gap:8px"><input type="checkbox" name="restart" value="1" checked style="height:auto;width:auto"> Stop the pod after its report, start it again, and read its report once more</span></label>
<div class="nc-does" style="grid-column:1/-1" data-test-say><b>What happens.</b> Control starts one pod of the image on the chosen GPU, billed by RunPod by the second. The pod checks root, capabilities, the GPU device nodes, RunPod's variables and outbound HTTPS, then runs Thermite's isolation self-test. Control reads its report, and removes the pod when the test ends.</div>
<div class="form-end"><button>Start a test pod</button></div></form>`;
  };
  const testCard = (x: TestView, gName: string, t: string) =>
    `<div class="card flat" style="margin-top:8px"><div><b>Test ${esc(x.id)}</b> · ${esc(x.gpu_name)}, ${x.cloud_type === "SECURE" ? "Secure" : "Community"} · ${usd(x.price_per_hr)}/h <span class="chip ${x.outcome === "passed" ? "ok" : x.outcome === "running" ? "info" : "warn"}">${esc(x.outcome)}</span></div>
<div class="muted small">${esc(x.phase_words)} · cost ${x.active ? "so far " : ""}${usd(x.cost_usd)} · started ${esc(ago(x.started_at, Date.now()))} ago by ${esc(x.created_by)}${x.datacenter ? ` · ${esc(x.datacenter)}` : ""} · pod ${esc(x.pod_id)}</div>
${x.error ? `<div class="dq-why bad">${esc(x.error)}</div>` : ""}${x.findings.length ? `<ul class="small" style="margin:6px 0 0 18px">${x.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}${x.notes.length ? `<div class="muted small">${x.notes.map(esc).join(" ")}</div>` : ""}
<div class="small" style="margin-top:6px"><a href="/ui/settings/clouds/${gName}/tests/${encodeURIComponent(x.id)}.json">The whole report (JSON)</a>${x.active ? ` <form class="inline" method="post" action="/ui/settings/clouds/${gName}/tests/${encodeURIComponent(x.id)}/end"><input type="hidden" name="csrf" value="${t}"><button class="sm danger">End it now: remove the pod</button></form>` : ""}</div></div>`;
  const testSection = (gName: string, cloud: string, f: RunpodFacts | null, t: string) => {
    const tests = opts.runpodTests?.list(cloud, 5) ?? [];
    const busy = tests.some((x) => x.active);
    return `<h4 style="margin:14px 0 4px">Test pods</h4><div class="muted small">A test pod checks that a rig can run on RunPod. One at a time.</div>${tests.map((x) => testCard(x, gName, t)).join("")}${busy ? "" : testPodForm(gName, f, t)}`;
  };
  const cloudRows = (t: string) =>
    store.gpuClouds
      .list()
      .map((g) => {
        const f = g.facts as RunpodFacts | null;
        const gName = encodeURIComponent(g.name);
        const status = g.check_error
          ? `<span class="dq-why bad">${esc(g.check_error)}${f ? " (showing the last read)" : ""}</span>`
          : f
            ? `<span class="dq-why">${esc(runpodLine(f))}${g.checked_at ? ` · read ${esc(ago(g.checked_at, Date.now()))} ago` : ""}</span>`
            : `<span class="dq-why">not read yet</span>`;
        const running = f?.pods.filter((p) => p.cost_per_hr > 0) ?? [];
        const form = (action: string, label: string, cls = "sm", extra = "") =>
          `<form class="inline" method="post" action="/ui/settings/clouds/${gName}/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
        const gpus = f?.gpus.length
          ? `<div class="card flat" style="margin-top:6px;max-height:340px;overflow:auto"><table><thead><tr><th>GPU</th><th class="num">Memory</th><th class="num">Secure, per GPU-hour</th><th class="num">Community, per GPU-hour</th><th>Secure stock</th></tr></thead><tbody>${f.gpus
              .map(
                (x) =>
                  `<tr><td>${esc(x.name)}</td><td class="num">${x.memory_gb} GB</td><td class="num">${x.secure ? usd(x.price_secure) : "–"}</td><td class="num">${x.community ? usd(x.price_community) : "–"}</td><td>${x.availability ? esc(STOCK[x.availability] ?? x.availability.toLowerCase()) : "–"}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : "";
        const sp = f?.spend;
        const tests = opts.runpodTests?.list(g.name, 200) ?? [];
        const testCost = tests.reduce((t, x) => t + (x.cost_usd ?? 0), 0);
        const spendFacts = sp
          ? `<dt>${infoLabel("Spend", "What this RunPod account spent, from RunPod's billing: pods, storage and the rest, in US dollars. Read with the rest of the account, every 15 minutes and on Read again.")}</dt><dd>${
              sp.error
                ? `<span class="bad">${esc(sp.error)}</span>`
                : `today <b>${usd(sp.today)}</b> · this month <b>${usd(sp.month)}</b> · last 30 days <b>${usd(sp.last30)}</b>${running.length ? ` · running now <b>${usd(running.reduce((t, x) => t + x.cost_per_hr, 0))}/h</b>` : ""}${
                    sp.days.length
                      ? `<br><span class="muted small">${sp.days.map((d) => `${esc(d.day.slice(5))} ${usd(d.usd)}`).join(" · ")}</span>`
                      : ""
                  }`
            }</dd>`
          : "";
        const testFacts = tests.length
          ? `<dt>${infoLabel("Thermite's test pods", "What the test pods started from this account cost, from their run times and RunPod's price for each.")}</dt><dd>${usd(Math.round(testCost * 100) / 100)} over ${tests.length} test${tests.length === 1 ? "" : "s"}</dd>`
          : "";
        const facts = f
          ? `<dl class="facts">${spendFacts}${testFacts}<dt>Pods</dt><dd>${
              f.pods
                .map(
                  (p) =>
                    `${esc(p.name || p.id)}: ${esc(p.status.toLowerCase())}${p.gpus ? `, ${p.gpus} GPU${p.gpus === 1 ? "" : "s"}` : ""}${p.cost_per_hr ? `, <b>${usd(p.cost_per_hr)}/h</b>` : ""}`,
                )
                .join("<br>") || "none"
            }</dd><dt>Network volumes</dt><dd>${f.volumes.map((v) => `${esc(v.name || v.id)}: ${v.size_gb} GB in ${esc(v.datacenter)}`).join("<br>") || "none"}</dd><dt>Data centers</dt><dd>${f.datacenters.map((d) => esc(d.id)).join(", ") || "none listed"}</dd></dl>${gpus}<div class="muted small" style="margin-top:6px">Prices are RunPod's list prices when control last read them. RunPod bills a pod while it runs, and storage while it exists.</div>`
          : "";
        return `<details class="dq${g.check_error ? " dq-bad" : ""}" data-k="cloud-${esc(g.name)}"><summary>
<span class="dq-kind"><span class="kind r">GPU cloud</span></span>
<span class="dq-main"><span class="dq-head">${esc(g.name)} <span class="muted" style="font-weight:400">· RunPod</span></span>${status}<span class="dq-sub"><span class="chip">key ${esc(g.key_hint)}</span><span class="chip info">control starts only the pods you ask for</span>${opts.runpodTests?.list(g.name, 1).some((x) => x.active) ? `<span class="chip warn">a test pod is running</span>` : ""}${running.length ? `<span class="chip warn">${running.length} pod${running.length === 1 ? "" : "s"} running: billed while they run</span>` : ""}</span></span>
<span class="dq-side"><span class="dq-btns">${form("check", "Read again")}<a class="btn sm" href="/ui/rigs/add/runpod?cloud=${gName}">Launch a rig</a></span></span>
</summary><div class="dq-body">${facts}${testSection(gName, g.name, f, t)}
<form method="post" action="/ui/settings/clouds/${gName}/key" class="form-grid" autocomplete="off" style="margin-top:10px"><input type="hidden" name="csrf" value="${t}"><label>${infoLabel("New API key", "Control seals the new key, reads the account with it, and forgets the old one.")}<input name="runpod_key" type="password" autocomplete="new-password" maxlength="4096" placeholder="empty keeps the key ending ${esc(g.key_hint)}"></label><div class="form-end"><button>Replace the key</button></div></form>
<div style="margin-top:10px">${form("delete", "Delete this GPU cloud", "sm danger")} <span class="muted small">Control forgets the key. Nothing at RunPod changes.</span></div></div></details>`;
      })
      .join("");
}
