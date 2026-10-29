import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { CHATGPT_API } from "../../../core/agents.ts";
import { checkClusterNow, inspectKubeconfig, KUBE_NAME, NS } from "../../clusters/index.ts";
import { modelFollowUrl, modelProgress, notSent } from "../../command-progress.ts";
import { makeDeployKey } from "../../git-keys.ts";
import { ADDRESS, USER } from "../../machines/index.ts";
import { CLAUDE_MODELS, listModels, providerBase } from "../../providers/index.ts";
import { probeRepository } from "../../repo-probe.ts";
import { clearRigModel, giveRigModel } from "../../rigs/index.ts";
import { readRunpod } from "../../runpod/index.ts";
import { keyHint } from "../../secrets.ts";
import {
  GIT_HOST,
  GIT_HOST_WORDS,
  harnessOf,
  type ModelProvider,
  type ProviderType,
} from "../../store/index.ts";
import { PRICE_NUMBER, PRICE_WORDS } from "../../ui/usage.ts";
import { setModelPrice } from "../../usage.ts";
import { type Ctx, type Dashboard, wantsJson } from "../context.ts";
import { mountMcpUi } from "./mcp-servers.ts";
import { machineUrl, newName, settingsHelpers, settingsUrl, TYPES } from "./shared.ts";

/**
 * Settings › Providers' forms: the add form (a machine, a cluster, a GPU cloud, Git access or a
 * model provider), Git access, model providers and subscriptions, MCP servers, model prices and
 * the rigs' harness and model.
 */
