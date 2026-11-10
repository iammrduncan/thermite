import { SESSION_TOKEN_HEADER, STREAM_BEAT_MS, STREAM_PATH } from "@core/api/control/dashboard.ts";
import { type AnswerOf, type BodyOf, pathOf, type Route } from "@core/api/route.ts";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The app's one way to control: a route of control's API (src/core/api/control/), called with the
 * owner's session. An answer is read with the route's own schema, so the app and control can't
 * disagree about its shape; a failure carries control's own sentence.
 */

/** A call that failed: control's words for it, and its status (0 when no answer came). */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The session's token, sent with every change. */
let sessionToken = "";
export const setSessionToken = (token: string | undefined) => {
  sessionToken = token ?? "";
};

/** Told when control answers that the session has ended. */
let onSignedOut: () => void = () => {};
export const whenSignedOut = (fn: () => void) => {
  onSignedOut = fn;
};

export async function call<R extends Route>(
  route: R,
  input: { params?: Record<string, string | number>; body?: BodyOf<R> } = {},
): Promise<AnswerOf<R>> {
  const headers: Record<string, string> = {};
  if (route.method !== "GET") headers[SESSION_TOKEN_HEADER] = sessionToken;
  if (input.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(pathOf(route, input.params), {
      method: route.method,
      headers,
      credentials: "same-origin",
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch {
    throw new ApiError("Control did not answer. It is tried again.", 0);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`Control's answer could not be read (status ${res.status}).`, res.status);
  }
  if (!res.ok) {
    if (res.status === 401) onSignedOut();
    const said = (data as { error?: unknown } | null)?.error;
    throw new ApiError(
      typeof said === "string" ? said : `Control answered ${res.status}.`,
      res.status,
    );
  }
  const read = route.answer.safeParse(data);
  if (!read.success)
    throw new ApiError(
      `Control's answer for ${route.what ?? route.path} is not what this page expects. Reload the page: control may have been updated.`,
      res.status,
    );
  return data as AnswerOf<R>;
}

/** Those told each time control says something changed. */
const listeners = new Set<() => void>();
/** Those told whether the stream is alive. */
const liveness = new Set<(alive: boolean) => void>();
let source: EventSource | undefined;
let lastBeat = 0;
let alive = true;

function setAlive(now: boolean) {
  if (now === alive) return;
  alive = now;
  for (const fn of liveness) fn(alive);
}

/** Opens the stream of changes once, for as long as the page is open. */
function openStream() {
  if (source) return;
  source = new EventSource(STREAM_PATH);
  lastBeat = Date.now();
  const beat = () => {
    lastBeat = Date.now();
    setAlive(true);
  };
  source.addEventListener("beat", beat);
  source.addEventListener("changed", () => {
    beat();
    for (const fn of listeners) fn();
  });
  // The browser connects again by itself; a read then makes up for what was missed.
  source.addEventListener("open", () => {
    beat();
    for (const fn of listeners) fn();
  });
  setInterval(() => setAlive(Date.now() - lastBeat < STREAM_BEAT_MS * 2.5), 5_000);
}

/** Whether the stream from control is alive: false once two beats are missed. */
export function useAlive(): boolean {
  const [now, setNow] = useState(alive);
  useEffect(() => {
    openStream();
    liveness.add(setNow);
    return () => {
      liveness.delete(setNow);
    };
  }, []);
  return now;
}

/** A read of control, kept current: read at once, and again each time control says it changed. */
export function useRead<R extends Route>(
  route: R,
  params?: Record<string, string | number>,
): { data: AnswerOf<R> | undefined; error: string; reload: () => void } {
  const [data, setData] = useState<AnswerOf<R>>();
  const [error, setError] = useState("");
  const key = JSON.stringify(params ?? {});
  const latest = useRef(0);
  const reload = useCallback(() => {
    const mine = ++latest.current;
    call(route, { params: JSON.parse(key) as Record<string, string | number> }).then(
      (answer) => {
        if (mine !== latest.current) return;
        setData(answer);
        setError("");
      },
      (e: ApiError) => {
        if (mine === latest.current) setError(e.message);
      },
    );
  }, [route, key]);
  useEffect(() => {
    setData(undefined);
    reload();
    openStream();
    listeners.add(reload);
    return () => {
      listeners.delete(reload);
    };
  }, [reload]);
  return { data, error, reload };
}
