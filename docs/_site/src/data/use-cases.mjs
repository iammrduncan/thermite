// The fields and the personas of the use cases. Each use case is a page in the documentation,
// under use-cases/<field>/, with its mode, personas and card text in its front matter; each
// persona has a page under use-cases/for/. The sidebar, the content schema and the site's own
// pages (the Use cases overview and the home page) all read these lists.

/** @type {{ key: string, label: string, short?: string, blurb: string, intro: string }[]} */
export const fields = [
  {
    key: "software",
    label: "Software",
    blurb: "Faster code and large changes, held to your own tests.",
    intro:
      "Speed-ups, migrations and upgrades are loops of small experiments that a test suite can judge. Agents run the loop for days; the judge builds every change itself, runs your tests and times it on your machine.",
  },
  {
    key: "ai",
    label: "AI and machine learning",
    short: "AI and ML",
    blurb: "Models that run faster, score higher or train in less time, on your hardware.",
    intro:
      "Inference engines, LLM pipelines and training recipes all have a number that says how good they are. Agents push it on your own GPUs, with the model's answers, its cost and its quality held where you set them.",
  },
  {
    key: "science",
    label: "Science",
    blurb: "Constructions, simulations and the literature, checked by code.",
    intro:
      "When a program can check an answer, agents can search for a better one: a construction, a faster solver, a more accurate method. For what is already known, a research campaign reads the literature with every quote checked.",
  },
  {
    key: "healthcare",
    label: "Healthcare and life sciences",
    short: "Healthcare",
    blurb: "Pipelines and models improved on data that never leaves your machines.",
    intro:
      "Genomes, scans and clinical notes can't leave your machines, and neither does Thermite. Agents improve pipelines and models against truth sets and annotations, on data and with a model that stay inside your walls.",
  },
  {
    key: "agriculture",
    label: "Agriculture",
    blurb: "Crop plans, greenhouse control and forecasts, tested on seasons the agents never saw.",
    intro:
      "Crop and greenhouse simulators, and seasons of yield records, make fair judges for a plan or a forecast. Agents write the policy or the model; the judge scores it on weather and seasons they never saw.",
  },
  {
    key: "energy",
    label: "Energy and buildings",
    short: "Energy",
    blurb: "Controllers scored in a simulator before they meet a building.",
    intro:
      "A building simulator can score a controller on a year of weather in minutes. Agents write the control code offline, and a win must save energy without costing comfort, in buildings they never saw.",
  },
  {
    key: "operations",
    label: "Operations and logistics",
    short: "Operations",
    blurb: "Scheduling and routing rules, measured on your own instances.",
    intro:
      "Placement, scheduling and routing rules run millions of times, so a small gain adds up. The judge replays your own traces and instances, checks every result itself and keeps a rule only if it holds on new ones.",
  },
  {
    key: "robotics",
    label: "Robotics",
    blurb: "Rewards and controllers that the judge trains and scores itself.",
    intro:
      "A learner finds every gap in its reward. Agents write the reward; the judge trains the policy from scratch and measures success with its own test, on seeds and terrain the agents never saw.",
  },
  {
    key: "finance",
    label: "Finance",
    blurb: "Strategies held to years the agents never saw, and engines held to the same numbers.",
    intro:
      "Search enough strategies and one will look good by chance. The judge backtests every attempt with costs and no look-ahead, keeps the latest years hidden, and records how many tries it took.",
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
