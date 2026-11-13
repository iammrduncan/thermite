import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { BadInput, jsonBody } from "../../common/errors.ts";
import {
  APP_PATH,
  SESSION,
  SESSION_END,
  SESSION_START,
  STREAM_BEAT_MS,
  STREAM_PATH,
} from "../../core/api/control/dashboard.ts";
import { type ApiContext, clientOf } from "./context.ts";
import { SIGN_IN_FAILURES } from "./session.ts";

/**
 * The dashboard's app (goal 243): its built files, served at /next; the owner's session, which
 * the app shares with the pages at /ui; and the stream that tells an open screen to read again.
 * The app is a client of the API alone, so everything else it needs is a route of /v1.
 */

/**
 * Where the app's built files are, beside the code: `web/dist` at the repository's root, and in
 * control's image. Vite builds them (`npm run web:build`).
 */
const WEB_DIST = fileURLToPath(new URL("../../../web/dist/", import.meta.url));

/** What the app's index.html holds in place of the nonce (web/vite.config.ts). */
const NONCE_PLACEHOLDER = "__CSP_NONCE__";

/**
 * The app's Content Security Policy: everything from control alone, and no inline script or
 * style. A component that must add a style element at run time carries the answer's nonce.
 */
const appPolicy = (nonce: string) =>
  `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/** What each kind of the app's files is served as. */
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // The licences of the app's packages: plain text, so a browser shows them.
  ".md": "text/plain; charset=utf-8",
};

/** How often the stream looks for a change, in milliseconds. */
const STREAM_LOOK_MS = 2_000;

export function webRoutes(app: Hono, api: ApiContext): void {
  const { store, admin, sessions, control, opts } = api;
  const dist = resolve(opts.webDir ?? WEB_DIST);

  // ---------------------------------------------------------------- the session
  const sessionAnswer = (sid: string | undefined) => ({
    signed_in: sid !== undefined,
    ...(sid !== undefined ? { token: sessions.csrfOf(sid) } : {}),
    session_days: sessions.sessionDays,
    control: { version: control.version, commit: control.commit },
  });
  const noStore = { "cache-control": "no-store" };

  app.get(SESSION.path, async (c) =>
    c.json(sessionAnswer(await sessions.sessionOf(c)), 200, noStore),
  );

  app.post(SESSION_START.path, bodyLimit({ maxSize: SESSION_START.maxBytes }), async (c) => {
    const now = Date.now();
    const client = clientOf(c);
    if (sessions.failures.count(client, now) >= SIGN_IN_FAILURES)
      return c.json({ error: "Too many failed sign-ins. Wait a minute." }, 429);
    const body = SESSION_START.body.safeParse(await jsonBody(c.req));
    if (!body.success) throw new BadInput("the sign-in takes a token");
    const sid = await sessions.start(c, body.data.token);
    if (!sid) {
      if (sessions.failures.add(client, now) === SIGN_IN_FAILURES)
        await store.auditLog.add("control", "login_throttled", {});
      return c.json({ error: "That is not the owner's token." }, 403);
    }
    await store.auditLog.add("owner:ui", "login", {});
    return c.json(sessionAnswer(sid), 200, noStore);
  });

  // Signing out needs no session token: the worst a forged sign-out does is sign the owner out.
  app.delete(SESSION_END.path, async (c) => {
    await sessions.end(c);
    return c.json({ ok: true }, 200, noStore);
  });

  // ---------------------------------------------------------------- the stream of changes
  // A screen that is open reads again when this says so. It compares a cheap mark of what the
  // rigs reported and of the changes made on control (each one has an entry in the audit log); a
  // `beat` shows the stream is alive, so the app can say when it is not.
  const markNow = async () =>
    `${await store.auditLog.newestId()}\n${await store.reportedRigs.mark()}`;
  app.get(STREAM_PATH, admin, (c) => {
    // A proxy in front of control must pass each event on as it comes: nginx obeys this header.
    c.header("x-accel-buffering", "no");
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      let mark = await markNow();
      let beatAt = Date.now();
      await stream.writeSSE({ event: "beat", data: "{}" });
      while (open) {
        await stream.sleep(STREAM_LOOK_MS);
        if (!open) break;
        const now = await markNow();
        if (now !== mark) {
          mark = now;
          await stream.writeSSE({ event: "changed", data: "{}" });
        }
        if (Date.now() - beatAt >= STREAM_BEAT_MS) {
          beatAt = Date.now();
          await stream.writeSSE({ event: "beat", data: "{}" });
        }
      }
    });
  });

  // ---------------------------------------------------------------- the app's files
  const headers = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  /** One of the app's files, by its path under /next; undefined for none, or a path outside. */
  const file = async (name: string): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    const path = resolve(dist, name);
    if (path !== dist && !path.startsWith(dist + sep)) return undefined;
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // No such file: the caller answers for it.
      return undefined;
    }
  };
  const page = async (c: Context) => {
    const html = await file("index.html");
    if (!html)
      return c.text(
        "The dashboard's app is not built here. Build it with `npm run web:build`, or open /ui.",
        503,
        headers,
      );
    const nonce = randomBytes(18).toString("base64");
    return c.body(new TextDecoder().decode(html).replaceAll(NONCE_PLACEHOLDER, nonce), 200, {
      ...headers,
      ...noStore,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": appPolicy(nonce),
    });
  };
  app.get(APP_PATH, page);
  app.get(`${APP_PATH}/*`, async (c) => {
    const name = decodeURIComponent(c.req.path.slice(APP_PATH.length + 1));
    const type = TYPES[extname(name)];
    // An address of a screen has no file's ending: the app answers for it.
    if (!type || name === "index.html") return page(c);
    const bytes = await file(name);
    if (!bytes) return c.text("not found", 404, headers);
    return c.body(bytes, 200, {
      ...headers,
      "content-type": type,
      // Vite names each built file by its content, so one name never changes.
      "cache-control": name.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
  });
}
