import { SESSION_START, type SessionAnswer } from "@core/api/control/dashboard.ts";
import { Act, Acts, Field, Form, FormError, Lone, TextInput, Thermy } from "@ds";
import { type FormEvent, useState } from "react";
import { type ApiError, call } from "@/api.ts";

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
    <Lone art={<Thermy size="large" />} name="Thermite" sentence="Sign in to Thermite.">
      <Form onSubmit={submit}>
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
        {error && <FormError>{error}</FormError>}
        <Acts>
          <Act look="main" type="submit" disabled={busy || !token}>
            {busy ? "Signing in…" : "Sign in"}
          </Act>
        </Acts>
      </Form>
    </Lone>
  );
}
