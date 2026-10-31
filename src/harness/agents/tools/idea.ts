import { Type } from "@earendil-works/pi-ai";
import { errorText } from "../../../common/errors.ts";

/**
 * The idea tool, the same for code and research workers in Pi: the worker proposes an experiment
 * for the run's queue while it works, as `thermite-trial idea` does in a program of its own.
 */

/** A worker's idea for its run's queue (the idea tool, or `thermite-trial idea`). */
export interface IdeaInput {
  title: string;
  why?: string | undefined;
  family?: string | undefined;
  details?: string | undefined;
  /** A research task's question, an index from 0 (goal 117). */
  question?: number | undefined;
}

/** The tool: an idea waits as proposed until the planner (or the owner) queues or drops it. */
export const IDEA_TOOL = {
  name: "idea",
  description:
    "Propose another experiment for the run's queue: something worth trying that is not your assignment. The planner decides whether it is queued; this does not end your trial.",
  parameters: Type.Object({
    title: Type.String({ description: "What to try, in a few words" }),
    why: Type.Optional(Type.String({ description: "Why it is worth trying" })),
    family: Type.Optional(Type.String({ description: "Its direction (approach family)" })),
    details: Type.Optional(Type.String({ description: "How, if it needs saying" })),
    question: Type.Optional(
      Type.Number({
        description:
          "A research run only: the index of the campaign question the task is about (0-based)",
      }),
    ),
  }),
};

/** Runs the idea tool: the proposal through the harness API, and the answer in words. */
export async function proposeIdea(
  idea: (req: IdeaInput) => Promise<{ experiment: string }>,
  p: Record<string, unknown>,
): Promise<ReturnType<typeof text>> {
  const str = (k: string, n: number) =>
    typeof p[k] === "string" && (p[k] as string).trim()
      ? (p[k] as string).trim().slice(0, n)
      : undefined;
  const title = str("title", 200);
  if (!title) return text("an idea needs a title: what to try, in a few words");
  try {
    const out = await idea({
      title,
      why: str("why", 2000),
      family: str("family", 80),
      details: str("details", 4000),
      ...(typeof p.question === "number" ? { question: p.question } : {}),
    });
    return text(
      `proposed ${out.experiment}: it waits until the planner or the campaign's owner queues it or drops it. Your trial goes on.`,
    );
  } catch (err) {
    return text(`the idea was not recorded: ${errorText(err)}`);
  }
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}
