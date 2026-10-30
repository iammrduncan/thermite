import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The images Thermite pins by digest and does not build itself: its images' bases (Node.js and
 * CUDA), the message bus's server (NATS) and the registry the release workflow runs in a job.
 * Each pin is `<image>:<tag>@sha256:<digest>`, written where a file needs it: a Containerfile's
 * ARG or COPY, a compose file, a workflow, a script or the command line's code. These functions
 * find every pin in the places pins are kept, hold every copy of one image to one tag and one
 * digest, and ask an image's registry which digest its tag has now, so that a maintainer moves a
 * pin whose tag was built again, every copy at once (scripts/release/pins.ts).
 */

/** Where pins are kept, from the repository's root: a folder is read whole. */
export const PIN_PLACES = [".github/workflows", "compose.yaml", "containers", "scripts", "src"];

/** A file larger than this is not read for pins: none of the places holds one that large. */
const FILE_MAX_BYTES = 1024 * 1024;

/** How long one call to a registry may take: then the image is listed as not checked, with why. */
export const REGISTRY_TIMEOUT_MS = 30_000;

/** One pin, where it is written. */
export interface Pin {
  file: string;
  line: number;
  /** The image's name, its registry's host first when it names one. */
  image: string;
  tag: string;
  digest: string;
  /** The whole pin, as the file writes it. */
  ref: string;
}

const PIN =
  /\b((?:[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@(sha256:[0-9a-f]{64})\b/g;

/** Every pin in these files' texts, in their order. */
export function findPins(files: readonly { path: string; text: string }[]): Pin[] {
  const out: Pin[] = [];
  for (const f of files)
    f.text.split("\n").forEach((text, i) => {
      for (const m of text.matchAll(PIN))
        out.push({
          file: f.path,
          line: i + 1,
          image: m[1] as string,
          tag: m[2] as string,
          digest: m[3] as string,
          ref: m[0],
        });
    });
  return out;
}

/** The files of PIN_PLACES under `root`, each with its path from the root and its text. */
export function pinnedFiles(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const visit = (path: string) => {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort())
        if (name !== "node_modules") visit(join(path, name));
    } else if (st.isFile() && st.size <= FILE_MAX_BYTES)
      out.push({ path: relative(root, path), text: readFileSync(path, "utf8") });
  };
  for (const place of PIN_PLACES) visit(join(root, place));
  return out;
}

/**
 * Each image's tag the pins name, `<image>:<tag>`, with its copies, in the order first written.
 * One image may have two tags on purpose (the CUDA 12 and CUDA 13 bases).
 */
export function pinsByTag(pins: readonly Pin[]): Map<string, Pin[]> {
  const by = new Map<string, Pin[]>();
  for (const p of pins) {
    const key = `${p.image}:${p.tag}`;
    by.set(key, [...(by.get(key) ?? []), p]);
  }
  return by;
}

/**
 * What is wrong with the pins, in words: one image's tag pinned at more than one digest, so that
 * one copy was moved and another was not.
 */
export function pinProblems(pins: readonly Pin[]): string[] {
  const out: string[] = [];
  for (const [tag, copies] of pinsByTag(pins)) {
    const digests = new Set(copies.map((p) => p.digest));
    if (digests.size > 1)
      out.push(
        `${tag} is pinned at ${digests.size} digests: ${copies.map((p) => `${p.file}:${p.line} has ${p.digest.slice(0, 19)}…`).join("; ")}`,
      );
  }
  return out;
}

/** An image's registry and its repository there: Docker Hub's when the name gives no host. */
export function registryOf(image: string): { host: string; repository: string } {
  const [first = "", ...rest] = image.split("/");
  const named = rest.length > 0 && (first.includes(".") || first.includes(":"));
  const host = named ? first : "docker.io";
  const path = named ? rest.join("/") : image;
  return host === "docker.io"
    ? { host: "registry-1.docker.io", repository: path.includes("/") ? path : `library/${path}` }
    : { host, repository: path };
}

/** The manifests a tag may name: an index of platforms, or one image's. */
const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** A registry's answer: its status, its headers and its text. */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The digest an image's tag has now at its registry, asked with no sign-in: the registry's
 * manifest for the tag, and a pull token from the address its first answer names when it asks for
 * one. Throws, in words, when the registry gives no digest.
 */
export async function tagDigest(
  image: string,
  tag: string,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const { host, repository } = registryOf(image);
  const url = `https://${host}/v2/${repository}/manifests/${tag}`;
  const ask = (auth?: string) =>
    fetchImpl(url, {
      method: "HEAD",
      headers: { accept: MANIFESTS, ...(auth ? { authorization: auth } : {}) },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  let r = await ask();
  if (r.status === 401) r = await ask(`Bearer ${await pullToken(r, fetchImpl)}`);
  const digest = r.headers.get("docker-content-digest");
  if (!r.ok || !digest || !/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error(`${host} gave no digest for ${image}:${tag} (HTTP ${r.status})`);
  return digest;
}

/** A pull token from the address a registry's 401 names in its WWW-Authenticate header. */
async function pullToken(r: Response, fetchImpl: Fetch): Promise<string> {
  const challenge = r.headers.get("www-authenticate") ?? "";
  const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1];
  const realm = field("realm");
  if (!challenge.startsWith("Bearer ") || !realm?.startsWith("https://"))
    throw new Error(`the registry asks for a sign-in this check does not make: ${challenge}`);
  const at = new URL(realm);
  for (const name of ["service", "scope"]) {
    const value = field(name);
    if (value) at.searchParams.set(name, value);
  }
  const t = await fetchImpl(at.toString(), { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  const body = (await t.json().catch(() => ({}))) as { token?: unknown; access_token?: unknown };
  const token = body.token ?? body.access_token;
  if (!t.ok || typeof token !== "string")
    throw new Error(`no pull token from ${at.host} (HTTP ${t.status})`);
  return token;
}
