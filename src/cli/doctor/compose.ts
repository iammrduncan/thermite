import { ENGINE_LABEL, type EngineName } from "../machine.ts";
import type { Finding, Probes } from "./index.ts";

/**
 * The doctor's compose check: which compose program works with each engine that answers.
 * Compose v1, the old docker-compose 1.x, doesn't count: it stops at the top-level `name:` of
 * Thermite's compose files. `podman compose` hands its work to docker-compose first when it is
 * installed, so a v1 there breaks every `podman compose` command, even with podman-compose too.
 */

const V1 = "That is Compose v1. It can't read Thermite's compose file.";
const REMOVE_V1 = "Remove docker-compose 1.x, for example with sudo apt remove docker-compose.";
const PODMAN_TOOLS =
  "podman-compose, for example with pipx install podman-compose, or Docker Compose 2 or later.";
const PODMAN_ORDER = "podman compose uses docker-compose first when it is installed.";

/** The line that docker-compose 1.x prints first: `docker-compose version 1.29.2, build …`. */
const V1_LINE = /docker-compose version (1\.[\d.]+)/i;
/** The program that podman names on stderr: `Executing external compose provider "…"`. */
const PROVIDER = /compose provider "([^"]+)"/;

interface Outcome {
  /** What works, each as a sentence. */
  works: string[];
  /** A docker-compose 1.x in the way: what was found, and what to do. */
  v1?: { said: string; fix: string };
}

async function dockerCompose(p: Probes): Promise<Outcome> {
  const plugin = await p.run("docker", ["compose", "version", "--short"]);
  if (plugin.code === 0) return { works: [`docker compose ${plugin.stdout.trim()} works.`] };
  const standalone = await p.run("docker-compose", ["version", "--short"]);
  if (standalone.code !== 0) return { works: [] };
  const version = standalone.stdout.trim();
  if (version.startsWith("1."))
    return {
      works: [],
      v1: {
        said: `docker-compose ${version} is installed. ${V1}`,
        fix: `${REMOVE_V1} Then install the Docker Compose plugin. Docker Desktop has it.`,
      },
    };
  return {
    works: [
      `docker-compose ${version} works. Write docker-compose where the docs say docker compose.`,
    ],
  };
}

async function podmanCompose(p: Probes): Promise<Outcome> {
  // podman compose hands the work to a compose program; it fails when there is none.
  const handed = await p.run("podman", ["compose", "version"]);
  const v1 = handed.code === 0 ? V1_LINE.exec(handed.stdout) : null;
  if (handed.code === 0 && !v1) return { works: ["podman compose works."] };
  const pc = await p.run("podman-compose", ["version"]);
  const works =
    pc.code === 0
      ? ["podman-compose works. Write podman-compose where the docs say docker compose."]
      : [];
  if (!v1) return { works };
  const where = PROVIDER.exec(handed.stderr)?.[1];
  const to = where ? `${where}, which is docker-compose ${v1[1]}` : `docker-compose ${v1[1]}`;
  return {
    works,
    v1: {
      said: `podman compose hands its work to ${to}. ${V1}`,
      fix: works.length
        ? `${REMOVE_V1} Then podman compose uses podman-compose. ${PODMAN_ORDER}`
        : `${REMOVE_V1} Then install ${PODMAN_TOOLS} ${PODMAN_ORDER}`,
    },
  };
}

const installFix = (engine: EngineName) =>
  engine === "docker"
    ? "Install the Docker Compose plugin. Docker Desktop has it."
    : `Install ${PODMAN_TOOLS} podman compose hands its work to one of them.`;

export async function composeFinding(
  p: Probes,
  engines: readonly { name: EngineName; answers: boolean }[],
): Promise<Finding> {
  const title = "Compose tool";
  const answering = engines.filter((e) => e.answers);
  if (!answering.length)
    return {
      check: "compose",
      title,
      status: "skip",
      said: "No container engine answers, so the compose tool was not checked.",
    };
  const outcomes: (Outcome & { engine: EngineName })[] = [];
  for (const e of answering) {
    const outcome = e.name === "docker" ? await dockerCompose(p) : await podmanCompose(p);
    outcomes.push({ engine: e.name, ...outcome });
  }
  const works = outcomes.flatMap((o) => o.works);
  const v1 = outcomes.flatMap((o) => (o.v1 ? [o.v1] : []));
  if (works.length && !v1.length)
    return { check: "compose", title, status: "ok", said: works.join(" ") };
  if (works.length)
    return {
      check: "compose",
      title,
      status: "warn",
      said: [...works, ...v1.map((o) => o.said)].join(" "),
      fix: v1.map((o) => o.fix).join(" "),
    };
  const engineNames = outcomes.map((o) => ENGINE_LABEL[o.engine]).join(" or ");
  return {
    check: "compose",
    title,
    status: "fail",
    said: [`No compose tool works with ${engineNames}.`, ...v1.map((o) => o.said)].join(" "),
    fix: outcomes.map((o) => o.v1?.fix ?? installFix(o.engine)).join(" "),
  };
}
