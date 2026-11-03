// The fields and the personas of the use cases. Each use case is a page in the documentation,
// under use-cases/<field>/, with its mode, personas and card text in its front matter; each
// persona has a page under use-cases/for/. The sidebar, the content schema and the site's own
// pages (the Use cases overview and the home page) all read these lists.

/** @type {{ key: string, label: string, short?: string, blurb: string, headline: string, intro: string }[]} */
export const fields = [
  {
    key: "software",
    label: "Software",
    blurb: "Performance optimization and codebase migrations, verified by your test suite.",
    headline: "Faster code and completed migrations, verified by your tests.",
    intro:
      "Performance work and migrations are long series of small experiments, and a test suite can judge each one. Thermite runs those experiments with AI agents; an independent judge builds every change, runs your tests and measures it on your hardware.",
  },
  {
    key: "ai",
    label: "AI and machine learning",
    short: "AI and ML",
    blurb: "Inference speed, application quality and training efficiency on your own hardware.",
    headline: "Faster inference and better models on the hardware you own.",
    intro:
      "Inference engines, LLM applications and training recipes each have a metric that defines success. Thermite agents improve that metric on your own GPUs, while guards hold output, cost and accuracy to the limits you set.",
  },
  {
    key: "science",
    label: "Science",
    blurb: "Mathematical search, simulation performance and literature review.",
    headline: "Better results in mathematics and simulation, and literature reviews you can verify.",
    intro:
      "Where a program can verify a result, agents can search for a better one: a construction, a faster solver, a more accurate method. Research campaigns survey the literature, with every quotation verified against its source.",
  },
  {
    key: "healthcare",
    label: "Healthcare and life sciences",
    short: "Healthcare",
    blurb: "Genomics, imaging and clinical text, with data that stays on your infrastructure.",
    headline: "Improve pipelines and models without moving patient data.",
    intro:
      "Genomic, imaging and clinical data often cannot leave your infrastructure, and Thermite does not require it to. Agents improve pipelines and models against truth sets and annotations, with the data and the model on your own machines.",
  },
  {
    key: "agriculture",
    label: "Agriculture",
    blurb: "Crop management, greenhouse control and yield forecasting, validated on held-out seasons.",
    headline: "Crop and greenhouse strategies validated on seasons the model never saw.",
    intro:
      "Crop and greenhouse simulators and historical yield records provide an objective evaluation for management policies and forecasts. Thermite's judge scores each candidate on seasons and conditions withheld from the agents.",
  },
  {
    key: "energy",
    label: "Energy and buildings",
    short: "Energy",
    blurb: "Building and battery control, evaluated in simulation.",
    headline: "Building controllers that cut energy use without cutting comfort.",
    intro:
      "Building simulators evaluate a controller over a full year of weather in minutes. Agents develop the control logic offline, and the judge accepts a change only if it reduces energy use without reducing comfort.",
  },
  {
    key: "operations",
    label: "Operations and logistics",
    short: "Operations",
    blurb: "Scheduling and routing heuristics, evaluated on your own data.",
    headline: "Better scheduling and routing on your own data.",
    intro:
      "Placement, scheduling and routing heuristics run at high volume, so small improvements compound. The judge replays your traces and instances, validates every result and accepts a heuristic only if it holds on held-out data.",
  },
  {
    key: "robotics",
    label: "Robotics",
    blurb: "Reward and controller design, evaluated in simulation.",
    headline: "Reward functions evaluated by an independent test of success.",
    intro:
      "Reinforcement learners exploit any gap in their reward function. Agents design the reward; the judge trains each policy from scratch and evaluates task success with its own test, on held-out seeds and terrain.",
  },
  {
    key: "finance",
    label: "Finance",
    blurb: "Strategy research on held-out data, and faster pricing and risk engines.",
    headline: "Strategy research and faster engines, with every trial on record.",
    intro:
      "Backtests overfit as the number of trials grows. The judge backtests every candidate with transaction costs and no look-ahead, withholds the most recent years, and records the total number of trials.",
  },
];

/** @type {{ key: string, name: string, short: string, pitch: string }[]} */
export const personas = [
  {
    key: "local-ai",
    name: "Local AI enthusiasts",
    short: "Local AI",
    pitch: "Tune models and inference engines on your own GPUs, with agents on a local model at no cost per request.",
  },
  {
    key: "solo-builders",
    name: "Solo builders",
    short: "Solo builders",
    pitch: "Run research on a single computer, with a free or local model, and review measured results.",
  },
  {
    key: "startups",
    name: "Startups",
    short: "Startups",
    pitch: "Run experiments on rented or owned GPUs within a set budget, with every result verified before it ships.",
  },
  {
    key: "enterprises",
    name: "Enterprises",
    short: "Enterprises",
    pitch: "Run research on your own infrastructure, with an auditable record of every attempt and verdict.",
  },
];

/** The campaign modes, by the short key a use case's front matter gives. */
export const modes = [
  { key: "climb", label: "hill climb" },
  { key: "goal", label: "goal" },
  { key: "research", label: "research" },
];

export const personaHref = (key) => `/use-cases/for/${key}/`;
