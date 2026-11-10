import { HOME, SESSION, SESSION_END, type SessionAnswer } from "@core/api/control/dashboard.ts";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { type ApiError, call, setSessionToken, useAlive, useRead, whenSignedOut } from "@/api.ts";
import { follow, here, to } from "@/nav.ts";
import { Body, Header } from "@/parts/header.tsx";
import { Failure, Nothing } from "@/parts/states.tsx";
import { Home } from "@/screens/home.tsx";
import { Run } from "@/screens/run.tsx";
import { Settings } from "@/screens/settings.tsx";
import { SignIn } from "@/screens/sign-in.tsx";
import { Frame } from "@/shell.tsx";

/**
 * The app: the owner's session, then the frame (shell.tsx) with the screen its address names.
 * The app has no router library: a screen's address is its path under /next, links are plain
 * links (nav.ts), and this file holds the table from a path to its screen.
 */

/** The screens' gallery, on made-up answers with no control behind it: a development build only. */
const Gallery = import.meta.env.DEV ? lazy(() => import("@/dev/gallery.tsx")) : undefined;

/** The screen's own path, kept current as the owner moves through the app. */
function usePath(): string {
  const [path, setPath] = useState(here);
  useEffect(() => {
    const moved = () => setPath(here());
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  if (Gallery && path === "/dev")
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  return <Owner path={path} />;
}

/** The owner's session: the sign-in page without one, the screens with one. */
function Owner({ path }: { path: string }) {
  // undefined: not read yet. Nothing shows before the first screen is whole.
  const [session, setSession] = useState<SessionAnswer>();
  const [error, setError] = useState("");
  const took = useCallback((s: SessionAnswer) => {
    setSessionToken(s.token);
    setSession(s);
    setError("");
  }, []);
  const load = useCallback(() => {
    call(SESSION).then(took, (e: ApiError) => setError(e.message));
  }, [took]);
  useEffect(() => {
    load();
    // Control said the session ended: back to the sign-in.
    whenSignedOut(() => setSession((s) => (s ? { ...s, signed_in: false, token: undefined } : s)));
  }, [load]);
  if (!session)
    return error ? (
      <main className="mx-auto grid min-h-dvh max-w-sm content-center px-4">
        <Failure said={error} again={load} />
      </main>
    ) : null;
  if (!session.signed_in) return <SignIn days={session.session_days} onSignedIn={took} />;
  const signOut = () => {
    call(SESSION_END).then(load, load);
  };
  return <Screens path={path} session={session} signOut={signOut} />;
}

function Screens({
  path,
  session,
  signOut,
}: {
  path: string;
  session: SessionAnswer;
  signOut: () => void;
}) {
  // Home's read serves the navigation on every screen: what needs you, and the campaigns.
  const home = useRead(HOME);
  const alive = useAlive();
  let screen: ReactNode;
  const run = /^\/campaigns\/([^/]+)\/runs\/([^/]+)$/.exec(path);
  const settings = /^\/settings(?:\/([a-z-]+))?$/.exec(path);
  if (path === "/") screen = <Home home={home.data} error={home.error} reload={home.reload} />;
  else if (run) screen = <Run run={decodeURIComponent(run[2] ?? "")} />;
  else if (settings) screen = <Settings tab={settings[1]} session={session} signOut={signOut} />;
  else
    screen = (
      <>
        <Header title="Not found" />
        <Body width="form">
          <Nothing>
            The dashboard has no screen at this address.{" "}
            <a href={to("/")} onClick={follow} className="underline underline-offset-4">
              Home
            </a>
          </Nothing>
        </Body>
      </>
    );
  return (
    <Frame home={home.data} path={path} alive={alive}>
      {screen}
    </Frame>
  );
}
