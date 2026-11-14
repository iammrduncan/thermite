import { SESSION_START, type SessionAnswer } from "@core/api/control/dashboard.ts";
import { type FormEvent, useState } from "react";
import { type ApiError, call } from "@/api.ts";
import { Act } from "@/parts/act.tsx";
import { Field, TextInput } from "@/parts/field.tsx";
import { Mark } from "@/parts/mark.tsx";
import { Thermy } from "@/parts/thermy.tsx";

/**
 * Sign in, from its board: one card on the sidebar's paper, with Thermy, the mark, the sentence,
 * and the form. The board asks for a user name and a password, which control does not have yet
 * (goal 261); until then the one field is the owner's token.
 */
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
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-6 py-10">
      <div
        data-screen="form"
        className="flex w-full max-w-[400px] flex-col gap-6 rounded-xl border bg-card p-6 shadow-page sm:p-10"
      >
        <div className="flex flex-col items-center gap-4">
          <Thermy className="size-24" />
          <div className="flex items-center gap-2 text-base font-semibold">
            <Mark />
            Thermite
          </div>
        </div>
        <h1 className="text-center text-sentence">Sign in to Thermite.</h1>
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <Field
            label="The owner's token"
            htmlFor="token"
            help={`Thermite keeps this browser signed in while you use it. A session left unused for ${days} days ends.`}
          >
            <TextInput
              id="token"
              type="password"
              autoComplete="current-password"
              autoFocus
              aria-invalid={error ? true : undefined}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="font-semibold text-wrong">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Act look="main" type="submit" disabled={busy || !token}>
              {busy ? "Signing in…" : "Sign in"}
            </Act>
          </div>
        </form>
      </div>
    </main>
  );
}
