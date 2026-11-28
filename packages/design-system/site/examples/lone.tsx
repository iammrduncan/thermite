import { Act, Acts, Field, Form, FormError, Lone, TextInput } from "@iammrduncan/magnesium/parts";
import { GalleryArt, GalleryMark } from "../demo-brand.tsx";

/** Standalone sign-in shell with host-supplied `brand` and `art` props. */
export default function ALonePage() {
  return (
    <Lone
      art={<GalleryArt size="large" />}
      brand={<GalleryMark />}
      name="Magnesium"
      sentence="Sign in to continue."
    >
      <Form onSubmit={(event) => event.preventDefault()}>
        <Field label="User name" htmlFor="ex-user" help="The name of your account.">
          <TextInput id="ex-user" defaultValue="ada" />
        </Field>
        <FormError>That account does not exist on this server.</FormError>
        <Acts>
          <Act look="main" type="submit">
            Sign in
          </Act>
        </Acts>
      </Form>
    </Lone>
  );
}
