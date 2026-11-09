---
title: "Credits"
description: "The research, systems, programs, libraries, standards and services Thermite draws on, runs or ships, each with its licence."
type: project
sidebar:
  order: 4
---

<!-- Written from CREDITS.md by `npm run docs:credits`: change CREDITS.md, not this page. -->

Thermite builds on other people's work. This list credits the research it learned from, the systems it studied, and the programs, libraries, standards and services it runs, ships or uses, each with its licence. It is kept in [`CREDITS.md`](https://github.com/iammrduncan/thermite/blob/main/CREDITS.md) at the root of Thermite's repository, and the documentation site shows it as its [Credits](https://usethermite.com/project/credits/) page.

- **What a licence here means.** For a paper, a post or a system that Thermite learned from, the licence is the work's own: Thermite cites it, and copies none of its text, code or data unless this list says so. For a program, a library or an image that Thermite runs or ships, the licence is the one it is used under.
- **Kept as the work goes on.** Every outside work that is studied, compared or used is added here in the same commit as the work it informed. A missing or a wrong credit is a bug: please [open an issue](https://github.com/iammrduncan/thermite/issues).

## Research behind the design

### Papers Thermite adopts from

| Work | Authors | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Stateless Language Agents: Scaling Long-Horizon Automated Research](https://arxiv.org/abs/2610.07625) (2026) | Zhang, Ji, Sun et al. | CC BY 4.0 | The shape of the agents: the harness owns all research state, every agent call starts fresh from context the harness builds, workers are isolated, and a stateless central planner assigns their experiments. Also the lane's keep rule, re-seeding lanes from the champion, and the registry of directions |
| [Fork-and-Flush: Escaping Idea Basins in Autoresearch Agents](https://arxiv.org/abs/2610.07447) (2026) | Cai, Ziakas, Kontonis et al. | CC BY 4.0 | Fork rounds on a fixed schedule: every lane starts again from the champion at a third and two thirds of the wall budget, never on a plateau trigger |
| [CORAL: Towards Autonomous Multi-Agent Evolution for Open-Ended Discovery](https://arxiv.org/abs/2604.01658) (2026) | Qu, Zheng, Zhou et al. | CC BY 4.0 | The loop inside a lane: a grader outside the agents that scores the exact commit in its own checkout, attempt records, heartbeats, the lineage view, and forking from another lane's best. Its lanes that share everything were weighed against Stateless Language Agents and not taken |
| [Risk-aware product decisions in A/B tests with multiple metrics](https://arxiv.org/abs/2402.11609) (2024), and Spotify Engineering's [post](https://engineering.atspotify.com/2024/3/risk-aware-product-decisions-in-a-b-tests-with-multiple-metrics) on it | Schultzberg, Ankargren, Frånberg | CC BY 4.0; the post © Spotify AB | Guards as non-inferiority tests: the objective must improve, and every guard must stay within its margin, for each step and over all promotions |
| [AutoResearch: An Execution-Grounded Multi-Agent Framework for Reliable Research Workflow Automation](https://arxiv.org/abs/2607.02520) (2026), whose second version introduces its Transactional Research Ledger | Kumar, Ali, Ahmed et al. | CC BY 4.0 | From the Transactional Research Ledger, the ledger's lifecycle: `invalidated` kept apart from `failed`, `superseded`, and promotion by compare-and-swap |
| [How Do Agents Fail on AutoResearch: End-to-End Diagnostic Evaluation on 100 Real-World Frontier Research Tasks](https://arxiv.org/abs/2608.14905) (2026), with its benchmark [AutoResearchEval](https://huggingface.co/datasets/PrentisAI/AutoResearchEval) | Fei, Liu, Yu et al. | CC BY 4.0; the dataset CC BY 4.0 | Evidence that agents game the judges they can reach, and its failure taxonomy (ARFT): flaws a worker declares stop a promotion, and submissions are counted |
| [AutoResearch: Insight In, Hallucination Out](https://arxiv.org/abs/2608.17906) (2026), EvoMap | Liu, Sun et al. | arXiv non-exclusive licence | From its code: fenced leases, a job blocked after a few lost leases, and completion that the engine decides, not an agent |
| [Agentic, autonomous design evolution of machine-learned interatomic potentials](https://doi.org/10.26434/chemrxiv.15003852/v1) (2026), chemRxiv | Lu, Chen, Yu, Jiang, Chen | CC BY-NC-ND 4.0 | An unchanged control in each batch, and every override kept as an attributed record |
| [FML-bench: A Controlled Study of AI Research Agent Strategies from the Perspective of Search Dynamics](https://arxiv.org/abs/2605.17373) (2026) | Zou, Lam, Zhao et al. | arXiv non-exclusive licence | With the next row, the evidence that the grader matters more than the search method |
| [Automated Discovery Has No Universally Superior Harness](https://arxiv.org/abs/2607.18235) (2026) | Gupta, Lei, Lu et al. | arXiv non-exclusive licence | The same |

### Measurement and statistics

The judge's verdicts rest on paired, interleaved blocks timed on log ratios, Student's t intervals, a few planned looks with the error rate split between them (Bonferroni), an equivalence band for `neutral`, a noise floor from A/A runs, and confirmation on fresh blocks. These works shaped that design.

| Work | Authors | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Equivalence Testing for Psychological Research: A Tutorial](https://doi.org/10.1177/2515245918770963) (2018), AMPPS | Lakens, Scheel, Isager | CC BY, open access | Equivalence testing (two one-sided tests): the equivalence band behind the `neutral` verdict |
| [Always Valid Inference: Bringing Sequential Analysis to A/B Testing](https://arxiv.org/abs/1512.04922) (2015), and [Peeking at A/B Tests: Why it matters, and what to do about it](https://doi.org/10.1145/3097983.3097992) (KDD 2017) | Johari, Pekelis, Walsh; Johari, Koomen, Pekelis, Walsh | arXiv non-exclusive licence; © ACM | Why looks at the data must be planned: the judge looks after 3, 6 and 9 blocks, with the error rate split between them |
| [Discrete Sequential Boundaries for Clinical Trials](https://doi.org/10.1093/biomet/70.3.659) (1983), Biometrika | Lan, DeMets | © Biometrika Trust | The same, group-sequential tests |
| [The Optimizer's Curse: Skepticism and Postdecision Surprise in Decision Analysis](https://doi.org/10.1287/mnsc.1050.0451) (2006), Management Science | Smith, Winkler | © INFORMS | Why a screened win is confirmed on fresh data before it counts |
| [Winner's Curse: Bias Estimation for Total Effects of Features in Online Controlled Experiments](https://doi.org/10.1145/3219819.3219905) (KDD 2018) | Lee, Shen | © ACM | The same |
| [Rigorous Benchmarking in Reasonable Time](https://doi.org/10.1145/2464157.2464160) (ISMM 2013) | Kalibera, Jones | © ACM | Repeats as separate processes, interleaved, and the noise of a machine measured, not assumed |
| [Scientific Benchmarking of Parallel Computing Systems: Twelve Ways to Tell the Masses when Reporting Performance Results](https://doi.org/10.1145/2807591.2807644) (SC'15) | Hoefler, Belli | © ACM | The same |
| [Robust Benchmarking in Noisy Environments](https://arxiv.org/abs/1608.04295) (2016) | Chen, Revels | arXiv non-exclusive licence | The same |
| [Producing Wrong Data Without Doing Anything Obviously Wrong!](https://doi.org/10.1145/1508244.1508275) (ASPLOS 2009) | Mytkowicz, Diwan, Hauswirth, Sweeney | © ACM | Why the change and the champion are timed in the same job, on the same device, in random order |
| [Generalization in Adaptive Data Analysis and Holdout Reuse](https://arxiv.org/abs/1506.02629) (2015) | Dwork, Feldman, Hardt et al. | arXiv non-exclusive licence | Held-out cases that no agent sees, checked only when a change is confirmed |
| [Trustworthy Online Controlled Experiments](https://doi.org/10.1017/9781108653985) (2020), a book | Kohavi, Tang, Xu | © Cambridge University Press | A/A tests, and Twyman's law: a surprising gain is checked before it is believed (the auditor's trigger) |
| [An Efficient Constraint Handling Method for Genetic Algorithms](https://doi.org/10.1016/S0045-7825(99)00389-8) (2000), CMAME | Deb | © Elsevier | Feasibility first: hard constraints are checked before the objective |
| [A Precision Approximation of the Gamma Function](https://doi.org/10.1137/0701008) (1964), SIAM J. Numer. Anal. B | Lanczos | © SIAM | The Lanczos approximation, with g = 7, behind the judge's t distribution (`src/core/stats.ts`) |
| [Generating Bessel Functions in Mie Scattering Calculations Using Continued Fractions](https://doi.org/10.1364/AO.15.000668) (1976), Applied Optics, and [Coulomb and Bessel Functions of Complex Arguments and Order](https://doi.org/10.1016/0021-9991(86)90046-X) (1986), J. Comput. Phys. | Lentz; Thompson, Barnett | © Optica; © Elsevier | The modified Lentz method for continued fractions, behind the incomplete beta function (`src/core/stats.ts`) |

[SciPy](https://github.com/scipy/scipy) and [NumPy](https://github.com/numpy/numpy) (both BSD-3-Clause) computed the reference values the statistics tests compare with (`scripts/stats-reference.py`); only the numbers are in the repository.

### Kernel evaluation and reward hacking

These showed that an agent graded by something it can reach will find a way to game it. They are why the judge owns the seeds, the reference, the timer and the result channel, why a candidate runs in its own process, and why Thermite has an auditor.

| Work | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [KernelBench: Can LLMs Write Efficient GPU Kernels?](https://arxiv.org/abs/2502.10517) (2025), and [its code](https://github.com/ScalingIntelligence/KernelBench) | Ouyang, Guo, Arora et al.; Stanford Scaling Intelligence Lab | CC BY 4.0; code MIT | How kernel candidates game a benchmark, and how a benchmark checks correctness |
| [KernelBench-Verified: Do LLM-Generated Kernels Actually Beat PyTorch?](https://arxiv.org/abs/2607.16241) (2026), and [its code](https://github.com/facebookresearch/kernel_bench_verified) | Zhang, Yu, Wang et al.; Meta | CC BY 4.0; code MIT | Stricter checks of a kernel's result |
| Sakana AI's [The AI CUDA Engineer](http://web.archive.org/web/20250223061804/https://sakana.ai/ai-cuda-engineer/) (February 2025, archived), whose update says the system had found a memory exploit in the evaluation code; TechCrunch's [report](https://techcrunch.com/2025/02/21/sakana-walks-back-claims-that-its-ai-can-dramatically-speed-up-model-training/) on it; and the follow-up, [Towards Robust Agentic CUDA Kernel Benchmarking, Verification, and Optimization](https://arxiv.org/abs/2509.14279) (robust-kbench, 2025) | Sakana AI; Kyle Wiggers; Lange, Sun, Prasad et al. | © Sakana AI; © TechCrunch; the paper CC BY 4.0 | A judge outside the candidate's reach, and checks that the changed code really ran |
| [Hardening Agent Benchmarks with Adversarial Hacker-Fixer Loops](https://arxiv.org/abs/2606.08960) (2026) | Zhong, Segal, Bercovich et al. | CC BY 4.0 | The same |
| [Measuring Automated Kernel Engineering](https://metr.org/blog/2025-02-14-measuring-automated-kernel-engineering/) and [Recent Frontier Models Are Reward Hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking/) (2025), posts | Tao Lin; Von Arx, Chan, Barnes; METR | © METR | The same |
| [GPU MODE kernelbot](https://github.com/gpu-mode/kernelbot) and [reference kernels](https://github.com/gpu-mode/reference-kernels) | GPU MODE | June 9 Researcher Reciprocity License 1.0 (MIT before 2026-06-09) | How a kernel competition scores and checks submissions |
| [nvbench](https://github.com/NVIDIA/nvbench), [CUTLASS](https://github.com/NVIDIA/cutlass)'s profiler, [Triton](https://github.com/triton-lang/triton)'s autotuner, [Kernel Tuner](https://github.com/KernelTuner/kernel_tuner) | NVIDIA; the Triton project; the Kernel Tuner project | Apache-2.0; BSD-3-Clause; MIT; Apache-2.0 | How kernels are timed and tuned |
| [TVM](https://github.com/apache/tvm) and its papers: [TVM](https://arxiv.org/abs/1802.04799) (OSDI 2018), [Learning to Optimize Tensor Programs](https://arxiv.org/abs/1805.08166) (AutoTVM), [Ansor](https://arxiv.org/abs/2006.06762), and [Tensor Program Optimization with Probabilistic Programs](https://arxiv.org/abs/2205.13603) (MetaSchedule) | The Apache Software Foundation; Chen et al.; Zheng et al.; Shao et al. | Apache-2.0; the papers arXiv non-exclusive licence | Search over program variants, measured on the device |

### Deep research and evidence

Read for the redesign of research mode (goal 117); each is studied, none is used as code.

| Work | Authors | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Assisting in Writing Wikipedia-like Articles From Scratch with Large Language Models](https://arxiv.org/abs/2402.14207) (STORM, 2024) | Shao, Jiang, Kanell et al. | arXiv non-exclusive licence | Read: questions asked from several perspectives, and an outline drawn from the evidence before writing |
| [WebWeaver: Structuring Web-Scale Evidence with Dynamic Outlines for Open-Ended Deep Research](https://arxiv.org/abs/2509.13312) (2025) | Li, Guan, Zhang et al. | CC0 1.0 | Read: an outline revised as evidence arrives, each section citing evidence ids, and each section written with only its own evidence |
| [Deep Researcher with Test-Time Diffusion](https://arxiv.org/abs/2507.16075) (TTD-DR, 2025) | Han, Chen, CuiZhu et al. | CC BY 4.0 | Read: a draft answer kept and revised at each step, which chooses the next search |
| [IterResearch: Rethinking Long-Horizon Agents with Interaction Scaling](https://arxiv.org/abs/2511.07327) (2025) | Chen, Qiao, Chen et al. | CC BY 4.0 | Read: an evolving report as the agent's memory, rebuilt each round, for very long runs |
| [Language agents achieve superhuman synthesis of scientific knowledge](https://arxiv.org/abs/2409.13740) (PaperQA2, 2024) | Skarlinski, Cox, Laurent et al. | CC BY-SA 4.0 | Read: evidence summaries scored for relevance, "insufficient information" counted apart from a wrong answer, and a search for contradicting papers |
| [Accelerating scientific discovery with Co-Scientist](https://arxiv.org/abs/2502.18864) (2025) | Gottweis, Weng, Daryin et al. | CC BY 4.0 | Read: hypotheses ranked by tournament, repeats merged by proximity, and a supervisor that weights work by the state of the queue |
| [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) (MAST, 2025) | Cemri, Pan, Yang et al. | CC BY-NC-ND 4.0 | Read: not knowing when to stop and repeating steps as leading failures of multi-agent systems |
| [GRADE: an emerging consensus on rating quality of evidence and strength of recommendations](https://www.bmj.com/content/336/7650/924) (BMJ, 2008) | Guyatt, Oxman, Vist et al. | © BMJ Publishing Group | Read: certainty rated on a scale (high, moderate, low, very low) instead of a conclusion withheld |

### Agent harness practice

| Work | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), a post | Anthropic | © Anthropic | Read on long agent work across many context windows, kept in files and git rather than in one conversation |
| [Infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise), a post | Anthropic | © Anthropic | Read on how the machine's noise moves an agent evaluation's results |
| [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) (2025), a post | Walden Yan, Cognition | © Cognition | Read on agents that split one task between them. Thermite's workers each own a whole experiment, and one planner coordinates them |
| [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/), a post | Geoffrey Huntley | © Geoffrey Huntley | Read: the plain loop that runs an agent again and again on one task |
| [LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), a gist | Andrej Karpathy | No licence stated | Read: a knowledge base that agents read and add to |

## Systems Thermite studied

### Autoresearch systems

Thermite's research started from [awesome-autoresearch](https://github.com/WecoAI/awesome-autoresearch) (Weco AI, CC0-1.0), a list of autoresearch projects.

| System | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [autoresearch](https://github.com/karpathy/autoresearch), and its [`agenthub`](https://github.com/karpathy/autoresearch/tree/agenthub) branch | Andrej Karpathy | The README says MIT; there is no LICENSE file | The loop Thermite generalizes: an agent changes code, a run measures it, the best is kept. Thermite moves judging out of the agent's reach and keeps every discard. From `agenthub`: queries over a run's lineage |
| [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) | David Cortés, Tobi Lütke | MIT | The closest earlier method. Its lessons are what Thermite fixes: verdicts an agent writes, resets that destroy work, and fixed caps on turns and discards. From it, a hill climb's first step: a baseline run of the unmodified code before any experiment, as Karpathy's autoresearch also starts. In Thermite the judge runs it, not an agent's prompt, it measures every metric on every case, and the guards hold against it |
| [Autoresearch isn't just for training models](https://shopify.engineering/autoresearch) (2026), Shopify Engineering | David Cortés | © Shopify, all rights reserved | Read for how pi-autoresearch is used in practice; quoted on the site's comparison with it. Thermite takes nothing from it |
| [autoresearch](https://github.com/uditgoenka/autoresearch) | Udit Goenka | MIT | The statistics of a regression gate, and the fork round every 20 epochs when a run has no wall budget |
| [evo](https://github.com/evo-hq/evo) | evo-hq | Apache-2.0 | Gates that pass down to child experiments, the held-out floor, and an experiment's brief in four parts; invalidating a node invalidates what grew from it |
| [AutoKernel](https://github.com/RightNow-AI/autokernel), and [its paper](https://arxiv.org/abs/2603.21331) | RightNow AI | MIT; CC BY 4.0 | Correctness checks in stages, a cache flush between timed runs, and roofline checks |
| [autoresearch-mlx](https://github.com/trevin-creator/autoresearch-mlx) | trevin-creator | MIT | A keep gate that takes noise into account, and never scoring the same code twice |
| [autoresearch-at-home](https://github.com/mutable-state-inc/autoresearch-at-home) | mutable-state-inc | The README says MIT; there is no LICENSE file | How workers claim work so it is not done twice, and a key that says which results compare |
| [autoresearch-win-rtx](https://github.com/jsegov/autoresearch-win-rtx) | jsegov | The README says MIT; there is no LICENSE file | Compared |
| [OpenResearch](https://github.com/alphaXiv/OpenResearch) | alphaXiv | MIT | Research mode's first proposals: an experiment tree, and runs named by their content |
| [CORAL](https://github.com/Human-Agent-Society/CORAL) | Human Agent Society | Apache-2.0 | The code of the paper above |
| [ResearchLedger](https://github.com/raja21068/ResearchLedger) | Rajesh Kumar | MIT | The code of the Transactional Research Ledger |
| [AutoResearch](https://github.com/EvoMap/AutoResearch) | EvoMap | Apache-2.0 | The code of its paper above |
| [AutoResearchEval](https://github.com/PrentisAI/AutoResearchEval) | Prentis AI, Titan Research Labs | No licence for the whole; its `agent-as-a-judge/` folder is MIT | The code of its paper above |
| [AutoResearch-MLIP](https://github.com/pic-ai-robotic-chemistry/Agentic-auto-designed-MLIPs) | pic-ai-robotic-chemistry | No licence stated | The code of its paper above |
| [Agon](https://github.com/AutoResearch-Factory/Agon), and [its paper](https://arxiv.org/abs/2606.24177) | AutoResearch Factory | MIT; arXiv non-exclusive licence | Compared |
| [SimplexFold](https://github.com/ChrisHayduk/SimplexFold), [agent-digivolve-harness-loop](https://github.com/MatthewZMD/agent-digivolve-harness-loop), [auto-agent](https://github.com/alfonsograziano/auto-agent) | Chris Hayduk; Matthew Zeng; Alfonso Graziano | MIT each | Their research protocols and verified reporting, read for ideas |

### Program-evolution and research-agent systems

Thermite studied these and took none of them as its engine. Searching a population, or keeping a Pareto set of champions, is a proposed goal ([051](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/051-pareto-and-population.goal)), not built.

| System | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| FunSearch: [Mathematical discoveries from program search with large language models](https://doi.org/10.1038/s41586-023-06924-6) (Nature, 2023), and [its code](https://github.com/google-deepmind/funsearch) | Romera-Paredes et al.; Google DeepMind | Paper: CC BY 4.0; code Apache-2.0, other material CC BY 4.0 | An evaluator that code owns, and a program database |
| [AlphaEvolve: A coding agent for scientific and algorithmic discovery](https://arxiv.org/abs/2506.13131) (2025), and [its results](https://github.com/google-deepmind/alphaevolve_results) | Novikov et al.; Google DeepMind | CC BY-NC-ND 4.0; results Apache-2.0 and CC BY 4.0 | Evolving code against automated evaluators |
| [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve) | Asankhaya Sharma | Apache-2.0 | Compared; also a lesson in evaluator integrity: a change its own benchmark never applied |
| [ShinkaEvolve: Towards Open-Ended And Sample-Efficient Program Evolution](https://arxiv.org/abs/2509.19349) (2025), and [its code](https://github.com/SakanaAI/ShinkaEvolve) | Lange, Imajuku, Cetin; Sakana AI | CC BY 4.0; code Apache-2.0 | Compared: sample-efficient evolution |
| [EvoX: Meta-Evolution for Automated Discovery](https://arxiv.org/abs/2602.23413) (2026), and its code, [SkyDiscover](https://github.com/skydiscover-ai/skydiscover) | Liu, Agarwal, Maheswaran et al. | CC BY 4.0; code Apache-2.0 | Compared |
| [CodeEvolve](https://arxiv.org/abs/2510.14150) (2025), and [its code](https://github.com/inter-co/science-codeevolve) | Assumpção, Ferreira, Campos et al.; Inter&Co | arXiv non-exclusive licence; code Apache-2.0 | Compared |
| [PACEvolve](https://arxiv.org/abs/2601.10657), [DeltaEvolve](https://arxiv.org/abs/2602.02919) and [KernelEvolve](https://arxiv.org/abs/2512.23236) | Their authors | CC BY 4.0 each | Compared |
| [LLM4AD](https://github.com/Optima-CityU/LLM4AD) and [LLM4AD_Next](https://github.com/Optima-CityU/LLM4AD_Next) | Optima, City University of Hong Kong | BSD-2-Clause; BSD-3-Clause | Compared |
| [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457) (2025), and [its code](https://github.com/gepa-ai/gepa) | Agrawal, Tan, Soylu et al. | arXiv non-exclusive licence; code MIT | Pareto selection between candidates |
| [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954) (2025), and [its code](https://github.com/jennyzzt/dgm) | Zhang, Hu, Lu et al. | CC BY 4.0; code Apache-2.0 | Keeping every variant, not only the best |
| [MAP-Elites: Illuminating search spaces by mapping elites](https://arxiv.org/abs/1504.04909) (2015) | Mouret, Clune | arXiv non-exclusive licence | Quality diversity, for the proposed population search |
| [The AI Scientist](https://arxiv.org/abs/2408.06292) and [The AI Scientist-v2](https://arxiv.org/abs/2504.08066), with [their](https://github.com/SakanaAI/AI-Scientist) [code](https://github.com/SakanaAI/AI-Scientist-v2) | Lu, Lu, Lange et al.; Yamada, Lange, Lu et al.; Sakana AI | CC BY 4.0; code under the AI Scientist Source Code License 1.0, not used | Compared; their code's licence is why none of it is used |
| [AIDE: AI-Driven Exploration in the Space of Code](https://arxiv.org/abs/2502.13138) (2025), and [aideml](https://github.com/WecoAI/aideml) | Jiang, Schmidt, Srikanth et al.; Weco AI | CC BY 4.0; code MIT | A tree of solutions, each with its result |
| [MLAgentBench](https://github.com/snap-stanford/MLAgentBench), [RD-Agent](https://github.com/microsoft/RD-Agent), [Agent Laboratory](https://github.com/SamuelSchmidgall/AgentLaboratory), [AgentRxiv](https://arxiv.org/abs/2503.18102) | Stanford SNAP; Microsoft; Samuel Schmidgall; Schmidgall, Moor | MIT each; AgentRxiv CC BY 4.0 | Their workflows, compared |
| [AIRA-dojo](https://github.com/facebookresearch/aira-dojo), and its paper, [AI Research Agents for Machine Learning: Search, Exploration, and Generalization in MLE-bench](https://arxiv.org/abs/2507.02554) (2025) | Toledo, Hambardzumyan, Josifoski et al.; Meta | CC BY-NC 4.0; CC BY-NC-SA 4.0 | Compared only; its code's licence is non-commercial, and none of it is used |
| [SwarmResearch: Orchestrating Coding Agents for Open-Ended Discovery](https://arxiv.org/abs/2607.02807), [MOAE: Multi-Objective Agent Evolution with Pareto-Preserving Search](https://arxiv.org/abs/2609.05992), [AIRA₂: Overcoming Bottlenecks in AI Research Agents](https://arxiv.org/abs/2603.26499), [AI-Research Agents in the Wild](https://arxiv.org/abs/2609.11975), and the survey [AutoResearch AI: Towards AI-Powered Research Automation for Scientific Discovery](https://arxiv.org/abs/2605.23204) (2026 each) | Virk et al.; Jiang et al.; Hambardzumyan et al.; Komissarov, Ustyuzhanin; Tie et al. | CC BY 4.0, except MOAE: arXiv non-exclusive licence | Read and compared; the survey for its vocabulary |

### Coding agents compared

[OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) (MIT) and [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (MIT) were compared as worker harnesses. Neither was taken.

### Fleet, rig and tracking tools compared

Thermite compared these from their public documentation. It uses none of their code.

- **Adding and managing rigs:** [herdr](https://github.com/herdrdev/herdr) (Apache-2.0), whose consent before it installs anything on a machine, and its pinned host keys, are the model for **Add a rig**. Also [SkyPilot](https://github.com/skypilot-org/skypilot) (Apache-2.0), [dstack](https://github.com/dstackai/dstack) (MPL-2.0), [Coder](https://github.com/coder/coder) (AGPL-3.0), [Gitpod and Ona](https://github.com/gitpod-io/gitpod) (AGPL-3.0), [Rancher](https://github.com/rancher/rancher) and [Fleet](https://github.com/rancher/fleet) (Apache-2.0), [the Argo CD agent](https://github.com/argoproj-labs/argocd-agent) (Apache-2.0), [Portainer](https://github.com/portainer/portainer) (Zlib), [Kamal](https://github.com/basecamp/kamal) (MIT), [Coolify](https://github.com/coollabsio/coolify) (Apache-2.0), [CapRover](https://github.com/caprover/caprover) (Apache-2.0), [Dokku](https://github.com/dokku/dokku) (MIT), [disco](https://github.com/letsdiscodev/disco-daemon) (MIT), [Ansible](https://github.com/ansible/ansible) (GPL-3.0), [KubeRay](https://github.com/kuberay-project/kuberay), [Kueue](https://github.com/kubernetes-sigs/kueue), [Determined](https://github.com/determined-ai/determined), [Volcano](https://github.com/volcano-sh/volcano) and [HAMi](https://github.com/Project-HAMi/HAMi) (Apache-2.0 each), NVIDIA Run:ai, [GitHub's Actions Runner Controller](https://github.com/actions/actions-runner-controller) (Apache-2.0), GitLab Runner, [Buildkite's agent stack for Kubernetes](https://github.com/buildkite/agent-stack-k8s) (MIT), and [Tailscale](https://github.com/tailscale/tailscale)'s auth keys (BSD-3-Clause). From them: join tokens swapped on first contact, and slots scoped to a namespace.
- **Orchestration and experiment tracking:** [Temporal](https://github.com/temporalio/temporal) (MIT), [Ray](https://github.com/ray-project/ray) and Ray Tune (Apache-2.0), [Optuna](https://github.com/optuna/optuna) (MIT), [Ax](https://github.com/facebook/Ax) and [BoTorch](https://github.com/meta-pytorch/botorch) (MIT), [OSS Vizier](https://github.com/google/vizier) (Apache-2.0), [MLflow](https://github.com/mlflow/mlflow) (Apache-2.0), [Weights & Biases](https://github.com/wandb/wandb) (MIT), [Aim](https://github.com/aimhubio/aim) (Apache-2.0), [ClearML](https://github.com/clearml/clearml) (Apache-2.0), [NATS JetStream](https://github.com/nats-io/nats-server) (Apache-2.0) and [DBOS](https://github.com/dbos-inc/dbos-transact-py) (MIT). Thermite keeps its own ledger; Optuna's and Ax's data models informed the trial's.
- **Metrics:** [Prometheus](https://github.com/prometheus/prometheus) (Apache-2.0)'s advice on label cardinality: the record stays in the ledger, and metrics carry only bounded series.
- **Documentation tools:** [Docusaurus](https://github.com/facebook/docusaurus), [VitePress](https://github.com/vuejs/vitepress), [Material for MkDocs](https://github.com/squidfunk/mkdocs-material) and [Zensical](https://github.com/zensical/zensical) (MIT each). Starlight was chosen.

### Studied for the v0.1.1 plans

The audit of v0.1.1 studied these from their public code and documentation, for the plans of goals 166 to 175. Thermite uses none of their code yet; each goal says which it will add, with the owner's yes, and this list moves it to the libraries or the images when it does.

- **A message bus (goal 168):** the [NATS server](https://github.com/nats-io/nats-server) with JetStream and [its documentation](https://docs.nats.io) (the NATS authors, a CNCF project; Apache-2.0), for subjects, streams, key-value buckets, permissions, leaf nodes and WebSocket, and later its stream snapshot and restore API and its monitoring, for control's backups and its disk floor (goal 173); the [nats.js](https://github.com/nats-io/nats.js) clients and [jwt.js](https://github.com/nats-io/jwt.js) (Apache-2.0), for their maturity; the [official `nats` image](https://hub.docker.com/_/nats); and [Valkey](https://github.com/valkey-io/valkey) (BSD-3-Clause), an alternative weighed. The goal's first step uses the server, from its official image, and two of the nats.js clients: they are listed below, under In the images and Libraries.
- **Agents in their own terminal (goal 169):** [xterm.js](https://github.com/xtermjs/xterm.js) with `@xterm/headless` and its addons (MIT), for the emulator, snapshots and safe paste; [node-pty](https://github.com/microsoft/node-pty) (Microsoft, MIT) and VS Code's pty host, for the pseudo-terminal; [tmux](https://github.com/tmux/tmux) (ISC), [Zellij](https://github.com/zellij-org/zellij) (MIT) and [ttyd](https://github.com/tsl0922/ttyd) (MIT), options weighed; herdr's agent states and socket API, above; Hermes Agent's web dashboard ([Nous Research](https://nousresearch.com), MIT), a terminal in the browser; [Collie](https://github.com/AltanS/collie) (Altan Sarisin, MIT), for reading each program's session log from disk and its hooks' beacons; the [asciicast format](https://docs.asciinema.org/manual/asciicast/v2/), an option for recordings not taken; the [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) (CC BY-SA 4.0), for a terminal's connection; [ccusage](https://github.com/ryoppippi/ccusage) and [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) (MIT), for how usage windows are read; and Pi's [`pi-coding-agent` and `pi-tui`](https://github.com/earendil-works/pi) (Earendil Works, MIT), for the Pi view.
- **The knowledge base (goal 175):** SQLite's [FTS5](https://sqlite.org/fts5.html) (public domain), which Node.js's SQLite builds in, the knowledge base's search by words; reciprocal rank fusion ([Cormack, Clarke and Büttcher, SIGIR 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)), how that search fuses several queries; Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), the pattern behind the docs that agents keep in it; and [qmd](https://github.com/tobi/qmd) (Tobi Lütke, MIT), studied for its local reranking and its fusion of rankings, not adopted.
- **Search by meaning, studied and not adopted (goal 175):** Thermite has no search by meaning. A spike measured one over a copy of control's items, and a study weighed lighter ways; the owner chose the search by words (2026-10-29). Used in the spike only, in a scratch folder, never in the repository or an image: [zvec-grep](https://github.com/zvec-ai/zvec-grep) 0.2.2 (zvec-ai, Apache-2.0), on [zvec](https://github.com/alibaba/zvec) (Alibaba, Apache-2.0), with the embedding model [potion-retrieval-32M](https://huggingface.co/minishlab/potion-retrieval-32M) (Minish Lab, MIT) of [Model2Vec](https://github.com/MinishLab/model2vec) (Minish Lab, MIT), and Hugging Face's [Tokenizers.js](https://github.com/huggingface/tokenizers.js) (`@huggingface/tokenizers`, Apache-2.0), with which the spike made the same vectors in plain JavaScript. zvec-grep's install in the spike also brought, as its dependencies, [ONNX Runtime](https://github.com/microsoft/onnxruntime) (Microsoft, MIT), [Transformers.js](https://github.com/huggingface/transformers.js) (Hugging Face, Apache-2.0) and [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (withcatai, MIT); ONNX Runtime and node-llama-cpp load only for its other models. Weighed from their public pages, code and npm metadata, studied and not adopted:
  - embedding models and how they compare: [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (BAAI, MIT), a transformer model weighed for later; [MTEB](https://github.com/embeddings-benchmark/mteb) (the MTEB authors, Apache-2.0), whose retrieval scores compared it with potion; [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) (Minish Lab, MIT) and [static-retrieval-mrl-en-v1](https://huggingface.co/sentence-transformers/static-retrieval-mrl-en-v1) (sentence-transformers, Apache-2.0), other static models; [model2vec-js and mini-semantic-search](https://github.com/ShakirasHips/model2vec-js) (ShakirasHips, MIT), read as a reference for a tokenizer; and [pi-mnemo](https://github.com/umbra2728/pi-mnemo) (umbra2728, MIT), prior art for FTS5 with a static model and RRF in `node:sqlite`;
  - vector indexes and stores: [sqlite-vec](https://github.com/asg017/sqlite-vec) (Alex Garcia, MIT or Apache-2.0) and its maintained fork [`@photostructure/sqlite-vec`](https://github.com/photostructure/sqlite-vec) (PhotoStructure, MIT or Apache-2.0); [sqlite-vector](https://github.com/sqliteai/sqlite-vector) (SQLite Cloud, Inc.; Apache-2.0 from release 1.1.2, the Elastic License 2.0 with a grant for open-source projects before it); [vectorlite](https://github.com/1yefuwang1/vectorlite) (Yefu Wang, Apache-2.0); [libSQL](https://github.com/tursodatabase/libsql) (Turso, MIT); [USearch](https://github.com/unum-cloud/usearch) (Unum Cloud, Apache-2.0); [hnswlib-node](https://github.com/yoshoku/hnswlib-node) (Atsushi Tatsuma, Apache-2.0); [`@harperfast/hnsw`](https://github.com/HarperFast/hnsw) (HarperFast, Apache-2.0); [LanceDB](https://github.com/lancedb/lancedb) (LanceDB, Apache-2.0); [faiss-node](https://github.com/ewfian/faiss-node) (ewfian, MIT); [Vectra](https://github.com/Stevenic/vectra) (Steven Ickman, MIT); [hnswlib-wasm](https://github.com/ShravanSunder/hnswlib-wasm) (Shravan Sunder, Apache-2.0); [Voy](https://github.com/tantaraio/voy) (tantaraio, MIT or Apache-2.0); and [EdgeVec](https://github.com/matte1782/edgevec) (matte1782, MIT or Apache-2.0);
  - search libraries: [Orama](https://github.com/oramasearch/orama) (OramaSearch Inc., Apache-2.0) and its fork [ZBSearch](https://github.com/micheleriva/zbsearch) (Michele Riva and the ZBSearch maintainers, Apache-2.0); and, for search by words only, [MiniSearch](https://github.com/lucaong/minisearch) (Luca Ongaro, MIT), [FlexSearch](https://github.com/nextapps-de/flexsearch) (Nextapps, Apache-2.0), [Lunr](https://github.com/olivernn/lunr.js) (Oliver Nightingale, MIT) and [Tantivy](https://github.com/quickwit-oss/tantivy) (Quickwit, MIT);
  - embedding tools and databases: [FastEmbed](https://github.com/qdrant/fastembed) (Qdrant, Apache-2.0) and [fastembed-js](https://github.com/qdrant-labs/fastembed-js) (Qdrant Labs, MIT); [DuckDB](https://github.com/duckdb/duckdb) with its `vss` and `fts` extensions (the DuckDB Foundation, MIT); [PGlite](https://github.com/electric-sql/pglite) (ElectricSQL, Apache-2.0 or the PostgreSQL License) with [pgvector](https://github.com/pgvector/pgvector) (the pgvector authors, PostgreSQL License); [Turso](https://github.com/tursodatabase/turso) (Turso, MIT); [Memvid](https://github.com/memvid/memvid) (Memvid, Apache-2.0); and [CozoDB](https://github.com/cozodb/cozo) (CozoDB, MPL-2.0);
  - frameworks: [Mastra](https://github.com/mastra-ai/mastra) (Kepler Software, Apache-2.0, apart from its `ee/` folders under the Mastra Enterprise License), [LangChain.js](https://github.com/langchain-ai/langchainjs) (LangChain, MIT) and [LlamaIndex.TS](https://github.com/run-llama/LlamaIndexTS) (LlamaIndex, MIT; archived in 2026).
- **The knowledge base's search by words (goal 175):** a study of lightweight search, and the agent-grade words search built from it. On agents that probe a retriever: [BrowseComp-Plus](https://arxiv.org/abs/2508.06600) (Chen et al., ACL 2026; [its code](https://github.com/texttron/BrowseComp-Plus), MIT); [Pi-Serini](https://arxiv.org/abs/2605.10848) (Hsu, Yang and Lin; [its code](https://github.com/justram/pi-serini), MIT), for deeper pages and a read that pages through a document; [Revisiting Text Ranking in Deep Research](https://arxiv.org/abs/2602.21456) (Meng, Ou, MacAvaney and Dalton, SIGIR 2026), for passages; [SAGE](https://arxiv.org/abs/2602.05975) (Hu, Zhao, Zhang, Cohan and Zhao), for metadata written beside each document, the context column; [AgentIR](https://arxiv.org/abs/2603.04384) (Chen, Ma, Zhuang, Lin, Asai and Zhong) and [HaystackCraft](https://arxiv.org/abs/2510.07414) (Li et al., NeurIPS 2025), for the needle test; Anthropic's [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) (2024), for context added to what is indexed; and Cursor's [semantic search](https://cursor.com/blog/semsearch) post (Anysphere), on agents' search by meaning beside grep. On the search itself: [FTS5's documentation](https://sqlite.org/fts5.html), its query syntax, `bm25()`, `snippet()`, `highlight()` and the fts5vocab tables (public domain), the exact mode, the counts of words and "did you mean"; [Apache Lucene](https://github.com/apache/lucene)'s MoreLikeThis (the Apache Software Foundation, Apache-2.0), how "more like this" picks an item's words; and [Anserini](https://github.com/castorini/anserini) (castorini, Apache-2.0), whose RM3 feedback was weighed and not taken. On memory tools' searches: [Hermes Agent](https://github.com/NousResearch)'s session search (Nous Research, MIT), for ids already seen left out, a word after an empty search, and FTS5 with no model; [OpenClaw](https://github.com/openclaw/openclaw) (MIT), [Basic Memory](https://github.com/basicmachines-co/basic-memory) (Basic Machines, AGPL-3.0), [Letta](https://github.com/letta-ai/letta) (Apache-2.0) and [Mem0](https://github.com/mem0ai/mem0) (Apache-2.0), read for how they mix words and meaning. Weighed for search by meaning and not adopted: [SSE v2](https://huggingface.co/RikkaBotan/stable-static-embedding-fast-retrieval-mrl-en-v2) (RikkaBotan, Apache-2.0), [Kura](https://github.com/kurajs/kura) (MIT) and [Narsil](https://github.com/assetcorp/narsil) (Apache-2.0).

### Studied for the v0.1.3 plans

- **A rig of a core and its runners (goal 206, first planned as goal 205):** [Qwen3.8 Flash Next on one DGX Spark (TensorFold)](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold) (MiaAI-Lab, MIT), a recipe that serves the model from one DGX Spark. Its stated needs (about 107 GiB free to start, 81 GiB to load the weights, one model to a Spark) are why a rig's judge and its workers need GPUs of their own, each a runner on its own machine. Thermite uses none of its code.

### Engines the earlier campaigns tuned

Thermite grew out of long hill-climbing campaigns on inference kernels. They tuned these engines, and the methods they taught (prove that the changed code ran, measure the noise of the device, check output against a reference) became the judge's. Thermite uses none of their code. The papers those campaigns read are in their own records, not here.

[llama.cpp and ggml](https://github.com/ggml-org/llama.cpp) (MIT), whose `test-backend-ops` and `llama-perplexity --kl-divergence` were the campaigns' correctness gates; [llamAmpere](https://github.com/JakeATX/llamAmpere) (MIT); [llama-cpp-p100-patches](https://github.com/shinbunbun/llama-cpp-p100-patches) (MIT); [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) (MIT); [ExLlamaV3](https://github.com/turboderp-org/exllamav3) (MIT); [vLLM](https://github.com/vllm-project/vllm) (Apache-2.0); [SGLang](https://github.com/sgl-project/sglang) (Apache-2.0).

## Programs the agents run in

| Program | By | Licence | How Thermite uses it |
| --- | --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi): `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` | Mario Zechner, Earendil Works | MIT | Built into Thermite: the default worker harness, and the model client for the planner and Pi's workers. Thermite patches pi-ai's parse of a tool call's arguments while they stream, at install (`scripts/patch-pi-ai.mjs`, goal 140) |
| [OpenCode](https://github.com/anomalyco/opencode) | Anomaly | MIT | A worker harness, in the harness and supervisor images, with its licence at `/usr/local/share/doc/opencode/` |
| [Codex CLI](https://github.com/openai/codex) | OpenAI | Apache-2.0 | A worker harness, in the harness and supervisor images, with its LICENSE and NOTICE at `/opt/codex/`. Control reads a ChatGPT plan's usage from the endpoint the Codex CLI reads it from, in the shape the CLI reads it. Its NOTICE credits code derived from [Ratatui](https://github.com/ratatui/ratatui) (MIT, © 2016-2022 Florian Dehau, © 2023-2025 The Ratatui Developers) |
| [Claude Code](https://github.com/anthropics/claude-code) | Anthropic | Proprietary: © Anthropic PBC, all rights reserved; use is under Anthropic's Commercial Terms of Service | A worker harness, for a Claude subscription. It is in an image only when that image is built with `CLAUDE_CODE_VERSION`; no published image has it |
| [Claude Agent SDK for TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript) | Anthropic | Proprietary: © Anthropic PBC, all rights reserved; use is under Anthropic's legal agreements | Studied, not used: its type for Claude Code's rate-limit event (one window in each event, its `utilization` and `resetsAt`), which the harness reads for a Claude subscription's usage windows |

## In the images

| Software | By | Licence | Where |
| --- | --- | --- | --- |
| [Node.js](https://github.com/nodejs/node), from the [official `node` image](https://hub.docker.com/_/node) on Debian bookworm | The OpenJS Foundation and Node.js contributors | MIT, with the licences of what it bundles (V8, OpenSSL, SQLite and others) in its LICENSE file | Control, the harness and the supervisor. Thermite's ledgers and stores use Node's built-in SQLite. `src/core/paths.ts` works out paths by the rules of Node's `path.posix` (normalize and join), and its tests hold it to Node's |
| [CUDA](https://hub.docker.com/r/nvidia/cuda), from NVIDIA's `nvidia/cuda` devel images: CUDA 12.6 on Ubuntu 22.04 and CUDA 13.0 on Ubuntu 24.04 | NVIDIA | [NVIDIA Deep Learning Container License](https://developer.download.nvidia.com/licenses/NVIDIA_Deep_Learning_Container_License.pdf), and the licences of its open-source parts | The CUDA 12 and CUDA 13 harness images, and the rig image built on the CUDA 12 one. NVIDIA's software in them stays under NVIDIA's licence, which anyone who pulls or runs those images accepts |
| [kubectl](https://github.com/kubernetes/kubernetes) | The Kubernetes Authors | Apache-2.0 | Control, with its licence at `/usr/local/share/doc/kubectl/LICENSE` |
| [tini](https://github.com/krallin/tini) | Thomas Orozco | MIT | Every image, as the first process |
| The [NATS server](https://github.com/nats-io/nats-server) with JetStream, from the [official `nats` image](https://hub.docker.com/_/nats): 2.15.1 on Alpine Linux, pinned by digest | The NATS authors, a CNCF project; the image by its maintainers on Docker Hub | Apache-2.0, with the licences of the Alpine Linux packages in the image, among them BusyBox (GPL-2.0) | The compose files' `nats` service runs it beside control, as the message bus that rigs' reports, live lines, commands and config travel on, over TLS (goal 168). Its program alone, `nats-server`, is copied from that image, by the same digest, into the one-container rig image (17.4 MB): each RunPod pod's own server, which control's server dials as a leaf node (goal 168). `thermite backup` and `thermite restore` take and restore its `EVENTS` stream through its snapshot API, and control reads its store's use from its monitoring (goal 173) |
| Debian and Ubuntu packages: git, GCC, GNU Make, CMake, Ninja, ccache, Python 3 with NumPy, OpenSSH's client, util-linux (setpriv, prlimit, taskset, setsid), CA certificates | Their projects, packaged by Debian and Ubuntu | Their own: for example GPL-2.0 for git, GPL-3.0-or-later with the GCC Runtime Library Exception for GCC, BSD-3-Clause for CMake and NumPy, Apache-2.0 for Ninja | The harness (to build and run kits; `setsid` starts an agent's program on its own terminal, goal 169) and control and the supervisor (git and SSH). Each package's terms are in `/usr/share/doc/<package>/copyright` in the image |

`thermite-devfence` (`containers/harness/devfence.c`) is Thermite's own code, built against the Linux kernel's Landlock interface.

## Libraries

### What Thermite runs

| Library | By | Licence | What it does in Thermite |
| --- | --- | --- | --- |
| [Hono](https://github.com/honojs/hono) and [@hono/node-server](https://github.com/honojs/node-server) | Yusuke Wada | MIT | The HTTP server and routes of control, the harness and the supervisor |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | The Model Context Protocol project (Anthropic) | MIT for the npm package Thermite uses; the repository is moving to Apache-2.0 | Control's MCP server, the harness's MCP gateway and the MCP client |
| [Zod](https://github.com/colinhacks/zod) | Colin McDonnell | MIT | Every schema: contracts, kits, commands, reports |
| [nats.js](https://github.com/nats-io/nats.js): `@nats-io/transport-node` and `@nats-io/jetstream`, with `@nats-io/nats-core` and `@nats-io/nuid` | The NATS authors | Apache-2.0 | The message bus's client, in control and the supervisor (`src/common/bus/`): the supervisor publishes rigs' reports to JetStream, takes its commands and asks control to search the knowledge base with a request and its reply, and control makes the streams, reads the reports with a durable consumer, answers those requests and asks the server to reload its users; `thermite backup` and `thermite restore` speak the snapshot API's subjects through it (`src/common/backup/`) |
| [nkeys.js](https://github.com/nats-io/nkeys.js): `@nats-io/nkeys` | The NATS authors | Apache-2.0 | Each part's own key on the message bus: the supervisor makes the rig's NATS user key, and control its own two and the backup's (`src/supervisor/relay/key.ts`, `src/control/bus/users.ts`), and control checks each key a rig registers (`src/core/link/users.ts`) |
| [TypeBox](https://github.com/sinclairzx81/typebox), through Pi's `@earendil-works/pi-ai` | sinclairzx81 | MIT | The tool and answer schemas that Pi's agents are given |
| Pi's packages, above | Mario Zechner | MIT | With their own dependencies, among them the AWS SDK for JavaScript, Google's Gen AI SDK, the OpenAI SDK (Apache-2.0 each) and protobuf.js (BSD-3-Clause) |
| [xterm.js](https://github.com/xtermjs/xterm.js): `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0 | The xterm.js authors | MIT | The terminal host's emulator, in the harness (goal 169): it keeps an agent program's screen from what the program writes, answers the queries a terminal answers, and gives the screen as text or as a snapshot that restores it |
| [xterm.js](https://github.com/xtermjs/xterm.js): `@xterm/xterm` 6.0.0, bundled: `lib/xterm.js` and `css/xterm.css`, with its licence, in `vendor/xterm/` | The xterm.js authors | MIT | Draws a trial's terminal on its Live page, in the owner's browser, read only (goal 169). Control serves the copy kept in the repository, only when its SHA-256 is the pinned one |
| [PDF.js](https://github.com/mozilla/pdf.js): `pdfjs-dist` 6.4.299, bundled: its legacy build's `pdf.mjs` and `pdf.worker.mjs`, with its licence, in `vendor/pdfjs/` | Mozilla and the PDF.js contributors | Apache-2.0 | Reads the text of the knowledge base's PDF files on control (goal 175), in a child process with no native module, its fonts, eval, WebAssembly and canvas off, and no fetch. Control loads the copy kept in the repository only when its SHA-256 values are the pinned ones; nothing else of the package is kept, and its optional native part for drawing pages, `@napi-rs/canvas`, is never installed |
| [node-pty](https://github.com/microsoft/node-pty) 1.1.0, built with [node-addon-api](https://github.com/nodejs/node-addon-api) 7.1.1 | Microsoft; node-addon-api by the Node.js project's Node-API team | MIT, both | The terminal host's pseudo-terminals, in the harness (goal 169), through node-pty's `open`. Its native part is built in the harness image, with node-addon-api's headers and npm's [node-gyp](https://github.com/nodejs/node-gyp) (MIT) and the Node.js headers from the Node stage, and in a stage of the supervisor image's own, with Debian's compiler, make and Python, at build time only: each image keeps only the built module. An optional dependency: `npm ci` leaves it out where it can't build it, and control leaves it out |
| [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui): `@earendil-works/pi-tui` 1.4.0 | Mario Zechner, Earendil Works | MIT | The Pi view, in the harness (goal 169): a worker in Pi draws Thermite's view of its own session in its own terminal, with pi-tui's main-screen renderer and its Text and Markdown components, its images and links off. Its prebuilt native helpers (`native/`, for a clipboard and modifier keys) are deleted in every image, and the view loads none |
| [marked](https://github.com/markedjs/marked) 18.0.11, through pi-tui | Christopher Jeffrey and the MarkedJS authors | MIT | pi-tui's Markdown parser: the agent's replies in the Pi view |
| [marked-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) 0.1.2, through pi-tui | Tatsunori Uchino | MIT | pi-tui's extension to marked that reads Markdown's emphasis next to Chinese, Japanese and Korean text as CommonMark means it |
| [get-east-asian-width](https://github.com/sindresorhus/get-east-asian-width) 1.6.0, through pi-tui | Sindre Sorhus | MIT | pi-tui's measure of how many columns a character takes in a terminal |

Every package Thermite runs, with those packages' own dependencies, is under a permissive licence: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD or the Unlicense. None is copyleft. `package-lock.json` lists each one, with its version.

### What builds and checks Thermite

[TypeScript](https://github.com/microsoft/TypeScript) (Microsoft, Apache-2.0), [Biome](https://github.com/biomejs/biome) (MIT OR Apache-2.0), [Node.js's type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped) (MIT), [Playwright](https://github.com/microsoft/playwright) (Microsoft, Apache-2.0), whose `playwright-core` drives the installed Google Chrome for the browser acceptance check, and [gitleaks](https://github.com/gitleaks/gitleaks) (MIT) for the secret scan. CI uses GitHub's own actions (MIT) and Docker's (Apache-2.0).

### What builds the documentation site

| Library | By | Licence |
| --- | --- | --- |
| [Astro](https://github.com/withastro/astro) and [Starlight](https://github.com/withastro/starlight) | The Astro project; Chris Swithinbank | MIT |
| [Pagefind](https://github.com/Pagefind/pagefind) (search), [Expressive Code](https://github.com/expressive-code/expressive-code) and [Shiki](https://github.com/shikijs/shiki) (code blocks) | Their projects | MIT |
| [Mermaid](https://github.com/mermaid-js/mermaid) and [astro-mermaid](https://github.com/joesaby/astro-mermaid) (diagrams) | Knut Sveidqvist and contributors; Jose Sebastian | MIT. Mermaid's diagrams use [DOMPurify](https://github.com/cure53/DOMPurify), MPL-2.0 OR Apache-2.0, in the reader's browser |
| [starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator) and [starlight-llms-txt](https://github.com/delucis/starlight-llms-txt) | HiDeoo; Chris Swithinbank | MIT |
| [sharp](https://github.com/lovell/sharp) (images) | Lovell Fuller | Apache-2.0; its libvips binaries are LGPL-3.0-or-later, used only to build the site |
| [Lightning CSS](https://github.com/parcel-bundler/lightningcss), through Vite | The Parcel project | MPL-2.0, used only to build the site |
| The site's own pages' fonts, served from the site: [Geist and Geist Mono](https://github.com/vercel/geist-font), packaged by [Fontsource](https://github.com/fontsource/fontsource) | Vercel; the Fontsource project | The fonts OFL-1.1; Fontsource's packaging MIT |

`docs/_site/package-lock.json` lists every package, with its licence and version.

## Design

- **The dashboard's look** follows [Magnesium](https://github.com/iammrduncan/magnesium) (MIT), the maintainers' agent dashboard, which is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT, © 2026 T3 Tools Inc.): its design tokens, its status words, its tiles and its session board. The colour values are those of [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)'s palette (MIT).
- **The site's own pages** (the home page and the overviews of the use cases and studies) follow the home pages of the maintainers' [tensorless.dev](https://tensorless.dev) and [fxbot.sh](https://fxbot.sh): a frame of their own beside the docs, a command to copy, numbered steps, and a picture drawn from real data. The replay of a real climb and the ledger are Thermite's own.
- **The icons and the flame** are Thermite's own.

## Standards and guides

| Work | By | Licence | How Thermite uses it |
| --- | --- | --- | --- |
| [Diátaxis](https://diataxis.fr/) | Daniele Procida | © Daniele Procida; [its source](https://github.com/evildmp/diataxis-documentation-framework) is CC BY-SA 4.0 | The documentation site's four kinds of page |
| [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/), Issue 9 | ASD's Simplified Technical English Maintenance Group | © ASD, all rights reserved; a trademark of ASD; its notice forbids redistributing the standard without the group's written permission | The dashboard's decision cards and the reports are written after it. A research run's final paper is written in it, and checked against it by a checker the deployment provides (`THERMITE_STE_CHECKER`), whose guide the final writer reads when it has one; without a checker, the writer gets short rules in Thermite's own words. Thermite ships no checker, none of the standard's vocabulary and none of its text |
| [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) | The Organization for Ethical Source | CC BY 4.0 | Thermite's code of conduct, adopted by reference |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Anthropic and contributors | See the MCP TypeScript SDK, above | Control's MCP server, and the MCP servers a campaign's agents use |
| [llms.txt](https://llmstxt.org/) | Jeremy Howard, Answer.AI | No licence stated on the page; [its repository](https://github.com/AnswerDotAI/llms-txt) is Apache-2.0 | The site's `llms.txt` and `llms-full.txt` |
| [SPDX license expressions](https://spdx.dev/) and [OCI image annotations](https://github.com/opencontainers/image-spec) | The Linux Foundation; the Open Container Initiative | CC BY 3.0; Apache-2.0 | The licence labels on the published images |
| [Semantic Versioning](https://semver.org/) | Tom Preston-Werner | CC BY 3.0 | The release's version tags |
| The [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec) and the [Docker registry's token authentication](https://distribution.github.io/distribution/spec/auth/token/) | The Open Container Initiative; the CNCF Distribution project | Apache-2.0 | How `scripts/release/pins.ts` asks an image's registry, with no sign-in, which digest a pinned tag has now: a manifest request, and a pull token from the address the registry's first answer names |
| IETF RFCs: Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)), HKDF ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)), PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), dynamic client registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)), timestamps ([RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)), private addresses ([RFC 1918](https://www.rfc-editor.org/rfc/rfc1918)), the shared address range ([RFC 6598](https://www.rfc-editor.org/rfc/rfc6598)), link-local addresses ([RFC 3927](https://www.rfc-editor.org/rfc/rfc3927)), robots.txt ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)), X.509 certificates ([RFC 5280](https://www.rfc-editor.org/rfc/rfc5280)) with ECDSA signatures ([RFC 5758](https://www.rfc-editor.org/rfc/rfc5758)) | The IETF | The IETF Trust's licence | Signed commands, sealed secrets, MCP sign-in, the research fetcher, the ranges a cluster rig's harness never reaches, and the certificates of the message bus's TLS, which control writes itself (its authority and the server's certificate) and signs with Node's crypto |
| [Public Suffix List](https://publicsuffix.org/) | Mozilla and its contributors | MPL-2.0 | The idea of a registrable domain, and a short table of its suffixes of more than one label (such as `co.uk` and `github.io`), written in Thermite's code, so that a research run's corroboration counts the sites claims come from, not their hosts. Thermite ships no copy of the list |
| AES-256-GCM ([NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)) | NIST | A U.S. government work | Sealed secrets |
| [Container Device Interface](https://github.com/cncf-tags/container-device-interface) (CDI) | The CNCF's Container Orchestrated Devices working group | Apache-2.0 | How Podman gives a rig's harness its NVIDIA GPUs, as `nvidia.com/gpu` devices: on machines that control sets rigs up on, and in the local stack's `compose.gpu.yaml` |
| The tar formats: [POSIX's ustar and pax interchange formats](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html) and [GNU tar's long names](https://www.gnu.org/software/tar/manual/html_node/Standard.html) | The IEEE and The Open Group; the Free Software Foundation | © IEEE and The Open Group, on their terms; GNU tar's manual is under the GNU Free Documentation License | How control reads a kit archive uploaded on **New campaign** in memory: each entry's name, type and size from its header (`src/control/kits/upload.ts`) |
| [The ZIP file format specification](https://support.pkware.com/pkzip/appnote) (APPNOTE.TXT) | PKWARE | © PKWARE, Inc., on the terms the document states | How control reads an uploaded `.zip` kit: its central directory and each entry's local header, inflated with Node's zlib |

## Services Thermite works with

- **Model providers:** the APIs of [Anthropic](https://www.anthropic.com/) and [OpenAI](https://openai.com/), Claude and ChatGPT subscriptions, [OpenRouter](https://openrouter.ai/) and [Nous Portal](https://portal.nousresearch.com/) (whose model lists give prices), [OpenCode Zen](https://opencode.ai/zen), and any server with an OpenAI-compatible API, such as [Ollama](https://github.com/ollama/ollama), [vLLM](https://github.com/vllm-project/vllm) or [LiteLLM](https://github.com/BerriAI/litellm).
- **Compute and files:** [RunPod](https://www.runpod.io/), through its REST API (v2; a pod's record gives the public address and port of each of its TCP ports, in `runtime.ports`, which control's message bus dials, as [its reference for getting a pod](https://docs.runpod.io/api-reference-v2/pods/get-a-pod) says, read 2026-10-30) and its proxy; [Hugging Face](https://huggingface.co/), for model files.
- **A knowledge base, as an example of an MCP server:** [GBrain](https://github.com/garrytan/gbrain) (Garry Tan, MIT).
- **The project:** [GitHub](https://github.com/), for the repository, Actions, the container registry, Dependabot and private vulnerability reports; [Cloudflare Pages](https://pages.cloudflare.com/), which serves the documentation site; [Fathom Analytics](https://usefathom.com/), which counts the site's visits without cookies; [Discord](https://discord.com/), for the community; [shields.io](https://shields.io/), for the badges.
- **Images:** [Docker Hub](https://hub.docker.com/) for the base images, and [Quay](https://quay.io/) for a test image.

## Tools Thermite is tested with

[Podman](https://github.com/containers/podman), [Docker](https://www.docker.com/) and their compose tools; [Kubernetes](https://github.com/kubernetes/kubernetes) and [kind](https://github.com/kubernetes-sigs/kind) (Apache-2.0 each), with systemd's Quadlet units for rigs on machines; [NVIDIA's device plugin](https://github.com/NVIDIA/k8s-device-plugin) and [DRA driver](https://github.com/kubernetes-sigs/dra-driver-nvidia-gpu) (Apache-2.0); [NVIDIA's container toolkit](https://github.com/NVIDIA/nvidia-container-toolkit) (Apache-2.0), which gives containers the GPUs, through its runtime for Docker and its CDI spec for Podman, and which `thermite doctor` and `thermite local init` check for; Fedora's and Debian's images as stand-in machines; [uv](https://github.com/astral-sh/uv) (Apache-2.0 OR MIT) to run the statistics reference script; and Chrome, which takes the documentation's screenshots. A manual long-run test starts its research from two Wikipedia articles (CC BY-SA 4.0), which it fetches when it runs.

## What the studies report on

The site's [studies](https://usethermite.com/studies/) tell campaigns that Thermite ran. They report on these works; Thermite uses none of their code, weights or data.

- [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) (the Qwen team, Alibaba, Apache-2.0): the model of the first study, Qwen3.8-27B on a $100 GPU.
- [unsloth/Qwen3.8-27B-GGUF](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) (Unsloth, Apache-2.0): its UD-IQ3_XXS file is most of Q3Floor, the standard 3-bit model that the first study compares against.

## What the use cases cite

The site's [use cases](https://usethermite.com/use-cases/) say what Thermite can be pointed at. Each cites published work by others as background, as theirs and not Thermite's, and names tools that a kit could wrap. Thermite uses none of their code, weights or data. Works already credited above are cited or named there too: FunSearch, AlphaEvolve, the AI Scientist, METR's report on reward hacking, GEPA, Karpathy's autoresearch, TechCrunch's report on Sakana's AI CUDA Engineer, llama.cpp and ggml, vLLM, ExLlamaV3, AWQ, Ollama, Qwen3.8-27B, Hugging Face, CUDA, Kubernetes, Ubuntu, TypeScript, Python, SciPy, CMake, the Model Context Protocol, GRADE and Claude Code.

**Software.**

- [Performance: 53% faster parse+render, 61% fewer allocations](https://github.com/Shopify/liquid/pull/2056) (2026), Tobi Lütke, a pull request to Shopify's Liquid (MIT): an agent loop's speed-up of a template engine, cited on Code performance optimization.
- [90% Failure Rate: Why GPT-4o Can't Optimize Code (And What We Built Instead)](https://hackernoon.com/90percent-failure-rate-why-gpt-4o-cant-optimize-code-and-what-we-built-instead) (2026), Saurabh Misra (Codeflash), © the author: how many proposed optimizations were incorrect, on the same page.
- [How Airbnb Used LLMs to Accelerate Test Migration](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/) (2025), InfoQ, © C4Media: a large test migration, on Codebase migration.
- [ImpossibleBench: Measuring LLMs' Propensity of Exploiting Test Cases](https://arxiv.org/abs/2510.20270) (2025), Zhong, Raghunathan, Carlini, CC BY 4.0: how often models edit tests to pass them, on the same page.
- [perf](https://perfwiki.github.io/main/), the Linux kernel developers, GPL-2.0: named on Code performance optimization.
- [FlameGraph](https://github.com/brendangregg/FlameGraph), Brendan Gregg, CDDL-1.0: named on Code performance optimization.
- [Google Benchmark](https://github.com/google/benchmark), Google, Apache-2.0: named on Code performance optimization.
- [JMH](https://github.com/openjdk/jmh), the OpenJDK project, GPL-2.0 with the Classpath Exception: named on Code performance optimization.
- [Criterion.rs](https://github.com/criterion-rs/criterion.rs), Jorge Aparicio and the maintainers, MIT or Apache-2.0: named on Code performance optimization.
- [pytest-benchmark](https://github.com/ionelmc/pytest-benchmark), Ionel Cristian Mărieș, BSD-2-Clause: named on Code performance optimization.
- [hyperfine](https://github.com/sharkdp/hyperfine), David Peter, MIT or Apache-2.0: named on Code performance optimization.
- [Spring Boot](https://github.com/spring-projects/spring-boot), the Spring team, Apache-2.0: named on Codebase migration.
- [Spring Boot 3.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.0-Migration-Guide), the Spring Boot team, no licence stated: cited on Codebase migration.
- [Spring Security](https://github.com/spring-projects/spring-security), the Spring team, Apache-2.0: named on Codebase migration.
- [Hibernate ORM](https://github.com/hibernate/hibernate-orm), the Hibernate team, Apache-2.0: named on Codebase migration.
- [OpenJDK](https://openjdk.org/), Oracle and the OpenJDK community, GPL-2.0 with the Classpath Exception: named on Codebase migration.
- [Apache Maven](https://maven.apache.org/), The Apache Software Foundation, Apache-2.0: named on Codebase migration.
- [OpenRewrite](https://github.com/openrewrite/rewrite), Moderne and contributors, Apache-2.0 (core); some recipes under Moderne licences: named on Codebase migration.
- [PIT](https://pitest.org/), Henry Coles, Apache-2.0: named on Codebase migration.
- [Enzyme](https://github.com/enzymejs/enzyme), Airbnb and contributors, MIT: named on Codebase migration.
- [React Testing Library](https://github.com/testing-library/react-testing-library), Kent C. Dodds and contributors, MIT: named on Codebase migration.
- [Jest](https://github.com/jestjs/jest), Meta Platforms and contributors, MIT: named on Codebase migration.
- [How is Google using AI for internal code migrations?](https://arxiv.org/abs/2501.06972) (2025), Nikolov, Codecasa, Sjovall et al., CC BY 4.0: cited on Codebase migration.
- [Jepsen's analyses](https://jepsen.io/analyses), Kyle Kingsbury (Jepsen, LLC), © Jepsen, LLC: consistency tests of distributed databases, named on Technology evaluation and used as its starting link.
- [Jepsen: PostgreSQL 12.3](https://jepsen.io/analyses/postgresql-12.3) (2020), Kyle Kingsbury (Jepsen, LLC), © Jepsen, LLC: serializable transactions that were not serializable, cited on Technology evaluation.
- [PostgreSQL](https://www.postgresql.org/), the PostgreSQL Global Development Group, PostgreSQL License: named on Technology evaluation.
- [CockroachDB](https://github.com/cockroachdb/cockroach), Cockroach Labs, CockroachDB Software License: named on Technology evaluation.
- [Enterprise license announcement](https://www.cockroachlabs.com/blog/enterprise-license-announcement/) (2024), Spencer Kimball (Cockroach Labs), © Cockroach Labs: the retirement of CockroachDB Core, cited on Technology evaluation.
- [YugabyteDB](https://github.com/yugabyte/yugabyte-db), Yugabyte, Apache-2.0 for the core database and the Polyform Free Trial License 1.0.0 for some components: named on Technology evaluation.
- [TiDB](https://github.com/pingcap/tidb), PingCAP, Apache-2.0: named on Technology evaluation.
- [A List of Post-mortems](https://github.com/danluu/post-mortems), Dan Luu and contributors, no licence stated: a starting link on Technology evaluation.
- [Gemini Deep Research](https://gemini.google/overview/deep-research/), Google, a service under Google's terms: how long a typical task runs, cited on Technology evaluation.

**AI and machine learning.**

- [nanochat](https://github.com/karpathy/nanochat) (2025), Andrej Karpathy, MIT: its leaderboard's time to train a GPT-2-level model, on Model training efficiency.
- [DSPy](https://github.com/stanfordnlp/dspy), Stanford NLP, MIT: named on LLM application quality.
- [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) (2023), Zheng, Chiang, Sheng et al., arXiv non-exclusive licence: cited on LLM application quality.
- [AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration](https://arxiv.org/abs/2306.00978) (2023), Lin, Tang, Tang et al., arXiv non-exclusive licence: named on LLM inference optimization.
- [GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers](https://arxiv.org/abs/2210.17323) (2022), Frantar, Ashkboos, Hoefler, Alistarh, CC BY 4.0: named on LLM inference optimization.
- [modded-nanogpt](https://github.com/KellerJordan/modded-nanogpt), Keller Jordan and contributors, MIT: cited on Model training efficiency.
- [FineWeb](https://huggingface.co/datasets/HuggingFaceFW/fineweb), Hugging Face, ODC-By: named on Model training efficiency.
- [Muon: An optimizer for hidden layers in neural networks](https://kellerjordan.github.io/posts/muon/) (2024), Keller Jordan et al., repository MIT: named on Model training efficiency.
- [Decoupled Weight Decay Regularization](https://arxiv.org/abs/1711.05101) (2017), Loshchilov, Hutter, arXiv non-exclusive licence: named on Model training efficiency.
- [RULER: What's the Real Context Size of Your Long-Context Language Models?](https://arxiv.org/abs/2404.06654) (2024), Hsieh, Sun, Kriman et al. (NVIDIA), CC BY 4.0, with [its code](https://github.com/NVIDIA/RULER) (Apache-2.0): a long-context benchmark, cited on Model and method landscape.
- [HELMET: How to Evaluate Long-Context Language Models Effectively and Thoroughly](https://arxiv.org/abs/2410.02694) (2024), Yen, Gao, Hou et al., arXiv non-exclusive licence, with [its code](https://github.com/princeton-nlp/HELMET) (MIT): cited on Model and method landscape.
- [NoLiMa: Long-Context Evaluation Beyond Literal Matching](https://arxiv.org/abs/2502.05167) (2025), Modarressi, Deilamsalehy, Dernoncourt et al. (Adobe Research), CC BY-NC-SA 4.0, with [its code and data](https://github.com/adobe-research/NoLiMa) (Adobe Research License): cited on Model and method landscape.
- [LongBench v2](https://arxiv.org/abs/2412.15204) (2024), Bai, Tu, Zhang et al. (THUDM), arXiv non-exclusive licence, with [LongBench](https://github.com/THUDM/LongBench) (MIT): named on Model and method landscape.
- [A Careful Examination of Large Language Model Performance on Grade School Arithmetic](https://arxiv.org/abs/2405.00332) (GSM1k, 2024), Zhang, Da, Lee et al., CC BY 4.0: test-set contamination, cited on Model and method landscape.
- [The Leaderboard Illusion](https://arxiv.org/abs/2504.20879) (2025), Singh, Nan, Wang et al., CC BY-SA 4.0: private variants tested before a leaderboard release, cited on Model and method landscape.
- [GSM8K](https://github.com/openai/grade-school-math), from [Training Verifiers to Solve Math Word Problems](https://arxiv.org/abs/2110.14168) (2021), Cobbe, Kosaraju, Bavarian et al. (OpenAI), MIT: named on Model and method landscape.
- [YaRN: Efficient Context Window Extension of Large Language Models](https://arxiv.org/abs/2309.00071) (2023), Peng, Quesnelle, Fan and Shippole, CC BY 4.0: named on Model and method landscape.
- [Gemma 4 31B](https://huggingface.co/google/gemma-4-31B-it), Google DeepMind, Apache-2.0: named on Model and method landscape.
- [Llama 4 Scout](https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct), Meta, Llama 4 Community License Agreement: named on Model and method landscape.
- [Qwen3-32B](https://huggingface.co/Qwen/Qwen3-32B), the Qwen team (Alibaba), Apache-2.0: named on Fitting a model to your hardware.
- [Qwen_Qwen3-32B-GGUF](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF), bartowski, Apache-2.0: quantized files and their sizes, named on Fitting a model to your hardware.
- [Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF), the Qwen team (Alibaba), Apache-2.0: a draft model, named on Fitting a model to your hardware.
- [nvidia-smi](https://developer.nvidia.com/system-management-interface), NVIDIA, shipped with the NVIDIA driver, no licence stated: named on Fitting a model to your hardware.
- [WikiText](https://huggingface.co/datasets/Salesforce/wikitext), from [Pointer Sentinel Mixture Models](https://arxiv.org/abs/1609.07843) (2016), Merity, Xiong, Bradbury and Socher (Salesforce), CC BY-SA 3.0 and GFDL: Wikitext-2, named on Fitting a model to your hardware.
- [Chatbot Arena: An Open Platform for Evaluating LLMs by Human Preference](https://arxiv.org/abs/2403.04132) (2024), Chiang, Zheng, Sheng et al. (LMSYS), arXiv non-exclusive licence: the leaderboard The Leaderboard Illusion studied, named on Model and method landscape.

**Science.**

- [Mathematical exploration and discovery at scale](https://arxiv.org/abs/2511.02864) (2025), Georgiev, Gómez-Serrano, Tao and Wagner, CC BY 4.0: AlphaEvolve cheating a numerical scoring function, on Mathematical discovery.
- [CodePDE: An Inference Framework for LLM-driven PDE Solver Generation](https://arxiv.org/abs/2505.08783) (2025), Li, Marwah, Shen et al., CC BY 4.0: solvers written by language models, and how many fail a convergence test, on Simulation speed and accuracy.
- [Weak baselines and reporting biases lead to overoptimism in machine learning for fluid-related partial differential equations](https://arxiv.org/abs/2407.07218) (2024), McGreivy and Hakim, CC BY 4.0: weak baselines, on the same page.
- [Fabrication and errors in the bibliographic citations generated by ChatGPT](https://doi.org/10.1038/s41598-023-41032-5) (2023), Walters and Wilder, *Scientific Reports*, CC BY 4.0: fabricated citations, on Literature review.
- [Kosmos: An AI Scientist for Autonomous Discovery](https://arxiv.org/abs/2511.02824) (2025), Mitchener, Yiu, Chang et al., CC BY 4.0: experts' ratings of an AI scientist's statements, on the same page.
- [CaDiCaL](https://github.com/arminbiere/cadical), Biere, Fazekas, Fleury, Froleyks et al., MIT: named on Mathematical discovery.
- [Kissat](https://github.com/arminbiere/kissat), Biere, Fleury, Pollitt, MIT: named on Mathematical discovery.
- [Schur Number Five](https://arxiv.org/abs/1711.08076) (2017), Marijn J. H. Heule, arXiv non-exclusive licence: cited on Mathematical discovery.
- [LAMMPS](https://github.com/lammps/lammps), the LAMMPS developers (Sandia National Laboratories), GPL-2.0: named on Simulation speed and accuracy.
- [GROMACS](https://gitlab.com/gromacs/gromacs), and its [user guide on reproducibility](https://manual.gromacs.org/current/user-guide/managing-simulations.html), the GROMACS development team, LGPL-2.1: named and quoted on Simulation speed and accuracy.
- [OpenFOAM](https://github.com/OpenFOAM/OpenFOAM-dev), the OpenFOAM Foundation, GPL-3.0: named on Simulation speed and accuracy.
- [PETSc](https://gitlab.com/petsc/petsc), UChicago Argonne and the PETSc developers, BSD-2-Clause: named on Simulation speed and accuracy.
- [hypre](https://github.com/hypre-space/hypre) (BoomerAMG), Lawrence Livermore National Laboratory and contributors, Apache-2.0 or MIT: named on Simulation speed and accuracy.
- [OpenMP API](https://www.openmp.org/specifications/), OpenMP Architecture Review Board, © OpenMP: named on Simulation speed and accuracy.
- [Google Scholar](https://scholar.google.com/), Google, service: named on Literature review.
- [PubMed](https://pubmed.ncbi.nlm.nih.gov/), US National Library of Medicine, US government service: named on Literature review, and with MEDLINE on Clinical evidence review.
- [Scopus](https://www.scopus.com/), Elsevier, subscription service: named on Literature review.
- [Zotero](https://github.com/zotero/zotero), Corporation for Digital Scholarship, AGPL-3.0: named on Literature review.
- [Cochrane Handbook for Systematic Reviews of Interventions, chapter 4](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-04) (v6.5.1), Higgins, Thomas, Chandler et al. (eds.), © The Cochrane Collaboration: cited on Literature review.
- [The PRISMA 2020 statement](https://doi.org/10.1136/bmj.n71) (2021), Page, McKenzie, Bossuyt et al., BMJ, CC BY 4.0: cited on Literature review and Clinical evidence review.
- [Analysis of the time and workers needed to conduct systematic reviews of medical interventions](https://doi.org/10.1136/bmjopen-2016-012545) (2017), Borah, Brown, Capers, Kaiser, BMJ Open, CC BY-NC 4.0: cited on Literature review and Clinical evidence review.
- [An open-access database and analysis tool for perovskite solar cells based on the FAIR data principles](https://doi.org/10.1038/s41560-021-00941-3) (2022), Jacobsson, Hultqvist, García-Fernández et al., CC BY 4.0: a database built by hand from over 15,000 papers, cited on Data from the literature.
- [The Perovskite Database](https://www.perovskitedatabase.com/), the Perovskite Database Project, data CC BY 4.0 and code MIT: named on Data from the literature.
- [Consensus statement for stability assessment and reporting for perovskite photovoltaics based on ISOS procedures](https://doi.org/10.1038/s41560-019-0529-5) (2020), Khenkin et al., CC BY 4.0: named on Data from the literature.
- [ChemDataExtractor](https://github.com/mcs07/ChemDataExtractor), Matt Swain and the Molecular Engineering Group, University of Cambridge, MIT, with [its paper](https://doi.org/10.1021/acs.jcim.6b00207) (2016), Swain and Cole, © American Chemical Society: named on Data from the literature.
- [A database of battery materials auto-generated using ChemDataExtractor](https://doi.org/10.1038/s41597-020-00602-2) (2020), Huang and Cole, CC BY 4.0: cited on Data from the literature.
- [NIST/ARPA-E Database of Novel and Emerging Adsorbent Materials](https://adsorption.nist.gov/isodb/index.php), NIST, © U.S. Department of Commerce: cited on Data from the literature.
- [Web of Science](https://www.webofscience.com/), Clarivate, a subscription service: named on Data from the literature.
- [Elsevier Developer Portal](https://dev.elsevier.com/), Elsevier, API terms: its data-mining APIs, named on Data from the literature.
- [Royal Society of Chemistry](https://www.rsc.org/), access on request: its data-mining access, named on Data from the literature.
- [Nature](https://www.nature.com/), Springer Nature, each article under its own licence: its article pages, named on Data from the literature.
- [WebPlotDigitizer](https://github.com/automeris-io/WebPlotDigitizer), Ankit Rohatgi, AGPL-3.0: named on Data from the literature.
- [Artifact Review and Badging, Version 1.1](https://www.acm.org/publications/policies/artifact-review-and-badging-current) (2020), ACM, © ACM: cited on Reproducing published results.
- [AEA Data and Code Availability Policy](https://www.aeaweb.org/journals/data/data-code-policy), the American Economic Association, © AEA: named on Reproducing published results.
- [Machine Learning Reproducibility Challenge](https://reproml.org/), its organizers, no licence stated: named on Reproducing published results.
- [A large-scale study on research code quality and execution](https://doi.org/10.1038/s41597-022-01143-6) (2022), Trisovic, Lau, Pasquier et al., CC BY 4.0: how often R code runs, cited on Reproducing published results.
- [Harvard Dataverse](https://dataverse.harvard.edu/), Harvard University (IQSS), a service: named on Reproducing published results.
- [Zenodo](https://zenodo.org/), CERN, a service: named on Reproducing published results.
- [Code Ocean](https://codeocean.com/), Code Ocean, Inc., a service: named on Reproducing published results.
- [CORE-Bench](https://arxiv.org/abs/2409.11363) (2024), Siegel, Kapoor, Nadgir, Stroebl and Narayanan, CC BY 4.0, with [HAL's CORE-Bench Hard leaderboard](https://hal.cs.princeton.edu/corebench_hard) (Princeton University): cited on Reproducing published results.
- [PaperBench: Evaluating AI's Ability to Replicate AI Research](https://arxiv.org/abs/2504.01848) (2025), Starace, Jaffe, Sherburn et al. (OpenAI), CC BY 4.0: cited on Reproducing published results.
- [R](https://www.r-project.org/), the R Foundation, GPL-2 or GPL-3: named on Reproducing published results.
- [renv](https://github.com/rstudio/renv), Posit, MIT: named on Reproducing published results.
- [MATLAB](https://www.mathworks.com/products/matlab.html), MathWorks, proprietary: named on Reproducing published results.
- [Stata](https://www.stata.com/), StataCorp, proprietary: named on Reproducing published results.
- [OpenAlex](https://openalex.org/), OurResearch, data CC0: named on Literature review.
- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), Crossref, metadata free to use: named on Literature review.
- [Retraction Watch database](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/), Crossref (acquired in 2023), made public: cited on Literature review.
- [ScienceDirect](https://www.sciencedirect.com/), Elsevier, a subscription service: named on Literature review.
- [A benchmark of batch-effect correction methods for single-cell RNA sequencing data](https://doi.org/10.1186/s13059-019-1850-9) (2020), Tran, Ang, Chevrier et al., CC BY: cited on Literature review.
- [Benchmarking atlas-level data integration in single-cell genomics](https://doi.org/10.1038/s41592-021-01336-8) (2022), Luecken, Büttner, Chaichoompu et al., CC BY: cited on Literature review.
- [scib](https://github.com/theislab/scib), the Theis lab, MIT: named on Literature review.
- [Harmony](https://github.com/immunogenomics/harmony), the immunogenomics group, GPL-3: named on Literature review.
- [LIGER](https://github.com/welch-lab/liger), the Welch lab, GPL-3.0: named on Literature review.
- [Seurat](https://github.com/satijalab/seurat), the Satija lab, MIT: named on Literature review.
- [scvi-tools](https://github.com/scverse/scvi-tools), with scVI and scANVI, scverse, BSD-3-Clause: named on Literature review.
- [Scanorama](https://github.com/brianhie/scanorama), Brian Hie, MIT: named on Literature review.
- [scGen](https://github.com/theislab/scgen), the Theis lab, GPL-3.0: named on Literature review.
- [NumPy](https://github.com/numpy/numpy), the NumPy developers, BSD-3-Clause: its 1.24 release, which removed `np.float`, named on Reproducing published results.
- [arXiv](https://arxiv.org/), Cornell University, a service, each paper under its own licence: its HTML versions of papers, named on Model and method landscape, Data from the literature, Reproducing published results, Literature review and Pricing model validation.

**Healthcare and life sciences.**

- [Accelerating genomic workflows using NVIDIA Parabricks](https://doi.org/10.1186/s12859-023-05292-2) (2023), O'Connell, Yosufzai, Campbell et al., *BMC Bioinformatics*, CC BY 4.0: CPU and GPU run times of variant calling, on Genomics pipeline acceleration.
- [Is manual software optimization a thing of the past?](https://arxiv.org/abs/2609.37849) (2026), Poličar, Špendl, Hočevar, arXiv non-exclusive licence: an agent's speed-ups of bioinformatics methods, on the same page.
- [PrecisionFDA Truth Challenge V2](https://doi.org/10.1016/j.xgen.2022.100129) (2022), Olson, Wagner, McDaniel et al., *Cell Genomics*, CC BY 4.0: samples held back against overfitting, on the same page.
- [Genome in a Bottle](https://www.nist.gov/programs-projects/genome-bottle), NIST and the Genome in a Bottle Consortium, data of the US government, not subject to copyright in the US: the truth sets, named on the same page.
- [hap.py](https://github.com/Illumina/hap.py), Illumina, BSD-2-Clause: the tool that scores calls against a truth set, named on the same page.
- [nnU-Net Revisited: A Call for Rigorous Validation in 3D Medical Image Segmentation](https://arxiv.org/abs/2404.09556) (2024), Isensee, Wald, Ulrich et al., CC BY 4.0: claims that fail against strong baselines, on Medical image segmentation.
- [Camyla: Scaling Autonomous Research in Medical Image Segmentation](https://arxiv.org/abs/2604.10696) (2026), Gao, Li, Yuan et al., arXiv non-exclusive licence: an agent system's segmentation models, on the same page.
- [nnU-Net](https://github.com/MIC-DKFZ/nnUNet), Isensee, Jaeger, Kohl et al. (MIC-DKFZ), Apache-2.0: named as a starting point, and its residual-encoder presets cited for training times and Dice on KiTS, on the same page.
- [Use of MIMIC Data with Large Language Models and Online Services](https://physionet.org/news/post/llm-responsible-use/) (2025), PhysioNet (MIT Laboratory for Computational Physiology), © MIT LCP: its rule against sending its data through APIs, on Clinical note de-identification.
- [SHIELD: A Diverse Clinical Note Dataset and Distilled Small Language Models for Enterprise-Scale De-identification](https://arxiv.org/abs/2605.03301) (2026), Posada, Love, Datta et al., arXiv non-exclusive licence: a small de-identification model's scores, on the same page.
- [Hallucination Rates and Reference Accuracy of ChatGPT and Bard for Systematic Reviews](https://doi.org/10.2196/53164) (2024), Chelli, Descamps, Lavoué et al., *JMIR*, CC BY 4.0: hallucinated references, on Clinical evidence review.
- [Automation of Systematic Reviews with Large Language Models](https://doi.org/10.1101/2025.06.13.25329541) (2025), Cao, Arora, Cento et al., medRxiv preprint, CC BY 4.0: otto-SR's reviews, on the same page.
- [BWA-MEM2](https://github.com/bwa-mem2/bwa-mem2), Intel Corporation, Heng Li, MIT: named on Genomics pipeline acceleration.
- [samtools](https://github.com/samtools/samtools), Genome Research Ltd, MIT/Expat: named on Genomics pipeline acceleration.
- [GATK](https://github.com/broadinstitute/gatk) (HaplotypeCaller), Broad Institute, Apache-2.0: named on Genomics pipeline acceleration.
- [DeepVariant](https://github.com/google/deepvariant), Google, BSD-3-Clause: named on Genomics pipeline acceleration.
- [Nextflow](https://github.com/nextflow-io/nextflow), Seqera and the Nextflow contributors, Apache-2.0: named on Genomics pipeline acceleration.
- [nf-core/sarek](https://github.com/nf-core/sarek), the nf-core community, MIT: named on Genomics pipeline acceleration.
- [Slurm](https://github.com/SchedMD/slurm), SchedMD, GPL-2.0: named on Genomics pipeline acceleration and Cluster and job scheduling.
- [MONAI](https://github.com/Project-MONAI/MONAI), Project MONAI contributors, Apache-2.0: named on Medical image segmentation.
- [PyTorch](https://github.com/pytorch/pytorch), the PyTorch Foundation and contributors (originally Facebook), BSD-style (3-clause): named on Medical image segmentation and Reproducing published results.
- [The Medical Segmentation Decathlon](https://doi.org/10.1038/s41467-022-30695-9) (2022), Antonelli, Reinke, Bakas et al., Nature Communications, article CC BY 4.0, data CC BY-SA 4.0: named and quoted on Medical image segmentation.
- [KiTS23](https://kits-challenge.org/kits23/), Heller, Wood, Isensee et al., data CC BY-NC-SA 4.0: named on Medical image segmentation.
- [45 CFR 164.514, HIPAA de-identification](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E/section-164.514), US Department of Health and Human Services, US government work: named on Clinical note de-identification.
- [Philter](https://github.com/BCHSI/philter-ucsf), Norgeot, Muenzen, Peterson et al. (UCSF), BSD-3-Clause; [its paper](https://doi.org/10.1038/s41746-020-0258-y) CC BY 4.0: named on Clinical note de-identification.
- [Presidio](https://github.com/data-privacy-stack/presidio), Presidio contributors (started at Microsoft), MIT: named on Clinical note de-identification.
- [Annotating longitudinal clinical narratives for de-identification: the 2014 i2b2/UTHealth corpus](https://doi.org/10.1016/j.jbi.2015.07.020) (2015), Stubbs and Uzuner, © Elsevier: cited on Clinical note de-identification.
- [The n2c2 NLP research data sets](https://n2c2.dbmi.hms.harvard.edu/data-sets), Harvard DBMI, data use agreement: named on Clinical note de-identification.
- [Automatic detection of protected health information from clinic narratives](https://doi.org/10.1016/j.jbi.2015.06.015) (2015), Yang and Garibaldi, © Elsevier: cited on Clinical note de-identification.
- [GDPR, Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj), European Union, EU legal text: named on Clinical note de-identification.
- [Cochrane Handbook for Systematic Reviews of Interventions](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current), Higgins, Thomas, Chandler et al. (eds.), © The Cochrane Collaboration: named on Clinical evidence review.
- [RoB 2](https://doi.org/10.1136/bmj.l4898) (2019), Sterne, Savović, Page et al., BMJ, tool CC BY-NC-ND 4.0: named on Clinical evidence review.
- [PubMed Central](https://pmc.ncbi.nlm.nih.gov/), US National Library of Medicine, each article under its own licence: named on Clinical evidence review, Literature review, Data from the literature and Agronomic trial evidence.
- [Europe PMC](https://europepmc.org/), EMBL-EBI, each article under its own licence: named on Clinical evidence review, Literature review and Data from the literature.
- [CENTRAL](https://www.cochranelibrary.com/central), Cochrane, subscription: named on Clinical evidence review.
- [Embase](https://www.embase.com/), Elsevier, subscription: named on Clinical evidence review.
- [ONC Health IT Certification Program](https://www.healthit.gov/topic/certification-ehrs/about-onc-health-it-certification-program) and its [§ 170.315(g)(10) test method](https://www.healthit.gov/test-method/standardized-api-patient-and-population-services), ASTP/ONC (US HHS), US government work: cited on FHIR API conformance.
- [ONC Certification (g)(10) Standardized API Test Kit](https://github.com/onc-healthit/onc-certification-g10-test-kit), ONC, produced by MITRE, Apache-2.0: cited on FHIR API conformance.
- [Inferno](https://inferno-framework.github.io/) ([inferno-core](https://github.com/inferno-framework/inferno-core)), with its [US Core Test Kit](https://github.com/inferno-framework/us-core-test-kit) and [Bulk Data Access Test Kit](https://github.com/inferno-framework/bulk-data-test-kit), The MITRE Corporation, Apache-2.0: cited on FHIR API conformance.
- [HL7 FHIR Validator](https://hl7.org/fhir/validator/) ([org.hl7.fhir.core](https://github.com/hapifhir/org.hl7.fhir.core)), HL7 International and the HAPI FHIR contributors, Apache-2.0: named on FHIR API conformance.
- [HL7 FHIR R4](https://hl7.org/fhir/R4/), HL7 International, CC0: named on FHIR API conformance.
- [US Core Implementation Guide](https://hl7.org/fhir/us/core/STU6.1/) (6.1.0, with 7.0.0 and 8.0.1), HL7 International, used by permission of HL7: named on FHIR API conformance.
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/STU2/) and the [Bulk Data Access Implementation Guide](https://hl7.org/fhir/uv/bulkdata/STU2/), HL7 International and Boston Children's Hospital, © HL7: named on FHIR API conformance.
- [USCDI](https://isp.healthit.gov/united-states-core-data-interoperability-uscdi), ASTP/ONC, US government work: named on FHIR API conformance.
- [Synthea](https://github.com/synthetichealth/synthea), The MITRE Corporation, Apache-2.0: synthetic patients from a seed, cited on FHIR API conformance.
- [LOINC](https://loinc.org/), the Regenstrief Institute, the LOINC licence: named on FHIR API conformance.
- [UMLS](https://www.nlm.nih.gov/research/umls/), the US National Library of Medicine, the UMLS licence: named on FHIR API conformance.
- [tx.fhir.org](https://tx.fhir.org/), HL7's FHIR terminology development server, no licence stated: named on FHIR API conformance.
- [NDJSON](https://github.com/ndjson/ndjson-spec), the ndjson-spec authors, no licence stated: named on FHIR API conformance.
- [ClinicalTrials.gov](https://clinicaltrials.gov/) and [its API](https://clinicaltrials.gov/api/oas/v2), the US National Library of Medicine, a US government service: cited on Clinical evidence review.
- [ISRCTN registry](https://www.isrctn.com/), BioMed Central (Springer Nature), its terms allow citing each record with attribution: named on Clinical evidence review.
- [WHO International Clinical Trials Registry Platform](https://www.who.int/clinical-trials-registry-platform), the World Health Organization, WHO's terms of use: named on Clinical evidence review.
- [Compliance with legal requirement to report clinical trial results on ClinicalTrials.gov](https://doi.org/10.1016/S0140-6736(19)33220-9) (2020), DeVito, Bacon and Goldacre, The Lancet, © Elsevier: cited on Clinical evidence review.
- [COMPare: a prospective cohort study correcting and monitoring 58 misreported trials in real time](https://doi.org/10.1186/s13063-019-3173-2) (2019), Goldacre, Drysdale, Dale et al., CC BY: cited on Clinical evidence review.

**Agriculture.**

- [The New Agronomists: Language Models are Experts in Crop Management](https://arxiv.org/abs/2403.19839) (2024), Wu, Lai, Chen et al., arXiv non-exclusive licence: a policy's water, nitrogen and yield in a crop simulator, on Irrigation and fertiliser planning.
- [Nitrogen management with reinforcement learning and crop growth models](https://doi.org/10.1017/eds.2023.28) (2023), Kallenberg, Overweg, van Bree et al. (CropGym), *Environmental Data Science*, CC BY 4.0: a crop model whose nitrogen loss ignored timing, and the cap on the agent's doses that it needed, on the same page.
- [gym-DSSAT](https://gitlab.inria.fr/rgautron/gym_dssat_pdi), Gautron and Padrón, BSD-3-Clause, and [DSSAT-CSM](https://github.com/DSSAT/dssat-csm-os), the DSSAT Foundation, BSD-3-Clause: the crop simulator, named on the same page.
- [Cherry Tomato Production in Intelligent Greenhouses](https://doi.org/10.3390/s20226430) (2020), Hemming, Zwart, Elings et al., *Sensors*, CC BY 4.0: the Autonomous Greenhouse Challenge's results, on Greenhouse climate control.
- [GL-Gym (GreenLight-Gym)](https://github.com/BartvLaatum/GreenLight-Gym2), van Laatum, van Henten, Boersma, AGPL-3.0: a greenhouse simulator, named on the same page.
- [Using machine learning for crop yield prediction in the past or the future](https://doi.org/10.3389/fpls.2023.1128388) (2023), Morales and Villalobos, *Frontiers in Plant Science*, CC BY 4.0: random splits against future years, on Crop yield forecasting.
- [CY-Bench](https://github.com/WUR-AI/AgML-CY-Bench), Kallenberg, Paudel, Baja et al. (AgML), EUPL-1.2, each data source under its own licence: a benchmark that leaves whole years out, on the same page.
- [FAO Irrigation and Drainage Paper 56: Crop evapotranspiration](https://www.fao.org/4/x0490e/x0490e00.htm) (1998), Allen, Pereira, Raes and Smith; FAO, © FAO: named on Irrigation and fertiliser planning.
- [APSIM](https://github.com/APSIMInitiative/ApsimX), APSIM Initiative, APSIM General Use Licence: named on Irrigation and fertiliser planning.
- [AquaCrop](https://www.fao.org/aquacrop/en/), FAO; source © KU Leuven, BSD-3-Clause: named on Irrigation and fertiliser planning.
- [PCSE](https://github.com/ajwdewit/pcse) (WOFOST, LINTUL-3), Allard de Wit, Wageningen Environmental Research, EUPL 1.1 or later: named on Irrigation and fertiliser planning.
- [GreenLight](https://github.com/davkat1/GreenLight), David Katzin and contributors, BSD-3-Clause-Clear: named on Greenhouse climate control.
- [GreenLight – An open source model for greenhouses with supplemental lighting](https://doi.org/10.1016/j.biosystemseng.2020.03.010) (2020), Katzin, van Mourik, Kempkes, van Henten, CC BY 4.0: cited on Greenhouse climate control.
- [JRC MARS Bulletin](https://joint-research-centre.ec.europa.eu/projects-and-activities/crop-monitoring-and-yield-forecasting_en), European Commission JRC, © EU, CC BY 4.0 reuse: named on Crop yield forecasting.
- [The Yield Forecasting Program of NASS](https://www.nass.usda.gov/Publications/Methodology_and_Data_Quality/Advanced_Topics/Yield%20Forecasting%20Program%20of%20NASS_2023.pdf) (2023), USDA NASS, US government work: cited on Crop yield forecasting.
- [Corn Nitrogen Rate Calculator](https://www.cornnratecalc.org/), soil fertility specialists of Corn Belt universities (Illinois, Indiana, Iowa, Michigan, Minnesota, Ohio, Wisconsin), no licence stated: the MRTN approach, cited on Agronomic trial evidence.
- [N-FACT](https://stories.cals.iastate.edu/2025/05/new-tool-helps-find-goldilocks-nitrogen-level), the Iowa Nitrogen Initiative at Iowa State University, no licence stated: named on Agronomic trial evidence.
- [SARE](https://www.sare.org/) and its [project reports](https://projects.sare.org/), Sustainable Agriculture Research and Education (USDA NIFA), © SARE: named on Agronomic trial evidence.
- [Cover Crop Economics: Opportunities to Improve Your Bottom Line in Row Crops](https://www.sare.org/resources/cover-crop-economics/) (2019), Myers, Weber and Tellatin (SARE Outreach), © SARE: cited on Agronomic trial evidence.
- [USDA Agricultural Research Service](https://www.ars.usda.gov/), USDA, US government work: named on Agronomic trial evidence.
- [Practical Farmers of Iowa](https://practicalfarmers.org/) and its report [Winter Cereal Rye Cover Crop Effect on Cash Crop Yield](https://practicalfarmers.org/resources/research-reports/winter-cereal-rye-cover-crop-effect-on-cash-crop-yield-4/) (2020), with Iowa Learning Farms, © Practical Farmers of Iowa: cited on Agronomic trial evidence.
- [Iowa Learning Farms](https://www.iowalearningfarms.org/), Iowa State University, © Iowa Learning Farms: named on Agronomic trial evidence.
- [Nebraska On-Farm Research Network](https://on-farm-research.unl.edu/), University of Nebraska–Lincoln, Nebraska Extension, no licence stated: cited on Agronomic trial evidence.
- [Iowa State University Research and Demonstration Farms Progress Reports](https://iastatedigitalpress.com/farmreports/), including [Enhancing Corn Yield in a Winter Cereal Rye Cover Crop System in Southeast Iowa](https://iastatedigitalpress.com/farmreports/article/id/790) (2017), Lundvall, Patel and Sawyer (Iowa State University Digital Press), all rights reserved: cited on Agronomic trial evidence.
- [Iowa Nutrient Reduction Strategy](https://www.nutrientstrategy.iastate.edu/), Iowa State University with Iowa's agriculture and natural resources departments, no licence stated: named on Agronomic trial evidence.
- [A critical review of the impacts of cover crops on nitrogen leaching, net greenhouse gas balance and crop productivity](https://doi.org/10.1111/gcb.14644) (2019), Abdalla, Hastings, Cheng et al., CC BY 4.0: cited on Agronomic trial evidence.
- [When do cover crops reduce nitrate leaching? A global meta-analysis](https://doi.org/10.1111/gcb.16269) (2022), Nouri, Lukas, Singh et al., CC BY 4.0: cited on Agronomic trial evidence.
- [A meta-analysis of hairy vetch as a previous cover crop for maize](https://doi.org/10.1016/j.heliyon.2023.e22621) (2023), Rodriguez, Vargas, Correndo et al., CC BY-NC-ND 4.0: cited on Agronomic trial evidence.

**Energy and buildings.**

- [The CityLearn Challenge 2022: Overview, Results, and Lessons Learned](https://proceedings.mlr.press/v220/nweye23a.html) (2023), Nweye, Nagy, Mohanty et al., PMLR, © the authors: a challenge scored on buildings the teams never saw, on Building energy control.
- [Large Language Models for HVAC Operations in Building Energy Systems: A Critical Review](https://arxiv.org/abs/2609.05314) (2026), Neubauer, Hong, Li et al., arXiv non-exclusive licence: where language models fit in building control, on the same page.
- [BOPTEST](https://github.com/ibpsa/project1-boptest), IBPSA Project 1, BSD-3-Clause (revised): building test cases, named on the same page.
- [ASHRAE Guideline 36, High-Performance Sequences of Operation for HVAC Systems](https://www.ashrae.org/news/ashraejournal/guideline-36-2021-what-s-new-and-why-it-s-important), ASHRAE, © ASHRAE, a paid standard: named on Building energy control.
- [Modelica Buildings Library](https://github.com/lbl-srg/modelica-buildings), Modelica Association, IBPSA, LBNL and contributors, BSD-3-Clause (modified): named on Building energy control, and on Building simulation validation.
- [Modelica Language Specification](https://github.com/modelica/ModelicaSpecification), Modelica Association, CC BY-SA 4.0: named on Building energy control.
- [EnergyPlus](https://github.com/NatLabRockies/EnergyPlus), US DOE; University of Illinois, LBNL, ORNL and contributors, BSD-3-like: named on Building energy control, and on Building simulation validation.
- [CityLearn](https://github.com/citylearn-project/CityLearn), the CityLearn project, MIT: named on Building energy control.
- [Improvements to Generator Interconnection Procedures and Agreements, Order No. 2023](https://www.federalregister.gov/documents/2023/09/06/2023-16628/improvements-to-generator-interconnection-procedures-and-agreements) (2023) and [Order No. 2023-A](https://www.federalregister.gov/documents/2024/04/16/2024-06563/improvements-to-generator-interconnection-procedures-and-agreements) (2024), the Federal Energy Regulatory Commission, US government work: cited on Interconnection and market rules.
- [govinfo](https://www.govinfo.gov/), the US Government Publishing Office, US government works: named on Interconnection and market rules.
- [FERC eLibrary](https://elibrary.ferc.gov/eLibrary/search), the Federal Energy Regulatory Commission, no licence stated: named on Interconnection and market rules.
- [Queued Up: 2026 Edition](https://eta-publications.lbl.gov/publications/queued-2026-edition-characteristics) (2026), Rand, Cheyette, Talley et al. (Lawrence Berkeley National Laboratory), its data CC BY 4.0: interconnection queue completion rates and durations, cited on Interconnection and market rules.
- The grid operators' interconnection pages: [CAISO](https://www.caiso.com/generation-transmission/generation/generator-interconnection), [ISO New England](https://www.iso-ne.com/system-planning/interconnection-service), [MISO](https://www.misoenergy.org/planning/resource-utilization/GI_Queue/) (with its queue data), [NYISO](https://www.nyiso.com/interconnections), [PJM](https://www.pjm.com/planning/service-requests) (© PJM), [SPP](https://www.spp.org/engineering/generator-interconnection/) and [ERCOT's Planning Guide](https://www.ercot.com/mktrules/guides/planning/current), each no licence stated unless marked: named on Interconnection and market rules.
- [CPUC Electric Rule 21](https://www.cpuc.ca.gov/Rule21), the California Public Utilities Commission, no licence stated: named on Interconnection and market rules.
- [New York Standardized Interconnection Requirements](https://dps.ny.gov/distributed-generation-information), the New York State Department of Public Service, no licence stated: named on Interconnection and market rules.
- [ANSI/ASHRAE Standard 140-2023, Method of Test for Evaluating Building Performance Simulation Software](https://www.ashrae.org/technical-resources/bookstore/ashrae-building-energy-simulation-and-performance-modeling-resources), ASHRAE, © ASHRAE, a paid standard, with its free [Addendum a](https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/140_2023_a_20250829.pdf) (2025), [Addendum b](https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/140_2023_b_20260424.pdf) (2026) and the [Standards Actions of 14 August 2026](https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20actions/sa-aug_14_2026.pdf): cited on Building simulation validation.
- [Addendum at to ANSI/ASHRAE/IES Standard 90.1-2022](https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/90_1_2022_at_20250311.pdf) (2025), ASHRAE and IES, © ASHRAE: cited on Building simulation validation.
- [BESTEST-GSR](https://github.com/NatLabRockies/BESTEST-GSR), the National Laboratory of the Rockies (Alliance for Energy Innovation), a BSD-style licence: named on Building simulation validation.
- [OpenStudio](https://github.com/NatLabRockies/OpenStudio), the National Laboratory of the Rockies (Alliance for Energy Innovation), a BSD-style licence: named on Building simulation validation.

**Operations and logistics.**

- [An In-depth Study of LLM Contributions to the Bin Packing Problem](https://arxiv.org/abs/2510.27353) (2025), Herrmann and Pallez, CC BY 4.0: heuristics that "are not robust to variations in the data distribution", on Cluster and job scheduling.
- [VRPAgent: LLM-Driven Discovery of Heuristic Operators for Vehicle Routing Problems](https://arxiv.org/abs/2510.07073) (2025), Hottung, Berto, Hua et al., arXiv non-exclusive licence: moves that beat a leading routing solver, on Vehicle routing.
- [PyVRP](https://github.com/PyVRP/PyVRP), Wouda, Lan, Kool, MIT: a routing solver, named on the same page.
- [kube-scheduler-simulator](https://github.com/kubernetes-sigs/kube-scheduler-simulator), Kubernetes SIGs, Apache-2.0: named on Cluster and job scheduling.
- [Google cluster-usage traces](https://github.com/google/cluster-data), Google, CC BY 4.0: named on Cluster and job scheduling.
- [Benchmarks for basic scheduling problems](https://doi.org/10.1016/0377-2217(93)90182-M) (1993), É. Taillard, EJOR, © Elsevier: named on Cluster and job scheduling.
- [A heuristic algorithm for the m-machine, n-job flow-shop sequencing problem](https://doi.org/10.1016/0305-0483(83)90088-9) (1983), Nawaz, Enscore, Ham, Omega, © Elsevier: named on Cluster and job scheduling.
- [A simple and effective iterated greedy algorithm for the permutation flowshop scheduling problem](https://doi.org/10.1016/j.ejor.2005.12.009) (2007), Ruiz, Stützle, EJOR, © Elsevier: named on Cluster and job scheduling.
- [OR-Tools](https://github.com/google/or-tools), Google, Apache-2.0: named on Vehicle routing, and its CP-SAT solver on Staff rostering.
- [HGS-CVRP](https://github.com/vidalt/HGS-CVRP), Thibaut Vidal, MIT: named on Vehicle routing.
- [CVRPLIB](https://galgos.inf.puc-rio.br/cvrplib/), PUC-Rio Galgos group, terms of use, no licence stated: named on Vehicle routing.
- [New benchmark instances for the Capacitated Vehicle Routing Problem](https://doi.org/10.1016/j.ejor.2016.08.012) (2017), Uchoa, Pecin, Pessoa et al., EJOR, © Elsevier: named on Vehicle routing.
- [UFLPA Entity List](https://www.dhs.gov/uflpa-entity-list), DHS for the Forced Labor Enforcement Task Force, US government work: named on Supply chain mapping.
- [Uyghur Forced Labor Prevention Act, Public Law 117-78](https://www.govinfo.gov/content/pkg/PLAW-117publ78/html/PLAW-117publ78.htm), the US Congress, public domain: named on Supply chain mapping.
- [UFLPA Strategy](https://www.dhs.gov/uflpa-strategy) and its updates, the Forced Labor Enforcement Task Force (DHS), US government work: named on Supply chain mapping.
- U.S. Customs and Border Protection's [UFLPA page](https://www.cbp.gov/trade/forced-labor/UFLPA), [FAQs: UFLPA Enforcement](https://www.cbp.gov/trade/forced-labor/faqs-uflpa-enforcement), [Forced Labor Enforcement Operational Guidance for Importers](https://www.cbp.gov/document/guidance/cbp-forced-labor-enforcement-operational-guidance-importers) and [Withhold Release Orders and Findings](https://www.cbp.gov/trade/forced-labor/withhold-release-orders-and-findings), public domain unless marked: cited on Supply chain mapping.
- [Federal Register](https://www.federalregister.gov/) and [its API](https://www.federalregister.gov/developers/documentation/api/v1), the Office of the Federal Register and the GPO, US government work: named on Supply chain mapping.
- [Modern slavery statement registry](https://modern-slavery-statement-registry.service.gov.uk/), the UK Home Office, no licence stated: cited on Supply chain mapping.
- [Conflict Minerals Reporting Template](https://www.responsiblemineralsinitiative.org/reporting-templates/cmrt/) and the [Responsible Minerals Assurance Process](https://www.responsiblemineralsinitiative.org/responsible-minerals-assurance-process/), the Responsible Minerals Initiative, RMI's terms: named on Supply chain mapping.
- [Form SD and EDGAR](https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/conflict-minerals-disclosure), the U.S. Securities and Exchange Commission, public information: named on Supply chain mapping.
- The EU's [Forced Labour Regulation (EU) 2024/3015](https://single-market-economy.ec.europa.eu/single-market/goods/forced-labour-regulation/what-forced-labour-regulation-and-how-does-it-work_en), [Conflict Minerals Regulation (EU) 2017/821](https://policy.trade.ec.europa.eu/development-and-sustainability/conflict-minerals-regulation_en) and [Corporate Sustainability Due Diligence Directive (EU) 2024/1760](https://commission.europa.eu/topics/business-and-industry/company-law-and-corporate-governance/corporate-sustainability-due-diligence_en), the European Union, the Commission's pages CC BY 4.0: named on Supply chain mapping.
- [Working Time Directive 2003/88/EC](https://employment-social-affairs.ec.europa.eu/policies-and-activities/rights-work/labour-law/working-conditions/working-time-directive_en), the European Commission's page, CC BY 4.0: cited on Staff rostering.
- [INRC-II: The Second International Nurse Rostering Competition](https://mobiz.vives.be/inrc2/), Dang, De Causmaecker, Ceschia, Schaerf and Haspeslagh, no licence stated, with [its rules](https://arxiv.org/abs/1501.04177) (2015, arXiv non-exclusive licence) and [its report](https://link.springer.com/article/10.1007/s10479-018-2816-0) (2019, © Springer Nature): cited on Staff rostering.
- [Shift Scheduling Benchmark Data Sets](https://www.schedulingbenchmarks.org/), from Burke and Curtois's and Qu and Curtois's work, no licence stated: instances and best known solutions, cited on Staff rostering.
- [Timefold Solver](https://github.com/TimefoldAI/timefold-solver), Timefold, Apache-2.0: named on Staff rostering.
- [HiGHS](https://github.com/ERGO-Code/HiGHS), the HiGHS team, MIT: named on Staff rostering.

**Robotics.**

- [Eureka: Human-Level Reward Design via Coding Large Language Models](https://arxiv.org/abs/2310.12931) (2023), Ma, Liang, Wang et al., arXiv non-exclusive licence: reward functions written by a language model and scored apart, on Robot reward design.
- [Specification gaming: the flip side of AI ingenuity](https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/) (2020), Krakovna, Uesato, Mikulik et al. (DeepMind), © Google DeepMind: examples of agents gaming their rewards, on the same page.
- [MuJoCo Playground](https://github.com/google-deepmind/mujoco_playground), Zakka, Tabanpour, Liao et al. (Google DeepMind), Apache-2.0: a GPU robot simulator, whose PandaPickCube training settings and Go1 reward terms are described on the same page.
- [Isaac Lab](https://github.com/isaac-sim/IsaacLab), The Isaac Lab Project Developers, BSD-3-Clause: named on Robot reward design.
- [Proximal Policy Optimization Algorithms](https://arxiv.org/abs/1707.06347) (2017), Schulman, Wolski, Dhariwal, Radford, Klimov, arXiv non-exclusive licence: named on Robot reward design.
- [ROS 1](https://github.com/ros/ros_comm) (Noetic, with catkin, roscpp, rospy and rostest), Open Robotics and contributors, BSD-3-Clause: named on ROS 1 to ROS 2 migration.
- [ROS 2](https://github.com/ros2/ros2) (Jazzy, Lyrical and Humble, with ament, rclcpp and rclpy), Open Robotics and contributors, Apache-2.0 for the core, each package under its own licence: named on ROS 1 to ROS 2 migration.
- [ROS 2 Documentation](https://docs.ros.org/en/jazzy/), with its migration guides and its launch_testing tutorial, Open Robotics, CC BY 4.0: cited on ROS 1 to ROS 2 migration.
- [Upcoming ROS 1 End of Life](https://www.ros.org/blog/noetic-eol/), Open Robotics, no licence stated: cited on ROS 1 to ROS 2 migration.
- [REP 2000](https://reps.openrobotics.org/rep-2000/), the ROS 2 platform tiers, the REP authors, public domain: named on ROS 1 to ROS 2 migration.
- [ros1_bridge](https://github.com/ros2/ros1_bridge), the ROS 2 project, Apache-2.0: cited on ROS 1 to ROS 2 migration.
- [colcon](https://github.com/colcon/colcon-core), the colcon contributors, Apache-2.0: named on ROS 1 to ROS 2 migration.
- [launch_testing](https://github.com/ros2/launch), the ROS 2 project, Apache-2.0: named on ROS 1 to ROS 2 migration.
- [rosbag2](https://github.com/ros2/rosbag2), the ROS 2 project, Apache-2.0: named on ROS 1 to ROS 2 migration.
- [Gazebo](https://github.com/gazebosim/gz-sim) (Harmonic and Jetty), Open Robotics, Apache-2.0: named on ROS 1 to ROS 2 migration.
- [Gazebo Classic](https://github.com/gazebosim/gazebo-classic), the Open Source Robotics Foundation, Apache-2.0, and its [end-of-life notice](https://discourse.openrobotics.org/t/gazebo-classic-11-has-reached-end-of-life-x-post-gazebo-sim-community/41852) (2025): cited on ROS 1 to ROS 2 migration.
- [SDFormat](https://github.com/gazebosim/sdformat), Open Robotics, Apache-2.0: named on ROS 1 to ROS 2 migration.
- [ros_gz](https://github.com/gazebosim/ros_gz), Open Robotics, Apache-2.0: named on ROS 1 to ROS 2 migration.
- [Nav2](https://github.com/ros-navigation/navigation2), with its DWB, Regulated Pure Pursuit and MPPI controllers, the ros-navigation project, Apache-2.0, LGPL-2.1-or-later and BSD-3-Clause by package: named on ROS 1 to ROS 2 migration.
- [The ROS 1 navigation stack](https://github.com/ros-planning/navigation) (move_base and AMCL), ros-planning, BSD and LGPL by package: named on ROS 1 to ROS 2 migration.
- [MoveIt](https://github.com/moveit/moveit) and [MoveIt 2](https://github.com/moveit/moveit2), the MoveIt maintainers, BSD-3-Clause: named on ROS 1 to ROS 2 migration.

**Finance.**

- [R&D-Agent-Quant: A Multi-Agent Framework for Data-Centric Factors and Model Joint Optimization](https://arxiv.org/abs/2505.15155) (2025), Li, Yang, Yang et al., CC BY-NC-SA 4.0: an agent's returns on a period it was not tuned on, on Trading strategy research.
- [Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance](https://doi.org/10.1090/noti1105) (2014), Bailey, Borwein, López de Prado and Zhu, *Notices of the AMS*, © the American Mathematical Society: how many configurations a backtest can bear, on the same page.
- [QuantLib](https://github.com/lballabio/QuantLib), the QuantLib contributors, a BSD-style licence: a pricing library, named on Pricing and risk engine performance, and its Heston stochastic local volatility models on Pricing model validation.
- [Qlib](https://github.com/microsoft/qlib), Microsoft, MIT: named on Trading strategy research.
- [The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality](https://papers.ssrn.com/abstract=2460551) (2014), Bailey and López de Prado, Journal of Portfolio Management, © the authors: named on Trading strategy research.
- [The Probability of Backtest Overfitting](https://doi.org/10.21314/JCF.2016.322) (2017), Bailey, Borwein, López de Prado and Zhu, Journal of Computational Finance, © Infopro Digital: named on Trading strategy research.
- [Open Source Risk Engine](https://github.com/OpenSourceRisk/Engine), Quaternion Risk Management and Acadia, Modified BSD: named on Pricing and risk engine performance.
- [STAC-A2](https://docs.stacresearch.com/a2), Strategic Technology Analysis Center (STAC), proprietary, results for subscribers: named on Pricing and risk engine performance.
- [Smoking Adjoints: fast evaluation of Greeks in Monte Carlo calculations](https://ora.ox.ac.uk/objects/uuid:f536b1a8-c988-4bda-9c5f-a322652139fd) (2005), Giles and Glasserman, Oxford University Research Archive terms: named on Pricing and risk engine performance.
- [Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) and [EDGAR Application Programming Interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) (data.sec.gov: company concepts, company facts and frames), the U.S. Securities and Exchange Commission, US government work: the rules for automated access and the XBRL data, cited on Research from public filings.
- [Regulation S-K, Item 1406](https://www.ecfr.gov/current/title-17/chapter-II/part-229/subpart-229.1400/section-229.1406), with [govinfo's 2025 edition](https://www.govinfo.gov/content/pkg/CFR-2025-title17-vol3/xml/CFR-2025-title17-vol3-sec229-1406.xml), the SEC, US government work: the disclosure of uninsured deposits, cited on Research from public filings.
- [SEC staff letter to Stock Yards Bancorp](https://www.sec.gov/Archives/edgar/data/835324/000000000024013437/filename2.txt) (2024), the SEC's Division of Corporation Finance, US government work: cited on Research from public filings.
- [FDIC BankFind Suite API](https://api.fdic.gov/banks/docs/), the Federal Deposit Insurance Corporation, no licence stated: Call Report figures by bank, named on Research from public filings.
- [FinanceBench: A New Benchmark for Financial Question Answering](https://arxiv.org/abs/2311.11944) (2023), Islam, Kannappan, Kiela, Qian, Scherrer and Vidgen, CC BY-NC-ND 4.0: how often models answered questions on filings wrongly, cited on Research from public filings.
- [SR 26-2: Revised Guidance on Model Risk Management](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm) (2026), with [its attachment](https://www.federalreserve.gov/supervisionreg/srletters/SR2602a1.pdf), the Board of Governors of the Federal Reserve System, the OCC and the FDIC, US government work: the validation a model needs, which replaced SR 11-7, cited on Pricing model validation.
- [A Closed-Form Solution for Options with Stochastic Volatility with Applications to Bond and Currency Options](https://doi.org/10.1093/rfs/6.2.327) (1993), Steven L. Heston, © Oxford University Press: the Heston model, named on Pricing model validation.

## The maintainers' own public projects

- [tensorless](https://github.com/iammrduncan/tensorless) (Apache-2.0), at [tensorless.dev](https://tensorless.dev): the partner of the first study. It made the PN weight format and Qwen3.8-27B-PN3, and ships the engine that the study's campaigns tuned; the study cites its published receipts and pages, and the study and the site's own pages show its logo. Its home page was also studied for the site's own pages, above.
- [fxbot](https://github.com/iammrduncan/fxbot) (Apache-2.0, as fxbot.sh states), at [fxbot.sh](https://fxbot.sh): its home page, studied for the site's own pages, above.
- [Magnesium](https://github.com/iammrduncan/magnesium) (MIT): the dashboard's design, above, and its notes on Claude and Codex sign-in, read for subscriptions.
- [skills](https://github.com/iammrduncan/skills) (MIT): the maintainers' skills for coding agents, among them the ones for Simplified Technical English and for writing documentation.

## What this repository holds from others

Thermite's repository holds no code, text or data copied from another project, except:

- the licence texts it ships with programs in its images: `containers/control/kubectl/LICENSE` (Apache-2.0, from Kubernetes), `containers/harness/opencode/LICENSE` (MIT, © 2025 opencode), and `containers/harness/codex/LICENSE` and `NOTICE` (Apache-2.0, © 2025 OpenAI, with the Ratatui notice above);
- the dashboard's colour tokens, from T3 Code through Magnesium, above;
- tensorless's logo, Bitsy, on the first study's page and on the site's own pages: `docs/_site/src/assets/partners/tensorless.svg` (Apache-2.0, from the maintainers' own tensorless, above);
- the statistics tests' reference values, numbers computed with SciPy (`tests/helpers/data/stats-reference.json`).

The maintainers' own tooling in `.agents/` carries its own notices, such as [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT).
