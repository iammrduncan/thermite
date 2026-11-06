import { rmSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import type { ModelFetch, ModelFetchState, ModelPoll } from "../../core/api/harness/runs.ts";
import { downloadModel, ModelDownloads } from "../model-download.ts";

/**
 * A runner's fetches of a run's model files, in turns (goal 213). Each file comes from its source
 * into the inbox, one after another, lands only with its SHA-256, is taken in by the harness,
 * which checks it again, and then leaves the inbox: a model of about 95 GiB is kept once. A turn
 * begins the files not under way and answers at once with every file's state, so the core asks as
 * often as it likes and waits as long as bytes come. A file that failed is tried again by the next
 * `start`, from what its download left, with the last failure kept until it lands.
 */

interface Entry {
  model: ModelFetch;
  state: ModelFetchState["state"];
  /** Once it landed: its bytes, which the downloads' list may have dropped since. */
  bytes?: number;
  total?: number | null;
  error?: string;
}

interface FetchOptions {
  inboxDir: string;
  /** The harness takes one file in from the inbox. */
  take: (file: { path: string; sha256: string }) => Promise<unknown>;
  hfToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class ModelFetches {
  private readonly files = new Map<string, Entry>();
  private chain: Promise<void> = Promise.resolve();
  private readonly downloads = new ModelDownloads();
  private readonly o: FetchOptions;

  constructor(o: FetchOptions) {
    this.o = o;
  }

  /**
   * One turn: `start` begins every file not under way and tries again one that failed; `status`
   * begins only a file it has never heard of (its supervisor started again since). Every file's
   * state, at once.
   */
  turn(models: ModelFetch[], poll: ModelPoll): ModelFetchState[] {
    for (const m of models) {
      const e = this.files.get(m.sha256);
      if (e && !(poll === "start" && e.state === "failed")) continue;
      const next: Entry = { model: m, state: "queued", ...(e?.error ? { error: e.error } : {}) };
      this.files.set(m.sha256, next);
      this.chain = this.chain.then(() => this.fetch(next));
    }
    return models.map((m) => this.stateOf(m));
  }

  private async fetch(e: Entry): Promise<void> {
    const m = e.model;
    const target = join(this.o.inboxDir, m.path);
    e.state = "fetching";
    try {
      await downloadModel({
        url: m.url,
        sha256: m.sha256,
        target,
        path: m.path,
        name: m.name,
        hfToken: this.o.hfToken,
        downloads: this.downloads,
        fetchImpl: this.o.fetchImpl,
      });
      await this.o.take({ path: m.path, sha256: m.sha256 });
      const p = this.progressOf(m.path);
      e.bytes = p?.bytes ?? 0;
      e.total = p?.total ?? e.bytes;
      e.state = "done";
      delete e.error;
      // The harness keeps its own copy: the inbox's would hold the model twice.
      rmSync(target, { force: true });
    } catch (err) {
      e.state = "failed";
      e.error = errorText(err).slice(0, 4000);
    }
  }

  private progressOf(path: string) {
    return this.downloads.list().find((p) => p.path === path);
  }

  private stateOf(m: ModelFetch): ModelFetchState {
    const e = this.files.get(m.sha256) as Entry;
    const p = this.progressOf(m.path);
    return {
      sha256: m.sha256,
      state: e.state,
      bytes: e.bytes ?? p?.bytes ?? 0,
      total: e.total ?? p?.total ?? null,
      ...(e.error !== undefined ? { error: e.error } : {}),
    };
  }
}
