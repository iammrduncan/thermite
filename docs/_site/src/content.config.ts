import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { modes, personas } from "./data/use-cases.mjs";

// Every page has a title, a one-line description and one type: a Diátaxis type, or `use-case` and
// `study` for the pages that show who Thermite is for and what it has done. The build fails
// without them. `npm run docs:check` also checks that each page sits in the section of its type.
// A use case (use-cases/<field>/) also says, under `useCase`, its campaign mode, the personas it
// suits and the text of its card on the Use cases overview; its field is its folder.
export const collections = {
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        description: z.string().min(20),
        type: z.enum([
          "tutorial",
          "how-to",
          "reference",
          "explanation",
          "use-case",
          "study",
          "hub",
          "project",
        ]),
        useCase: z
          .object({
            mode: z.enum(modes.map((m) => m.key) as [string, ...string[]]),
            personas: z.array(z.enum(personas.map((p) => p.key) as [string, ...string[]])).min(1),
            /** One or two sentences: what you get, for the card. */
            summary: z.string().min(40).max(220),
            /**
             * Three parts, between " · ": what the judge measures, what must hold and what is
             * hidden; for research, what counts, what is checked and who decides.
             */
            measure: z
              .string()
              .max(140)
              .refine((m) => m.split(" · ").length === 3, 'three parts, between " · "'),
          })
          .optional(),
      }),
    }),
  }),
};
