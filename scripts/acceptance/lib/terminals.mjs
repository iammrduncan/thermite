// An agent's terminal as the acceptance checks reach it (goal 169): the owner's console over
// REST (terminal_input) and the screen Live gets, as the owner's page watches it.
import { api, control, secret, until } from "./smoke-env.mjs";

/**
 * One of the owner's inputs to a trial's or a call's terminal, as REST sends it: its command,
 * once settled.
 */
export async function typeInto(trial, input, run = "smoke-1") {
  const issued = await api("/v1/commands", {
    method: "POST",
    body: JSON.stringify({ kind: "terminal_input", payload: { run, trial, ...input } }),
  });
  if (issued.status !== 201) return { status: "not issued", outcome: issued.body };
  return until(
    "the input's outcome",
    async () => {
      const c = await api(`/v1/commands/${issued.body.id}`);
      return c.body.status !== "pending" ? c.body : undefined;
    },
    120_000,
  );
}

/** The first frame of a trial's or a call's terminal that Live gets, as the owner's page watches it. */
export async function screenOnLive(trial, rig = "local-1") {
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 60_000);
  try {
    const res = await fetch(`${control}/ui/rigs/${rig}/live/screen?trial=${trial}`, {
      headers: { cookie },
      signal: stop.signal,
    });
    const reader = res.body.getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      text += new TextDecoder().decode(value);
      const at = text.indexOf("event: frame\ndata: ");
      const end = at < 0 ? -1 : text.indexOf("\n", at + 19);
      if (end > 0) return JSON.parse(text.slice(at + 19, end));
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}
