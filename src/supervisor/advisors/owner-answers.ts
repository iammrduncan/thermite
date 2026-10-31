import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";

/**
 * An advisor's answers to the owner's messages it was given (owner_messages in its brief or
 * package), one or two sentences each, by the message's id. Lenient on purpose: an answer that is
 * too long is shortened, never a reason to lose the advisor's review, audit or verdict.
 */
const OwnerAnswer = z.object({
  message: z.coerce.number().int().positive(),
  text: z
    .string()
    .max(20_000)
    .transform((s) => s.trim().slice(0, 1000)),
});
/** Each answer on its own: one malformed answer never loses the others. */
export const OwnerAnswers = z
  .array(z.unknown())
  .transform((xs) =>
    xs.slice(0, 50).flatMap((x) => {
      const a = OwnerAnswer.safeParse(x);
      return a.success && a.data.text ? [a.data] : [];
    }),
  )
  .catch([]);
export const OwnerAnswersSchema = Type.Optional(
  Type.Array(Type.Object({ message: Type.Number(), text: Type.String() }), {
    description:
      "One answer to each of the owner's messages you were given (owner_messages), one or two sentences each, by its id",
  }),
);
