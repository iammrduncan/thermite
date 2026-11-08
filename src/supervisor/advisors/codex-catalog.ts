import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexBin, codexExe } from "../../agents/programs/index.ts";

/**
 * A Codex teacher's model catalog (goal 232). Codex 0.162.1 drives its gpt-6 models over Responses
 * Lite, in Code Mode Only: it sends them no hosted tools, and its own search (`web.run`) calls an
 * endpoint that a ChatGPT sign-in's route answers 401 Unauthorized. Given its own catalog entry for
 * the model with Responses Lite and Code Mode Only off, Codex drives it over the full Responses API
 * and sends the provider's hosted web search, which that route takes, with the model's tools on
 * its own list. The entry is Codex's own, from its bundled catalog (`codex debug models
 * --bundled`, read once, with no network), so every other field is as Codex would use it.
 */

type CatalogEntry = { slug?: unknown; use_responses_lite?: unknown; [k: string]: unknown };

/** The bundled catalog's models, read once for each binary; [] when it can't be read. */
const read = new Map<string, CatalogEntry[]>();

function bundledModels(): CatalogEntry[] {
  const bin = codexExe() ?? codexBin();
  const known = read.get(bin);
  if (known) return known;
  let models: CatalogEntry[] = [];
  const home = mkdtempSync(join(tmpdir(), "thermite-codex-catalog-"));
  try {
    const out = execFileSync(bin, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(out) as { models?: unknown };
    if (Array.isArray(parsed.models)) models = parsed.models as CatalogEntry[];
  } catch {
    // No Codex, or one that can't print its catalog: the teacher keeps Codex's own choice.
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  read.set(bin, models);
  return models;
}

/**
 * The catalog a Codex teacher's configuration names (`model_catalog_json`), as JSON: its model's
 * own entry with `use_responses_lite` false and no `tool_mode`. Undefined for a model Codex does
 * not drive over Responses Lite, or one its bundled catalog does not hold: its hosted search
 * needs no change.
 */
export function codexTeacherCatalog(model: string): string | undefined {
  const entry = bundledModels().find((m) => m.slug === model);
  if (entry?.use_responses_lite !== true) return undefined;
  const { tool_mode: _toolMode, ...rest } = entry;
  return `${JSON.stringify({ models: [{ ...rest, use_responses_lite: false }] })}\n`;
}
