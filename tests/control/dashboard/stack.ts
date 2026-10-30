import { controlStack, signIn } from "../../helpers/control-stack.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/** Control with one rig whose harness runs the Node test kit; the relay is called directly. */
export async function stack(
  promotion: "auto" | "owner_approval" = "owner_approval",
  opts: { providerFetch?: typeof fetch; agents?: false } = {},
) {
  const { env, store, control, relay, live, cfg, rigConfig } = controlStack({
    env: makeJudgeEnv({ promotion, ...(opts.agents === false ? { agents: false } : {}) }),
    options: { providerFetch: opts.providerFetch },
  });
  // Sign in through the form, keeping the session cookie.
  const { get, post, csrfOf: csrfFrom } = await signIn(control);
  return { env, store, control, relay, live, get, post, csrfFrom, cfg, rigConfig };
}
