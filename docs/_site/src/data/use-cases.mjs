// The fields and the personas of the use cases. Each use case is a page in the documentation,
// under use-cases/<field>/, with its mode, personas and card text in its front matter; each
// persona has a page under use-cases/for/. The sidebar, the content schema and the site's own
// pages (the Use cases overview and the home page) all read these lists.

/** @type {{ key: string, label: string, short?: string, blurb: string }[]} */
export const fields = [
  { key: "software", label: "Software", blurb: "Faster code and large changes, held to your own tests." },
  {
    key: "ai",
    label: "AI and machine learning",
    short: "AI and ML",
    blurb: "Models that run faster, score higher or train in less time, on your hardware.",
  },
  { key: "science", label: "Science", blurb: "Constructions, simulations and the literature, checked by code." },
  {
    key: "healthcare",
    label: "Healthcare and life sciences",
    short: "Healthcare",
    blurb: "Pipelines and models improved on data that never leaves your machines.",
  },
  {
    key: "agriculture",
    label: "Agriculture",
    blurb: "Crop plans, greenhouse control and forecasts, tested on seasons the agents never saw.",
  },
  {
    key: "energy",
    label: "Energy and buildings",
    short: "Energy",
    blurb: "Controllers scored in a simulator before they meet a building.",
  },
  {
    key: "operations",
    label: "Operations and logistics",
    short: "Operations",
    blurb: "Scheduling and routing rules, measured on your own instances.",
  },
  { key: "robotics", label: "Robotics", blurb: "Rewards and controllers that the judge trains and scores itself." },
  {
    key: "finance",
    label: "Finance",
    blurb: "Strategies held to years the agents never saw, and engines held to the same numbers.",
  },
];

/** @type {{ key: string, name: string, short: string, pitch: string }[]} */
export const personas = [
  {
    key: "local-ai",
    name: "Local AI enthusiasts",
    short: "Local AI",
    pitch: "Your own GPUs and your own models: make them run faster and score higher, at no cost a request.",
  },
  {
    key: "solo-builders",
    name: "Solo builders",
    short: "Solo builders",
    pitch: "One computer and a project of yours: agents work through the night, and you wake up to measured results.",
  },
  {
    key: "startups",
    name: "Startups",
    short: "Startups",
    pitch: "A research team on the hardware you rent, with every win confirmed before it reaches a customer.",
  },
  {
    key: "enterprises",
    name: "Enterprises",
    short: "Enterprises",
    pitch: "Research on infrastructure you control, with a record of every attempt and verdict to audit.",
  },
];

/** The campaign modes, by the short key a use case's front matter gives. */
export const modes = [
  { key: "climb", label: "hill climb" },
  { key: "goal", label: "goal" },
  { key: "research", label: "research" },
];

export const personaHref = (key) => `/use-cases/for/${key}/`;
