import { SESSION_START, type SessionAnswer } from "@core/api/control/dashboard.ts";
import { type FormEvent, useState } from "react";
import { type ApiError, call } from "@/api.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Sign in with the owner's token: one field, on a page with nothing around it. */
export function SignIn({
  days,
  onSignedIn,
}: {
  days: number;
  onSignedIn: (s: SessionAnswer) => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    call(SESSION_START, { body: { token } }).then(onSignedIn, (e: ApiError) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-sm content-center gap-6 px-4 py-10">
      <h1 className="text-xl font-medium">Sign in to Thermite</h1>
      <form className="grid gap-4" onSubmit={submit}>
        <label className="grid gap-1.5 text-sm font-medium">
          The owner's token
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="font-normal text-muted-foreground">
            This browser stays signed in while you use it. A session left unused for {days} days
            ends.
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="justify-self-start" disabled={busy || !token}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
