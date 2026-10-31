import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, UPLOAD_TIMEOUT_MS } from "../common/api/call.ts";
import { controlClient } from "../common/api/control.ts";
import { log } from "../common/env.ts";
import { git } from "../common/git.ts";
import { CHAMPION_PATCH, CHAMPION_PATCH_MAX } from "../core/api/control/rigs.ts";

/**
 * Champions' patches go to control, so an operator can download a run's result from the
 * dashboard. The harness exports each published champion as champions/<run>/<seq>.patch; the
 * supervisor commits it to its results repository and uploads it from there. Control keeps it
 * only if its sha256 is the one in the rig's signed champion_published event.
 */
export interface ChampionUpload {
  run: string;
  seq: number;
  path: string;
}

/** The champion patches in exports just written, from their manifests. */
export function championsIn(outboxDir: string, exports: string[]): ChampionUpload[] {
  const out: ChampionUpload[] = [];
  for (const name of exports) {
    const manifest = join(outboxDir, name, "manifest.json");
    if (!existsSync(manifest)) continue;
    const files = (JSON.parse(readFileSync(manifest, "utf8")) as { files?: object }).files ?? {};
    for (const path of Object.keys(files)) {
      const m = /^champions\/([^/]+)\/(\d+)\.patch$/.exec(path);
      if (m) out.push({ run: m[1] as string, seq: Number(m[2]), path });
    }
  }
  return out;
}

/**
 * Uploads queued champion patches; returns the ones to try again: control has not received
 * the rig's champion_published event yet, or the upload failed.
 */
export async function uploadChampions(
  cfg: {
    rig: string;
    controlUrl: string;
    controlToken: string;
    /** The supervisor's results repository, where the exporter committed the patches. */
    resultsRepo: string;
    fetchImpl?: typeof fetch | undefined;
  },
  queue: ChampionUpload[],
): Promise<ChampionUpload[]> {
  const control = controlClient({
    url: cfg.controlUrl,
    token: cfg.controlToken,
    rig: cfg.rig,
    fetchImpl: cfg.fetchImpl,
  });
  const again: ChampionUpload[] = [];
  for (const c of queue) {
    try {
      const patch = await git(
        ["-C", cfg.resultsRepo, "show", `refs/heads/thermite/${cfg.rig}/attempts:${c.path}`],
        { maxBytes: CHAMPION_PATCH_MAX },
      );
      await control.call(CHAMPION_PATCH, {
        params: { run: c.run, seq: c.seq },
        bytes: new Uint8Array(patch),
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      log("supervisor", "champion patch uploaded", { run: c.run, seq: c.seq });
    } catch (err) {
      const answered = err instanceof ApiError && err.status !== undefined;
      // 422: not the patch the rig published, so never sent again. Any other answer: again later.
      if (answered && err.code === "unprocessable") {
        const why = { run: c.run, seq: c.seq, error: err.text.slice(0, 300) };
        log("supervisor", "control refused a champion patch", why, "warn");
        continue;
      }
      if (!answered)
        log(
          "supervisor",
          "champion upload error",
          { run: c.run, seq: c.seq, error: String(err) },
          "error",
        );
      again.push(c);
    }
  }
  return again;
}
