import { SecretBox } from "../../../../src/control/secrets.ts";
import { ADMIN, controlOnly, RIG_TOKEN } from "../../../helpers/control-stack.ts";
import { ingestReport } from "../../../helpers/control-store.ts";

/**
 * Each agent's model over REST and MCP (goal 029): POST /v1/rigs/<rig>/model and set_rig_model
 * set one agent's model, or clear it, as its row on Edit rig does; GET /v1/rigs/<rig>/model and
 * rig_models read them all. The rig takes the planner's model with its model route and the
 * advisors' with its advisor routes, in its config on the message bus (bus/config.ts).
 */

export const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  read: "read-token-abcdef",
  rigs: { "rig-a": RIG_TOKEN },
};

/**
 * Control with rig-a reporting. Providers: "lab" (an OpenAI-compatible key) with wide-model and
 * strong-model, "sub" (a signed-in ChatGPT subscription) with gpt-sol, OpenCode's own "zen", and
 * "claude-sub" (a Claude subscription) with opus-5.5.
 */
export async function stack() {
  const secrets = SecretBox.ephemeral();
  const {
    store,
    control: api,
    rigConfig,
  } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, secrets },
  });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-rig-a",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: {},
  });
  store.modelProviders.put({
    name: "lab",
    type: "openai",
    base_url: "https://models.example.com/v1",
    key: { sealed: secrets.seal("lab-key-for-tests"), hint: "…ests" },
  });
  store.modelProviders.setModels("lab", [
    { id: "wide-model", context_window: 204_800 },
    { id: "strong-model", context_window: 400_000 },
  ]);
  // A ChatGPT login whose access token lasts another hour: control sends it as it is.
  const login = {
    access: "chatgpt-access-for-tests",
    refresh: "chatgpt-refresh-for-tests",
    expires: Date.now() + 3_600_000,
    earliest_refresh: null,
    client_id: "client-for-tests",
    host_id: "host-for-tests",
  };
  store.modelProviders.put({
    name: "sub",
    type: "chatgpt",
    base_url: "",
    key: { sealed: secrets.seal(JSON.stringify(login)), hint: "ChatGPT" },
  });
  store.modelProviders.setModels("sub", [{ id: "gpt-sol", context_window: 272_000 }]);
  store.modelProviders.put({
    name: "zen",
    type: "opencode",
    base_url: "https://opencode.ai/zen/v1",
  });
  store.modelProviders.setModels("zen", [{ id: "big-pickle" }]);
  store.modelProviders.put({
    name: "claude-sub",
    type: "claude",
    base_url: "",
    key: { sealed: secrets.seal("claude-subscription-for-tests"), hint: "…ests" },
  });
  store.modelProviders.setModels("claude-sub", [{ id: "opus-5.5", context_window: 200_000 }]);
  const as =
    (token: string) =>
    (method: "GET" | "POST", body?: Record<string, unknown>, rig = "rig-a") =>
      api.request(`/v1/rigs/${rig}/model`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
  const owner = as(TOKENS.admin);
  const give = async (body: Record<string, unknown>) => {
    const r = await owner("POST", body);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  // What the rig's config on the bus holds for it, as control writes it there: its model route
  // (`/v1/rigs/<rig>/model-route`) or its advisors' routes (`…/advisor-routes`).
  const asRig = async (path: string) => {
    const [, rig = "", key] =
      /^\/v1\/rigs\/([^/]+)\/(model-route|advisor-routes)$/.exec(path) ?? [];
    if (key !== "model-route" && key !== "advisor-routes")
      throw new Error(`not a rig's config key: ${path}`);
    return await rigConfig(key, rig);
  };
  return { store, api, as, owner, give, asRig };
}

/** The JSON an MCP tool answered with. */
export const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;
