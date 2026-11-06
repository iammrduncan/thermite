// The fields and the personas of the use cases. Each use case is a page in the documentation,
// under use-cases/<field>/, with its mode, personas and card text in its front matter; each
// persona has a page under use-cases/for/. The sidebar, the content schema and the site's own
// pages (the Use cases overview and the home page) all read these lists.

/** @type {{ key: string, label: string, short?: string, blurb: string, headline: string, intro: string }[]} */
export const fields = [
  {
    key: "software",
    label: "Software",
    blurb: "Performance optimization, codebase migrations and technology evaluation, each checked by code.",
    headline: "Faster code, finished migrations and technology choices backed by sources.",
    intro:
      "Performance work and migrations are long series of small experiments, and a test suite can judge each one: an independent judge builds every change, runs your tests and measures it on your hardware. Choosing a database or a framework is a research question: agents read every analysis, release note and issue thread on the options, and code checks each quote.",
  },
  {
    key: "ai",
    label: "AI and machine learning",
    short: "AI and ML",
    blurb: "Inference speed, application quality, training, hardware fit and method research, on your own hardware.",
    headline: "Faster inference and better models on the hardware you own.",
    intro:
      "Inference engines, LLM applications and training recipes each have a metric that defines success, and agents improve it on your own GPUs while guards hold output, cost and accuracy. A goal campaign fits a model to a memory and speed budget; a research campaign reads the papers and model cards behind a choice of method.",
  },
  {
    key: "science",
    label: "Science",
    blurb: "Mathematical search, simulation, reproduction and research across the literature.",
    headline: "Better results in mathematics and simulation, and literature research you can verify.",
    intro:
      "Where a program can verify a result, agents can search for a better one: a construction, a faster solver, a more accurate method. Goal campaigns reproduce a paper's results to a tolerance. Research campaigns read a field's literature at scale, with every quotation and every reported value checked against its source.",
  },
  {
    key: "healthcare",
    label: "Healthcare and life sciences",
    short: "Healthcare",
    blurb: "Genomics, imaging, clinical text, FHIR conformance and evidence research, with data that stays on your infrastructure.",
    headline: "Improve pipelines and models without moving patient data.",
    intro:
      "Genomic, imaging and clinical data often cannot leave your infrastructure, and Thermite does not require it to. Agents improve pipelines and models against truth sets and annotations on your own machines. Goal campaigns take an API through its conformance tests; research campaigns read the trial registries and the literature on a clinical question.",
  },
  {
    key: "agriculture",
    label: "Agriculture",
    blurb: "Crop management, greenhouse control, yield forecasting and trial evidence, validated on held-out seasons.",
    headline: "Crop and greenhouse strategies validated on seasons the model never saw.",
    intro:
      "Crop and greenhouse simulators and historical yield records provide an objective evaluation for management policies and forecasts, and the judge scores each candidate on seasons withheld from the agents. Research campaigns gather the published trial results on a practice, region by region.",
  },
  {
    key: "energy",
    label: "Energy and buildings",
    short: "Energy",
    blurb: "Building control, simulation validation and grid interconnection research.",
    headline: "Better building control, validated simulation engines and interconnection rules on record.",
    intro:
      "Building simulators evaluate a controller over a full year of weather in minutes, and the judge accepts a change only if it reduces energy use without reducing comfort. A goal campaign takes a simulation engine through a standard's test cases; a research campaign reads each grid operator's interconnection rules.",
  },
  {
    key: "operations",
    label: "Operations and logistics",
    short: "Operations",
    blurb: "Scheduling, routing, rostering and supply chain research, on your own data.",
    headline: "Better schedules, routes and rosters on your own data.",
    intro:
      "Placement, scheduling and routing heuristics run at high volume, so small improvements compound; the judge replays your traces and instances and accepts a heuristic only if it holds on held-out data. A goal campaign builds a roster that meets every rule; a research campaign traces suppliers through their public records.",
  },
  {
    key: "robotics",
    label: "Robotics",
    blurb: "Reward design and ROS 2 migration, checked in simulation.",
    headline: "Rewards and robot software checked by an independent test of success.",
    intro:
      "Reinforcement learners exploit any gap in their reward function: agents design the reward, and the judge trains each policy from scratch and evaluates task success with its own test. A goal campaign moves a robot's software from ROS 1 to ROS 2, checked by builds, launch tests and missions in simulation.",
  },
  {
    key: "finance",
    label: "Finance",
    blurb: "Strategy research, faster pricing, model validation and research from public filings.",
    headline: "Strategy research, faster engines and validated models, with every trial on record.",
    intro:
      "Backtests overfit as the number of trials grows, so the judge backtests every candidate with costs and no look-ahead, withholds the latest years and records the number of trials. Goal campaigns take a pricing model through its validation tests; research campaigns gather every figure banks file on a question, each checked against the record it quotes.",
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
