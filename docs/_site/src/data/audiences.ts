// The three audiences of the site's own pages: the home page's cards and the Use cases overview.
// Each one's full page is in the documentation, under use-cases/.
export type Mode = "climb" | "goal" | "research";
export interface Audience {
  key: "local-ai" | "solo-builders" | "enterprises";
  name: string;
  href: string;
  pitch: string;
  headline: string;
  examples: { mode: Mode; title: string; text: string }[];
  fits: string[];
  proof: string;
}

export const modeName: Record<Mode, string> = { climb: "hill climb", goal: "goal", research: "research" };

export const audiences: Audience[] = [
  {
    key: "local-ai",
    name: "Local AI",
    href: "/use-cases/local-ai/",
    headline: "Make models fly on the hardware you have.",
    pitch:
      "Tune an inference engine, a quantization or a kernel for the GPU you own, with the judge measuring on that same GPU.",
    examples: [
      {
        mode: "climb",
        title: "Decode speed on your card",
        text: "Tokens a second, timed from outside the engine, with the model's outputs held where they started.",
      },
      {
        mode: "goal",
        title: "A new format or model",
        text: "The engine builds for your card, loads the model, and matches a reference, bit for bit.",
      },
      {
        mode: "goal",
        title: "A quality gate",
        text: "Hold a new quantization to the one you serve: perplexity, needle recall, a task screen.",
      },
    ],
    fits: [
      "The judge times every change on your GPU, against the best version so far",
      "Guards catch a faster change that answers differently",
      "Agents can run on your own model server, at no cost a request",
    ],
    proof: "3.89× faster decode on a $100 Tesla P100",
  },
  {
    key: "solo-builders",
    name: "Solo builders",
    href: "/use-cases/solo-builders/",
    headline: "A research team that works while you sleep.",
    pitch:
      "One computer and the model you already have: agents work on your project overnight, and you wake up to measured results.",
    examples: [
      {
        mode: "climb",
        title: "Make it faster",
        text: "A function's time, a build's minutes, a binary's size: any number your project prints.",
      },
      {
        mode: "goal",
        title: "Make it work",
        text: "The tests pass after an upgrade. The campaign ends itself when every goal is met.",
      },
      {
        mode: "research",
        title: "Find out",
        text: "A report on a question, with every claim resting on a quote code checked.",
      },
    ],
    fits: [
      "About twenty minutes to install, or let your own AI agent do it",
      "Start with a free model, then the plan you already pay for",
      "The New campaign page writes a first kit from your answers",
    ],
    proof: "A free model to start, no account or key",
  },
  {
    key: "enterprises",
    name: "Enterprises",
    href: "/use-cases/enterprises/",
    headline: "Autoresearch you can audit, on infrastructure you control.",
    pitch:
      "Run it on your own clusters, models and repositories: signed commands, approvals, and a record of every attempt.",
    examples: [
      {
        mode: "climb",
        title: "Inference cost",
        text: "Tokens a second per GPU on your production hardware, with outputs held to today's.",
      },
      {
        mode: "goal",
        title: "Migrations",
        text: "The codebase builds and passes its checks on the new framework, and on held-out tests.",
      },
      {
        mode: "research",
        title: "Technical research",
        text: "A design choice or due diligence, as a report on checked quotes.",
      },
    ],
    fits: [
      "Agents run as users that can't read or change the judge",
      "Control signs every command; the rig signs every report",
      "Kubernetes namespaces or slots, your registry, your model endpoint",
    ],
    proof: "Self-hosted, with one owner per installation",
  },
];