export function providerRoutes(app: Hono, dash: Dashboard): void {
  const { chatgpt, mcpServers, noted, opts, parts, ssh, store } = dash;
  const { accessFor } = settingsHelpers(dash);

  // ---------------------------------------------------------------- settings: model providers
  // A provider is entered once: its name, type, base URL and API key. Control lists its models from
  // the provider itself, and the owner gives each rig one of them. Control seals each key (its
  // secret box) and never shows it again; a rig receives a provider's key only when it is given
  // one of its models, through its supervisor's authenticated channel.
  const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
  /** Reads the provider's model list now and keeps it (or why it could not). */
  const listInto = async (p: ModelProvider): Promise<string | null> => {
    if (p.type === "chatgpt") {
      const listed = await chatgpt.models(p);
      store.modelProviders.setModels(p.name, listed);
      return "error" in listed ? listed.error : null;
    }
    let key = "";
    try {
      // OpenCode's own provider may have no key: its list and free models need none.
      if (p.key_sealed) key = opts.secrets.open(p.key_sealed);
    } catch {
      store.modelProviders.setModels(p.name, { error: "its key cannot be opened: enter it again" });
      return "its key cannot be opened: enter it again";
    }
    const listed = await listModels(p.type, p.base_url, key, opts.providerFetch);
    store.modelProviders.setModels(p.name, listed);
    return "error" in listed ? listed.error : null;
  };

  /** The rule for the name of a Git access, a machine, a cluster or a GPU cloud. */
  const ACCESS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  // The add form's cluster, GPU cloud and machine (POST /ui/settings/add, below).
  const addCluster = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    const kubeconfig = String(f.kubeconfig ?? "").trim();
    let context = String(f.context ?? "").trim();
    const placement = f.placement === "slot" ? "slot" : "created";
    const pattern = String(f.namespace_pattern ?? "").trim() || "thermite-{rig}";
    const slots = String(f.slots ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (!ACCESS_NAME.test(name))
      return fail("A cluster's name is lowercase letters, digits, dots and dashes.");
    if (store.clusters.get(name)) return fail(`"${name}" exists already.`);
    if (!kubeconfig) return fail("Paste the cluster's kubeconfig.");
    if (!pattern.includes("{rig}") || !NS.test(pattern.replace("{rig}", "rig")))
      return fail("The namespace for each rig must contain {rig} and make a valid namespace name.");
    if (placement === "slot" && !slots.length) return fail("Name the slots, separated by commas.");
    const bad = slots.find((s) => !NS.test(s));
    if (bad) return fail(`"${bad}" is not a namespace name.`);
    let contexts: { contexts: string[]; current: string };
    try {
      contexts = await parts.kube.contextsOf(kubeconfig);
    } catch (err) {
      return fail(noted(errorText(err)));
    }
    const seen = await inspectKubeconfig(parts.kube, kubeconfig);
    if (seen.problems.length) return fail(`Not added: ${seen.problems.join("; ")}.`);
    if (context && !contexts.contexts.includes(context))
      return fail(
        `The kubeconfig has no context "${context}": it has ${contexts.contexts.join(", ") || "none"}.`,
      );
    if (!context) context = contexts.current;
    if (!context || !KUBE_NAME.test(context))
      return fail("The kubeconfig has no current context: name one.");
    store.clusters.add({
      name,
      kubeconfig_sealed: opts.secrets.seal(kubeconfig),
      context,
      placement,
      namespace_pattern: pattern,
      slots,
      by: "owner:ui",
    });
    const why = await checkClusterNow(parts, name);
    const careful = seen.warnings.length ? ` Note: ${seen.warnings.join("; ")}.` : "";
    return c.redirect(
      why
        ? settingsUrl("error", `"${name}" is added, but the check failed: ${why}${careful}`)
        : settingsUrl(
            "ok",
            `"${name}" is added and checked: see what control found below.${careful}`,
          ),
      303,
    );
  };
  const addRunpod = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    const key = String(f.runpod_key ?? "").trim();
    if (!ACCESS_NAME.test(name))
      return fail("A GPU cloud's name is lowercase letters, digits, dots and dashes.");
    if (store.gpuClouds.get(name)) return fail(`"${name}" exists already.`);
    if (!key) return fail("Paste the RunPod API key.");
    // A key that RunPod refuses is not kept.
    try {
      const facts = await readRunpod(key, opts.cloudFetch);
      store.gpuClouds.add({
        name,
        kind: "runpod",
        key_sealed: opts.secrets.seal(key),
        key_hint: keyHint(key),
        by: "owner:ui",
      });
      store.gpuClouds.setFacts(name, { facts });
    } catch (err) {
      return fail(noted(`Not added: ${errorText(err)}.`));
    }
    return c.redirect(
      settingsUrl("ok", `"${name}" is added and read: see what control found below.`),
      303,
    );
  };
  const addMachine = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(machineUrl("error", m), 303);
    const name = newName(f.name);
    const address = String(f.address ?? "").trim();
    const port = Number(String(f.port ?? "22").trim() || "22");
    const user = String(f.user ?? "").trim();
    let privateKey = String(f.private_key ?? "").trim();
    if (!ACCESS_NAME.test(name))
      return fail("A machine's name is lowercase letters, digits, dots and dashes.");
    if (store.machines.get(name)) return fail(`"${name}" exists already.`);
    if (!ADDRESS.test(address)) return fail("The address is a host name or an IP address.");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return fail("The port is a number from 1 to 65535.");
    if (!USER.test(user)) return fail("The user is a Unix account name, such as thermite.");
    let pub: { line: string; fingerprint: string };
    if (privateKey) {
      try {
        pub = await ssh.publicKeyOf(privateKey);
      } catch (err) {
        return fail(noted(errorText(err)));
      }
    } else {
      const k = makeDeployKey(`thermite ${name}`);
      privateKey = k.privateKey;
      pub = { line: k.publicKey, fingerprint: k.fingerprint };
    }
    const seen = await ssh.scanHostKeys(address, port).catch(() => []);
    store.machines.add({
      name,
      address,
      port,
      user,
      key_sealed: opts.secrets.seal(privateKey),
      public_key: pub.line,
      key_fingerprint: pub.fingerprint,
      seen_host_keys: seen.map((k) => k.line),
      by: "owner:ui",
    });
    return c.redirect(
      seen.length
        ? machineUrl(
            "ok",
            `"${name}" is added. Compare its host key below, then trust it: control connects only after that.`,
          )
        : machineUrl(
            "error",
            `"${name}" is added, but no SSH server answered at ${address} port ${port}. Read its host key again when it is up.`,
          ),
      303,
    );
  };

  // ---------------------------------------------------------------- Git access (Settings)
  /** Git access added from the add form (or the older Git access form). */
  const addGit = (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    if (!ACCESS_NAME.test(name))
      return fail("A Git access name is lowercase letters, digits, dots and dashes.");
    if (store.gitAccess.get(name)) return fail(`"${name}" exists already: delete it first.`);
    const host = String(f.host ?? "")
      .trim()
      .toLowerCase();
    if (!GIT_HOST.test(host)) return fail(GIT_HOST_WORDS);
    if (f.kind === "token") {
      const token = String(f.token ?? "").trim();
      if (!token || /\s/.test(token) || token.length > 4096)
        return fail("Paste the token, without spaces.");
      const username = String(f.username ?? "").trim() || null;
      store.gitAccess.add({
        name,
        kind: "token",
        public_key: null,
        fingerprint: null,
        secret_sealed: opts.secrets.seal(token),
        hint: keyHint(token),
        username,
        host,
        by: "owner:ui",
      });
      return c.redirect(
        settingsUrl("ok", `"${name}" is kept, sealed: choose it on the new-campaign page.`),
        303,
      );
    }
    const key = makeDeployKey(`thermite ${name}`);
    store.gitAccess.add({
      name,
      kind: "ssh",
      public_key: key.publicKey,
      fingerprint: key.fingerprint,
      secret_sealed: opts.secrets.seal(key.privateKey),
      hint: key.fingerprint.slice(-6),
      username: null,
      host,
      by: "owner:ui",
    });
    return c.redirect(
      settingsUrl(
        "ok",
        `Made the deploy key "${name}": add its public key, below, to the repository as a read-only deploy key.`,
      ),
      303,
    );
  };
  app.post("/ui/settings/git", async (c) => addGit(c, await c.req.parseBody()));
  // The host a Git access is for, set by the owner: one that was made before accesses had one.
  app.post("/ui/settings/git/:name/host", async (c) => {
    const name = c.req.param("name");
    const host = String((await c.req.parseBody()).host ?? "")
      .trim()
      .toLowerCase();
    if (!GIT_HOST.test(host)) return c.redirect(settingsUrl("error", GIT_HOST_WORDS), 303);
    return c.redirect(
      store.gitAccess.setHost(name, host, "owner:ui")
        ? settingsUrl("ok", `"${name}" is for ${host}: control uses it there, and nowhere else.`)
        : settingsUrl("error", "No such Git access."),
      303,
    );
  });
  // Reads a repository's branches with this access, as a rig would fetch it; nothing is kept.
  app.post("/ui/settings/git/:name/test", async (c) => {
    const name = c.req.param("name");
    const url = String((await c.req.parseBody()).url ?? "").trim();
    if (!store.gitAccess.get(name))
      return c.redirect(settingsUrl("error", "No such Git access."), 303);
    try {
      const found = await (opts.probeRepo ?? probeRepository)(url, "HEAD", accessFor(name, url));
      return c.redirect(
        settingsUrl(
          "ok",
          `"${name}" reads ${url}: its default branch is at ${found.commit.slice(0, 7)}, with ${found.files} files.`,
        ),
        303,
      );
    } catch (err) {
      const why = errorText(err);
      return c.redirect(
        settingsUrl("error", noted(`"${name}" could not read ${url}: ${why}`)),
        303,
      );
    }
  });
  app.post("/ui/settings/git/:name/token", async (c) => {
    const name = c.req.param("name");
    const token = String((await c.req.parseBody()).token ?? "").trim();
    if (!token || /\s/.test(token) || token.length > 4096)
      return c.redirect(settingsUrl("error", "Paste the token, without spaces."), 303);
    return c.redirect(
      store.gitAccess.replaceToken(name, opts.secrets.seal(token), keyHint(token), "owner:ui")
        ? settingsUrl("ok", `"${name}" has its new token; campaigns that use it keep working.`)
        : settingsUrl("error", "No such token."),
      303,
    );
  });
  app.post("/ui/settings/git/:name/delete", (c) => {
    const name = c.req.param("name");
    const users = store.campaigns.usingGitAccess(name);
    if (users.length)
      return c.redirect(
        settingsUrl("error", `"${name}" is used by ${users.join(", ")}: their runs fetch with it.`),
        303,
      );
    return c.redirect(
      store.gitAccess.delete(name, "owner:ui")
        ? settingsUrl("ok", `"${name}" is deleted. Rigs that ran with it keep nothing of it.`)
        : settingsUrl("error", "No such Git access."),
      303,
    );
  });

  // The add form: a model provider or Git access, by its type.
  app.post("/ui/settings/add", async (c) => {
    const f = await c.req.parseBody();
    if (f.type === "ssh") return addMachine(c, f);
    if (f.type === "k8s") return addCluster(c, f);
    if (f.type === "runpod") return addRunpod(c, f);
    if (f.type === "gitkey" || f.type === "gittoken")
      return addGit(c, { ...f, kind: f.type === "gittoken" ? "token" : "ssh" });
    return saveProvider(c, f);
  });
  app.post("/ui/settings/providers", async (c) => saveProvider(c, await c.req.parseBody()));
  // MCP servers: their block on Providers, and its routes.
  mountMcpUi(app, { store, servers: mcpServers, publicUrl: parts.publicUrl, noted });
  /**
   * A Claude subscription added or its token replaced: the token sealed, the fixed model list, and
   * no call to Anthropic (only Claude Code may use the token).
   */
  const saveClaude = (c: Ctx, name: string, token: string) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    if (token && (token.length > 4096 || /\s/.test(token)))
      return fail(
        "The token has spaces or is too long: paste only what claude setup-token printed.",
      );
    if (token && !token.startsWith("sk-ant-"))
      return fail("That is not a token from claude setup-token: it starts with sk-ant-.");
    const old = store.modelProviders.get(name);
    if (old && old.type !== "claude")
      return fail(`"${name}" is a provider of another kind: choose another name.`);
    const r = store.modelProviders.put({
      name,
      type: "claude",
      base_url: providerBase("claude", ""),
      key: token ? { sealed: opts.secrets.seal(token), hint: keyHint(token) } : undefined,
    });
    if (r === "needs_key") return fail("Paste the token from claude setup-token.");
    store.auditLog.add(
      "owner:ui",
      r === "created" ? "model_provider_added" : "model_provider_changed",
      {
        name,
        type: "claude",
        key: token ? `replaced (${keyHint(token)})` : "kept",
      },
    );
    store.modelProviders.setModels(
      name,
      CLAUDE_MODELS.map((m) => ({ id: m.id, context_window: m.context_window })),
    );
    return c.redirect(
      settingsUrl(
        "ok",
        `"${name}" is saved: its ${CLAUDE_MODELS.length} models run only in Claude Code. Choose one for a rig below.`,
      ),
      303,
    );
  };
  // Sign in with ChatGPT: control starts the sign-in (it keeps the PKCE secret) and sends the
  // owner's browser to OpenAI's page. Signing in again to a provider keeps its client and host IDs.
  app.get("/ui/settings/chatgpt/start", (c) => {
    const name = newName(c.req.query("name"));
    return c.redirect(chatgpt.start(name && PROVIDER_NAME.test(name) ? name : undefined), 302);
  });
  /**
   * A ChatGPT subscription signed in (or again): the code in the address the owner pasted is
   * exchanged for the login, which control seals and renews; its models are listed with it.
   */
  const saveChatGPT = async (c: Ctx, name: string, pasted: string, consent: boolean) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const old = store.modelProviders.get(name);
    if (old && old.type !== "chatgpt")
      return fail(`"${name}" is a provider of another kind: choose another name.`);
    if (!consent)
      return fail(
        "Tick the box that allows Thermite's agents to use your plan when you are not there: OpenAI asks apps for your consent.",
      );
    if (!pasted) return fail("Paste the address the tab went to after the sign-in.");
    const login = await chatgpt.finish(pasted);
    if ("error" in login) return fail(login.error);
    const r = store.modelProviders.put({
      name,
      type: "chatgpt",
      base_url: CHATGPT_API,
      key: { sealed: chatgpt.seal(login), hint: keyHint(login.client_id) },
    });
    store.auditLog.add(
      "owner:ui",
      r === "created" ? "model_provider_added" : "model_provider_changed",
      {
        name,
        type: "chatgpt",
        login: "signed in with ChatGPT",
        unattended_use: "allowed by the owner",
      },
    );
    const p = store.modelProviders.get(name);
    const listError = p ? await listInto(p) : "it was not saved";
    const n = store.modelProviders.get(name)?.models.length ?? 0;
    return c.redirect(
      listError
        ? settingsUrl("error", `"${name}" is signed in, but ${listError}.`)
        : settingsUrl(
            "ok",
            `"${name}" is signed in: its ${n} model${n === 1 ? "" : "s"} run in Pi, OpenCode v2 or Codex. Choose one for a rig below.`,
          ),
      303,
    );
  };
  /** A model provider added or changed. */
  const saveProvider = async (c: Ctx, f: Record<string, unknown>) => {
    const fail = (m: string) => c.redirect(settingsUrl("error", m), 303);
    const name = newName(f.name);
    if (!PROVIDER_NAME.test(name))
      return fail("A provider's name is lowercase letters, digits, dots, dashes and underscores.");
    const type = String(f.type ?? "") as ProviderType;
    if (!(type in TYPES)) return fail("A provider is OpenAI-compatible or Anthropic.");
    if (type === "claude")
      return saveClaude(c, name, String(f.claude_token ?? f.api_key ?? "").trim());
    if (type === "chatgpt")
      return saveChatGPT(
        c,
        name,
        String(f.chatgpt_url ?? "").trim(),
        String(f.chatgpt_consent ?? "") === "1",
      );
    const raw = String(f.base_url ?? "").trim();
    if (!raw && type === "openai") return fail("An OpenAI-compatible provider needs its base URL.");
    const base = providerBase(type, raw);
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      return fail("The base URL is not a URL.");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
      return fail("The base URL is http or https, with no credentials, query or fragment in it.");
    const key = String(f.api_key ?? "").trim();
    if (key.length > 4096 || /\s/.test(key)) return fail("The API key has spaces or is too long.");
    const r = store.modelProviders.put({
      name,
      type,
      base_url: base,
      key: key ? { sealed: opts.secrets.seal(key), hint: keyHint(key) } : undefined,
    });
    if (r === "needs_key") return fail("A new provider needs its API key.");
    // The audit names the provider and the key's hint, never the key.
    store.auditLog.add(
      "owner:ui",
      r === "created" ? "model_provider_added" : "model_provider_changed",
      {
        name,
        type,
        base_url: base,
        key: key ? `replaced (${keyHint(key)})` : "kept",
      },
    );
    const p = store.modelProviders.get(name);
    const listError = p ? await listInto(p) : null;
    const listed = store.modelProviders.get(name)?.models.length ?? 0;
    return c.redirect(
      listError
        ? settingsUrl(
            "error",
            `"${name}" is saved, but it ${listError.replace(/^could not/, "could not")}.`,
          )
        : settingsUrl(
            "ok",
            `"${name}" is saved and lists ${listed} model${listed === 1 ? "" : "s"}. Choose one for a rig below.`,
          ),
      303,
    );
  };

  app.post("/ui/settings/providers/:name/refresh", async (c) => {
    const p = store.modelProviders.get(c.req.param("name"));
    if (!p) return c.redirect(settingsUrl("error", "No such provider."), 303);
    const listError = await listInto(p);
    const n = store.modelProviders.get(p.name)?.models.length ?? 0;
    return c.redirect(
      listError
        ? settingsUrl("error", `"${p.name}" ${listError}.`)
        : settingsUrl("ok", `"${p.name}" lists ${n} model${n === 1 ? "" : "s"}.`),
      303,
    );
  });

  app.post("/ui/settings/providers/:name/models", async (c) => {
    const f = await c.req.parseBody();
    const name = c.req.param("name");
    const model = String(f.model ?? "").trim();
    if (!store.modelProviders.get(name))
      return c.redirect(settingsUrl("error", "No such provider."), 303);
    if (!MODEL_ID.test(model))
      return c.redirect(
        settingsUrl("error", "A model's name is its id at the provider, without spaces."),
        303,
      );
    store.modelProviders.addModel(name, model);
    store.auditLog.add("owner:ui", "model_provider_model_added", { name, model });
    return c.redirect(settingsUrl("ok", `${model} added to "${name}".`), 303);
  });

  // Model prices (goal 075): one table under the providers, one Save. A model the provider's list
  // prices is left as it is; all three fields empty removes the owner's price; In and Out set it.
  // Each change goes through setModelPrice, as POST /v1/model-prices does, and is audited.
  app.post("/ui/settings/prices", async (c) => {
    const f = await c.req.parseBody();
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(`/ui/settings?at=prices&${k}=${encodeURIComponent(m)}#model-prices`, 303);
    const owner = new Map(
      store.usage.prices().map((x) => [JSON.stringify([x.provider, x.model]), x.price]),
    );
    const rows = Object.keys(f)
      .map((k) => /^m(\d{1,4})$/.exec(k)?.[1])
      .filter((i): i is string => i !== undefined)
      .sort((a, b) => Number(a) - Number(b));
    const problems: string[] = [];
    let changed = 0;
    for (const i of rows) {
      const id = f[`m${i}`];
      const name = f[`p${i}`];
      if (typeof id !== "string" || typeof name !== "string") continue;
      const p = store.modelProviders.get(name);
      const m = p?.models.find((x) => x.id === id);
      if (!p || !m || m.price) continue;
      const read = (k: string) => {
        const v = String(f[`${k}${i}`] ?? "").trim();
        return v === "" ? null : PRICE_NUMBER.test(v) ? Number(v) : Number.NaN;
      };
      const [input, cached, output] = [read("in"), read("cached"), read("out")];
      const who = `${id} of ${p.name}`;
      if ([input, cached, output].some((x) => Number.isNaN(x))) {
        problems.push(`${who}: ${PRICE_WORDS.number}`);
        continue;
      }
      const was = owner.get(JSON.stringify([p.name, id]));
      if (input === null && output === null && cached === null) {
        if (!was) continue;
        const r = setModelPrice(store, { provider: p.name, model: id, clear: true }, "owner:ui");
        if (r.ok) changed++;
        else problems.push(r.error);
        continue;
      }
      if (input === null || output === null) {
        problems.push(`${who}: ${PRICE_WORDS.pair}`);
        continue;
      }
      if (was && was.input === input && was.output === output && was.cached_input === cached)
        continue;
      const r = setModelPrice(
        store,
        { provider: p.name, model: id, input, cached_input: cached, output },
        "owner:ui",
      );
      if (r.ok) changed++;
      else problems.push(r.error);
    }
    if (problems.length)
      return back(
        "error",
        `${problems.join(" ")}${changed ? ` The other ${changed} change${changed === 1 ? " is" : "s are"} saved.` : ""}`,
      );
    return back("ok", changed ? "saved" : "same");
  });

  app.post("/ui/settings/providers/:name/delete", async (c) => {
    const name = c.req.param("name");
    const was = store.modelProviders.get(name);
    const r = store.modelProviders.delete(name);
    // A ChatGPT login is ended at OpenAI too (signed out), with the login control had.
    const signedOut =
      r === "deleted" && was?.type === "chatgpt" ? await chatgpt.revoke(was) : undefined;
    if (r === "deleted")
      store.auditLog.add("owner:ui", "model_provider_deleted", {
        name,
        ...(signedOut === undefined ? {} : { signed_out_at_openai: signedOut }),
      });
    return c.redirect(
      r === "deleted"
        ? settingsUrl(
            "ok",
            `"${name}" deleted.${signedOut === undefined ? "" : signedOut ? " OpenAI confirmed the sign-out." : " OpenAI did not confirm the sign-out: disconnect Thermite in ChatGPT, Settings › Security and login › Sign in with ChatGPT."}`,
          )
        : settingsUrl("error", r === "in_use" ? `"${name}" is still in use.` : "No such provider."),
      303,
    );
  });

  app.post("/ui/settings/rigs", async (c) => {
    const f = await c.req.parseBody();
    const rig = String(f.rig ?? "");
    const choice = String(f.choice ?? "");
    const harness = harnessOf(f.harness);
    // From the page's script (goal 080): JSON, and the row follows the rig as it takes the model.
    const answer = (k: "ok" | "error", m: string) =>
      wantsJson(c)
        ? k === "ok"
          ? c.json({
              ...modelProgress(store, rig, Date.now()),
              said: m,
              tone: "ok",
              follow: modelFollowUrl(rig),
            })
          : c.json(notSent(m), 400)
        : c.redirect(settingsUrl(k, m), 303);
    if (!store.reportedRigs.list().some((x) => x.id === rig))
      return answer("error", "No such rig.");
    if (!choice) {
      clearRigModel(store, rig);
      return answer("ok", `${rig} goes back to its own settings within a minute.`);
    }
    const given = giveRigModel(store, rig, choice, harness);
    return "error" in given ? answer("error", given.error) : answer("ok", given.ok);
  });
}
