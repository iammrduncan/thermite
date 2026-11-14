import { Act, Acts, Field, Form, FormError, Lone, TextInput, Thermy } from "@ds";

/** A page with one thing on it: the sign-in. On its own page it fills the window. */
export default function ALonePage() {
  return (
    <Lone art={<Thermy size="large" />} name="Thermite" sentence="Sign in to Thermite.">
      <Form onSubmit={(event) => event.preventDefault()}>
        <Field label="User name" htmlFor="ex-user" help="The name of your user.">
          <TextInput id="ex-user" defaultValue="shannon" />
        </Field>
        <FormError>That is not a user of this app.</FormError>
        <Acts>
          <Act look="main" type="submit">
            Sign in
          </Act>
        </Acts>
      </Form>
    </Lone>
  );
}
