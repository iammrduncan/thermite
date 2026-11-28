# Thermite v1 — Knowledge Architecture Research (Goal 0)

**Status:** Goal 0 research spike (2026-11-28). Read-only investigation; no production code changed.  
**Scope:** Diagnose `v0.2` Knowledge Base (KB) failure modes from source, compare `v1` architectures against `fxbot` and current PostgreSQL 18 tooling, define the thin-core vs. plugin boundary, and specify targets plus a pre-build benchmark plan.

---

## 1. TL;DR Recommendation

**Do not port `v0.2`'s 11,580-LOC SQLite word-index KB.** Build a **two-layer PostgreSQL 18 Knowledge stack** following `v1`'s thin-core / plugin rule:

1. **Core (~900–1,100 LOC, zero extra services):** Normalized PostgreSQL 18 storage (`kb_collections`, `kb_items`, `kb_versions`, `kb_chunks`, `kb_links`, `kb_grants`) with **heading-aware parent-child chunking**, dual-config native FTS (`simple` for code/identifiers + `english` for prose via weighted `tsvector` GIN) + `pg_trgm` trigram index for exact/partial symbol lookup, **O(1) empty-scope short-circuiting**, pooled async PostgreSQL I/O (`max >= 8`, driver-neutral pending the `postgres.js` vs. `pg` call in `./sansio-nats-contract.md`), and pure Sans-I/O query planning + RRF fusion. Since `v1` agents run in Control (no rigs), the rig-side per-run SQLite mirror (`src/harness/research/search/`) disappears completely.
2. **Default first-party plugin `knowledge-semantic` (~450–650 LOC, `fxbot`-aligned):** Adds `pgvector` 0.8+ (`halfvec` partial HNSW index per active `(model, dims)` + `hnsw.iterative_scan = 'relaxed_order'`), background async embedding fill, relative cosine distance gating, and RRF (`k = 60`) fusion — plugging into Core's `searchLane` hook with `embedder: off | remote | local` (optional `llama.cpp` sidecar running `EmbeddingGemma 2` / `Qwen3-Embedding`, matching `fxbot`). Ships in the single one-command PG image (`pgvector/pgvector:0.8.x-pg18-trixie`, PostgreSQL-licensed; zero AGPL conflict with Apache-2.0).
3. **Optional later plugins (only if benchmarks justify):** `knowledge-bm25` (Tiger Data's PostgreSQL-licensed `pg_textsearch` BM25 lane if `ts_rank_cd` lacks IDF discrimination at 100k+ chunks), `knowledge-ingest-pdf` (PDF/HTML extraction), `knowledge-contextual` (LLM contextual headers / hierarchical ToC summaries), `knowledge-graph` (citation/contradiction traversal).

---

## 2. Verified `v0.2` KB Postmortem

`v0.2`'s KB spans **67 TypeScript files / 11,580 LOC** (`wc -l`: `src/common/search`: 768; `src/control/store/kb` incl. PG dual-store: 5,591; `src/control/kb`: 2,595; `src/core/kb`: 1,412; `src/harness/kb`: 570; `src/harness/research/search`: 644). Direct inspection reveals five root-cause failure classes:

### 2.1 Synchronous Event-Loop Blocking & Multiplicative Query Fan-Out
- **Main-thread blocking:** `src/common/sqlite.ts:19` opens `new DatabaseSync(path)` synchronously on Node's event loop. `src/control/store/waits.ts:67-91` wraps calls in `Turns` Promises, which do not move work off-thread and **serialize every Control request behind any active write transaction** (`EventsApply.record` in `src/control/events/apply.ts:234-263`, `keepFileText` in `src/control/store/kb/files.ts:210-237`). Even the trial PG adapter hardcodes `max: 1` (`src/common/postgres.ts:88-90`).
- **Global un-scoped CTE materialization:** `rankedItems()` (`src/common/search/find.ts:135-140`) executes `WITH m AS MATERIALIZED (SELECT rowid AS pid, bm25(kb_words, 3.0, 2.0, 1.0) AS s FROM kb_words WHERE kb_words MATCH ?)` **before applying `WHERE ${scope.sql}`**. Forgiving queries expand up to 12 terms + `OUTCOME_WORDS` synonyms as `OR` chains (`src/common/search/query.ts:43-50`, `src/control/store/kb/query.ts:18-31`); multi-query RRF (up to 6 + `like`) repeats this global materialization up to 7× per search.
- **Per-search query explosion:** A single `kb_search` runs: (1) full-scope `GROUP BY 1,2,3,4,5` facet scan (`src/control/store/kb/search.ts:194-201`), (2) optional extra `itemsMatching()` (`search.ts:203-206`), (3) 1–7× `rankedItems()`, (4) up to **20 separate `itemsMatching()` queries** in `wordsOf()` (`find.ts:245-254`), (5) up to **3× `didYouMean()`** (`src/common/search/vocab.ts:135-165`), each spawning **ephemeral `:memory:` SQLite FTS5 databases** (`scratchWords()` in `passages.ts:140-145`) just to stem strings, scanning 1/26th of global `kb_words_terms`, and running up to 16 more FTS5/highlight queries, (6) re-running `MATCH ?` for `snippet()`/`highlight()` plus JS `passagesOf(body)` (`find.ts:274-303`), and (7) sequential N+1 `resultOf()` lookups (`src/control/kb/owner.ts:116-120`).
- **Measured stall:** Goal 175's own benchmark (`docs/plan/goals/_completed/175-knowledge-base.goal:124`) logged **119 ms p50 / 355 ms p95 per single probe at 100k items** — synchronously blocking Node. With `KB_ASKS_IN_FLIGHT_MAX = 32` per rig (`src/control/kb/asks.ts:177`), concurrent agents stall Control health checks (`/v1/health`) and trip `KB_ASK_TIMEOUT_MS` (20 s).
- **Interim PG search is worse:** `src/control/store/kb/postgres/search.ts:70-78, 176-210` uses unindexed `strpos(lower(title || ' ' || context || ' ' || body), ?) > 0` across **up to 23 full sequential table scans per search**.

### 2.2 Empty-Scope, Unscoped & Empty-Query Failure Modes
- **No O(1) empty-scope short-circuit:** `findItems()` (`src/control/store/kb/search.ts:187`) checks only `if (!where.length) return empty`. A newly started `fresh: true` run or empty collection passes `where = [{ campaign, run }]` (`where.length === 1`), triggering the **full global FTS5 materialization**, 20 `wordsOf` probes, and **worst-case `didYouMean`** (because all words have `items === 0` in that empty scope!).
- **Unscoped search & empty query (`q = ""`) scans:** When `collections` is omitted, `ownerKbSearch()` (`src/control/kb/owner.ts:102-108`) calls `kb.collections()` (full `kb_item` scan + 2N `readBy`/`reads` queries, `store/kb/index.ts:282-322`) and builds an N-way `OR` chain in `within()` (`search.ts:91-97`). When `q` is empty or all stopwords, `newest()` (`search.ts:227-264`) executes 3 full-scope scans + **`ORDER BY updated_at DESC` with NO index on `updated_at`** (`schema.ts:114-116`), sorting full multi-MB `SELECT i.*` rows on disk.
- **Root browse storm & empty-filter crash:** `ownerKbList` at root (`""`) runs `WHERE 1 = 1` across **13 full-table scans** (`listItems()` 7 scans in `src/control/store/kb/list.ts:123-159` + `placeTotals()` 6 scans incl. `SUM(LENGTH(CAST(v.body AS BLOB)))` over all historical `kb_version` rows in `list.ts:173-199`). In `src/harness/research/search/index.ts:196-198`, an empty `kinds` array interpolates `i.kind in ()` (SQL syntax crash).

### 2.3 Storage & Index Bloat + O(N²) Chunking Trap
- **4× text amplification:** (1) Raw file in `kb-files/<sha2>/<sha256>` (`control/kb/files.ts:78-80`); (2) extracted text up to **5 MB** (`KB_TEXT_LIMITS.chars = 5_000_000`, `control/kb/text/index.ts:27`) in `kb_file_text.text`; (3) **copied into `kb_item.body`** for *every* item referencing that SHA-256 (`store/kb/files.ts:231-236`, `items.ts:83`); (4) every lifecycle update (`run_status`, `verdict`, `experiment_edited`) writes a full uncompacted row to append-only `kb_version` (`items.ts:149-152`) and triggers `unindexItem` + `indexItem` (`items.ts:93, 146`). `followAttempt()` (`store/kb/words.ts:144-148`) additionally runs unindexed `json_extract(meta, '$.result') LIKE ...` inside the write transaction.
- **O(N²) UTF-8 `substr()` trap:** `kb_passage_text` (`src/common/search/passages.ts:56-59`) is a view executing `substr(i.body, p.start + 1, p.len)` per passage. A 5 MB extracted doc produces ~2,500 passages; SQLite walks UTF-8 from byte 0 for each row (~6.25 GB scanned per `indexItem`/`unindexItem`!). `sqlChars()` (`passages.ts:107-115`) is also O(N²) when text contains any surrogate pair/emoji.
- **Rig-side mirror:** `RunSearch.sync()` (`src/harness/research/search/index.ts:142-187`) duplicates every run's sources into `<state>/research-search/<run>.db` and diffs synchronously on every `search_research` / `search_corpus` call.

### 2.4 Grant/Scoping Ergonomics & Retrieval Quality Deficits
- **Rig-coupled & leaky scopes:** 6-column identity `unique(rig, ledger, run, slot, kind, ref)` (`schema.ts:106`) embeds deleted `rig`/`ledger` concepts. `kb_scope` (`scope.ts:29-36`) mixes a frozen `granted` JSON array with timestamp-based auto-inclusion (`granted_at > r.set_at`). `kb_grant`/`kb_revoke` hardcode owner-only walls (`src/control/mcp/kb.ts:238-293`), conflicting with `v1` policy delegation. No shared non-campaign collections exist.
- **Code & semantic blind spots:** `porter unicode61` (`passages.ts:19`) splits `snake_case` and strips symbols with no `pg_trgm` fallback; flat 2,000-char slicing (`passages.ts:24-28`) has **0 overlap** and drops Markdown/code structure; verbose fetched pages and compaction transcripts (`context_compacted`, `src/core/kb/records.ts:346`) are indexed at equal base weight alongside curated findings/verdicts — Goal 175's own benchmark (`175-knowledge-base.goal:124`) recorded Q8's P@10 dropping from `0.8` to `0.2` at 30k items specifically because passages of fetched pages holding all query words outranked notes holding one; `mode: exact` leaks raw SQLite FTS5 syntax (`query.ts:69-70`). Goal 175 rejected vectors only after testing a 32M static bag-of-words model inside a 1.3 GB / 3.44 GB-RAM `zvec-grep` wrapper — never a modern `pgvector` + `EmbeddingGemma 2` / `Qwen3-Embedding` pipeline.

---

## 3. Candidate `v1` Architectures Compared

| Dimension | **Option A: Lean PG Native FTS + `pg_trgm`** | **Option B: PG FTS + `pg_trgm` + `pgvector` HNSW (RRF)** *(Recommended: A in Core + B as default plugin)* | **Option C: BM25 (`pg_search` / `pg_textsearch` / Tantivy) + Vector / Tree Index** |
| :--- | :--- | :--- | :--- |
| **Stack & Install** | Stock `postgres:18` (0 extra services, built-in `pg_trgm`) | `pgvector/pgvector:0.8.x-pg18-trixie` + optional `llama.cpp` embed profile (`fxbot` pattern) or remote `/embeddings` | `pg_search` (**AGPLv3** — clashes w/ Apache-2.0) or `pg_textsearch` (PG-licensed, younger) or extra Tantivy container + LLM tree indexer |
| **Retrieval Effectiveness** | Strong exact/code/identifier match (`simple` + `pg_trgm`), good stemmed prose (`english`); weak on conceptual/synonym gaps & no corpus IDF in `ts_rank_cd` | **Best general balance:** exact code (`simple`/`pg_trgm`) + prose FTS + semantic recall fused via RRF (`k=60`) + relative distance gate; contextual heading prefix closes chunk-context gap | **Highest ceiling** on long-tail ranking (true BM25 IDF + Block-Max WAND) & multi-hop long-doc navigation (hierarchical ToC / LLM contextualization), at higher ingest cost |
| **Scoped Query Latency (100k chunks)** | **8–20 ms p95** (GIN + B-tree scope bitmap AND; O(1) empty-scope `<1 ms`) | **20–45 ms p95** (parallel FTS + `halfvec` HNSW w/ `iterative_scan = 'relaxed_order'`; local query embed ~8–15 ms on CPU / ~3 ms GPU) | **10–30 ms p95** (`pg_textsearch`/Tantivy BM25); +300–1500 ms if live LLM tree navigation is in query path |
| **Storage & RAM (100k chunks, ~200 MB raw text)** | **~320 MB disk / ~150 MB PG shared buffers** (zero duplicate blobs) | **~620 MB disk / ~380 MB RAM** (`halfvec(768)` ~150 MB + HNSW graph ~220 MB; optional CPU embedder ~450 MB RSS) | **~700 MB–1.2 GB disk / ~600 MB–1.5 GB RAM** (segment caches + HNSW/LLM sidecar) |
| **Operational Simplicity (1-cmd install)** | **10/10** — zero extra extensions or containers | **9/10** — 1-line PG image (`pgvector/pgvector:0.8.x-pg18-trixie`, bumping `fxbot`'s `0.8.7-pg17-trixie` family to PG 18); degrades seamlessly to Option A if embedder is off/down | **5–7/10** — custom PG build/extension packaging (`pg_textsearch`), AGPL review (`pg_search`), or second stateful engine to back up (Tantivy) |
| **Estimated LOC** | **~950 LOC** (Core schema, chunker, Sans-I/O planner, PG adapter, `core/api` actions) | **+~550 LOC** (`knowledge-semantic` plugin: embed worker, HNSW manager, RRF lane) | **+~900–1,800 LOC** (custom query compiler, sidecar sync/backup or LLM indexing pipeline) |

**Why Option A-in-Core + Option B-as-Plugin wins (with Option C left strictly as future plugins):**
- **Matches `fxbot`'s operational model:** One PostgreSQL 18 container (`pgvector/pgvector:0.8.x-pg18-trixie`, following `fxbot`'s `pgvector/pgvector:0.8.7-pg17-trixie` Trixie image family in `deploy/compose.yaml:43`, bumped from `pg17` to `pg18`), optional `embed` profile running `llama.cpp` (`EmbeddingGemma 2` Q8_0 on CPU or `Qwen3-Embedding-0.6B` on GPU), or any OpenAI-compatible remote `/v1/embeddings` endpoint — zero extra stateful databases to replicate or back up.
- **Fixes `fxbot`'s scale gap for Thermite:** `fxbot` (`packages/sdk/src/migrations/0005_memories.sql:28,36`) uses unindexed `vector` columns fine for ~5k personal memories. At 100k+ chunks, Thermite's `knowledge-semantic` plugin uses **per-`(model, dims)` partial HNSW indexes on `halfvec(D)`** (50% RAM/disk reduction) with **`pgvector` 0.8+ `hnsw.iterative_scan = 'relaxed_order'`** so narrow campaign/run filters never return short/empty top-K sets.
- **Honest about `ts_rank_cd` vs. BM25:** Native Postgres `ts_rank_cd` lacks corpus-wide IDF. Our benchmark plan (§6) tests whether `ts_rank_cd` + heading/authority weights + `pgvector` RRF already clears retrieval targets, and isolates `pg_textsearch` (PostgreSQL-licensed BM25) as a drop-in `searchLane` plugin only if lexical-only runs show measurable recall loss.

---

## 4. Core vs. Plugin Boundary (`fxbot` Thin-Core Rule)

Core owns **only** durable storage, scoped authorization, fast lexical/trigram retrieval, exact-quote lookup, and plugin hooks. Unused plugins add zero tables, timers, containers, or UI.

| Layer | Owns | Must NOT Own |
| :--- | :--- | :--- |
| **Core (`packages/core/src/kb` + `packages/control/src/kb`)** | Normalized collections/items/versions/chunks/links/grants/scopes; content-addressed blobs (SHA-256 on disk/object store, never duplicated into item rows); heading-aware parent-child chunker (UTF-8, overlap, Markdown/code-fence aware); dual `tsvector` (`simple` + `english`) + `pg_trgm`; O(1) empty-scope & fast exact-quote (`search_corpus`) lookup; Sans-I/O query parser (safe portable syntax: `"phrase"`, `-exclude`, `kind:`, `outcome:`) + RRF fusion; unified `core/api` actions (REST/MCP/CLI/UI); delegation-policy-checked grants. | Embedding models, vector tables, HNSW management, PDF/OCR parsers, LLM contextualizers, external search sidecars, hardcoded owner-only grant walls. |
| **`knowledge-semantic` *(first-party default plugin)*** | Plugin-owned `plugin_knowledge_semantic.chunk_embeddings` table + lazy partial `halfvec` HNSW index per `(model, dims)`; background async batch embedder (`local` / `remote` / `off` w/ model prefixes); `searchLane` hook returning cosine-gated candidates (`<= min + delta`) for Core RRF fusion. | Modifying Core tables or blocking Core ingestion/startup. |
| **`knowledge-ingest-pdf` *(plugin)*** | Isolated child-process PDF/HTML/DOCX text extraction registering via `registerExtractor(mimeTypes, fn)` (using `unpdf` or vendored PDF.js). | Blocking Control event loop or duplicating text into `kb_items`. |
| **`knowledge-bm25` *(optional plugin)*** | Registers a `pg_textsearch` BM25 `searchLane` (PostgreSQL-licensed) replacing or augmenting Core's `ts_rank_cd` leg if benchmarks show an IDF gap. | AGPL dependencies in default install. |
| **`knowledge-contextual` *(optional plugin)*** | Async `onItemIndexed` hook reading newly materialized `kb_chunks` to generate short LLM contextual headers (Anthropic Contextual Retrieval) and per-document hierarchical ToC summaries stored in plugin tables. | Synchronous LLM calls on the write path. |
| **`knowledge-graph` *(optional plugin)*** | Multi-hop citation/contradiction/lineage queries and graph UI view over Core's `kb_links`. | Core search hot path. |

### Minimal Schema & Interface Sketch

```sql
-- Core tables (no rig/ledger coupling; zero text duplication; parent-child chunks)
CREATE TABLE kb_collections (
  id text PRIMARY KEY,                     -- campaign slug or shared workspace collection (e.g. 'shared/cuda')
  kind text NOT NULL DEFAULT 'campaign',   -- 'campaign' | 'shared'
  item_count int NOT NULL DEFAULT 0,       -- maintained by trigger/tx for O(1) empty-scope short-circuit
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kb_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_id text NOT NULL REFERENCES kb_collections(id),
  run_id text,                             -- nullable for shared/owner items
  slot text NOT NULL,                      -- 'records' | 'owner' | 'planner' | 'worker-1' | ...
  kind text NOT NULL,                      -- 'experiment' | 'attempt' | 'finding' | 'source' | 'doc' | ...
  ref text NOT NULL,
  version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  outcome text,                            -- structured verdict/outcome (never parsed back from prose)
  authority smallint NOT NULL DEFAULT 50,  -- ranking prior: verdict/finding=100, note=70, source=40, compaction=15
  meta jsonb NOT NULL DEFAULT '{}',
  blob_sha256 text,                        -- content-addressed file ref (bytes & extracted text stored ONCE)
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (collection_id, run_id, slot, kind, ref)
);
CREATE INDEX kb_items_scope_updated ON kb_items (collection_id, updated_at DESC, id DESC);
CREATE INDEX kb_items_run_updated   ON kb_items (collection_id, run_id, updated_at DESC) WHERE run_id IS NOT NULL;
CREATE INDEX kb_items_facets        ON kb_items (collection_id, kind, outcome, slot);

-- Immutable version history (metadata + text pointer/delta; blobs stored once in kb_blobs)
CREATE TABLE kb_versions (
  item_id bigint NOT NULL REFERENCES kb_items(id),
  version int NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',           -- item's own short text ONLY (never copies 5 MB file text!)
  blob_sha256 text,
  meta jsonb NOT NULL DEFAULT '{}',
  by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, version)
);

-- Pre-materialized parent/child chunks (no O(N^2) substr view!)
CREATE TABLE kb_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES kb_items(id) ON DELETE CASCADE,
  collection_id text NOT NULL,             -- denormalized for single-table scoped GIN/HNSW filtering
  run_id text,
  chunk_no int NOT NULL,
  heading_path text NOT NULL DEFAULT '',   -- e.g. 'Architecture > KV Cache Layout' (structural context)
  char_start int NOT NULL,
  char_end int NOT NULL,
  content text NOT NULL,                   -- ~800-1,200 chars, ~150-char overlap, heading/fence-aware
  tsv_en tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading_path, '')), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) STORED,
  tsv_code tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', regexp_replace(heading_path || ' ' || content, '[/\\.:-]+', ' ', 'g'))
  ) STORED
);
CREATE INDEX kb_chunks_scope_item ON kb_chunks (collection_id, run_id, item_id);
CREATE INDEX kb_chunks_tsv_en     ON kb_chunks USING gin (tsv_en);
CREATE INDEX kb_chunks_tsv_code   ON kb_chunks USING gin (tsv_code);
CREATE INDEX kb_chunks_trgm       ON kb_chunks USING gin (content gin_trgm_ops); -- optional/tunable for code symbols

-- Remaining core tables referenced in prose omitted from this excerpt for brevity:
-- kb_blobs(sha256, bytes, mime, extracted_at), kb_links(item_id, version, rel, target_id), kb_grants, kb_run_scopes.

-- Plugin-owned table in its own schema (created ONLY when `knowledge-semantic` is enabled):
-- plugin_knowledge_semantic.chunk_embeddings(chunk_id bigint PK, collection_id text, run_id text, model text, dims int, vec halfvec)
-- + partial HNSW index: USING hnsw ((vec::halfvec(D)) halfvec_cosine_ops) WHERE model = $M AND dims = $D
```

```ts
// Core plugin extension points (packages/core/src/plugin/kb.ts — ~35 LOC)
export interface KbSearchLane {
  name: string;
  weight?: number; // RRF multiplier (default 1.0)
  search(q: KbCompiledQuery, scope: KbScopeFilter, limit: number, signal: AbortSignal): Promise<KbCandidate[]>;
}
export interface KbExtractor {
  mimeTypes: readonly string[];
  extract(blobPath: string, limits: KbExtractLimits, signal: AbortSignal): Promise<{ text: string; pages?: number; note?: string }>;
}
export interface KbPluginHooks {
  registerSearchLane(lane: KbSearchLane): void;
  registerExtractor(extractor: KbExtractor): void;
  onItemIndexed(handler: (ev: { itemId: number; collectionId: string; version: number }) => Promise<void>): void;
}
```

**Key architectural fixes baked into the schema:**
- **Zero O(N²) views & zero text duplication:** `kb_chunks.content` is written once asynchronously by a background indexer worker consuming the NATS `EVENTS` stream (item write + blob extraction events), never inside the synchronous event-apply transaction. `kb_items` holds no multi-MB `body` column at all, keeping `ORDER BY updated_at DESC` fast and cache-resident.
- **O(1) empty-scope short-circuit:** Before running any FTS, trigram, or vector query, check `kb_collections.item_count` (or a single B-tree `EXISTS (SELECT 1 FROM kb_items WHERE collection_id = $1 AND run_id = $2 LIMIT 1)` for `fresh` runs). If 0 rows exist in scope, return empty in **<1 ms** with zero index scans and zero embedder calls.
- **No `didYouMean` storm:** Drop synchronous per-word counts + `:memory:` SQLite Levenshtein on every query. Only on **0-hit non-empty scopes** run a single bounded `pg_trgm` suggestion query against a lightweight per-collection vocab or title index (optional flag `suggest: true`).
- **Explicit, policy-governed scopes:** Replace `kb_scope`'s leaky timestamp auto-join with explicit `kb_grants(grantee_collection, target_collection, granted_by, granted_at)` + `kb_run_scopes(run_id, own_run_only, collections text[])` evaluated cleanly via `collection_id = ANY($1)`. Delegation policy (not hardcoded role checks) governs who can grant/revoke.

---

## 5. Concrete Targets (Scale, Latency, Memory, Reliability)

| Metric | `v0.2` Observed / Structural | `v1` Core Target (Option A) | `v1` Hybrid Target (Core + `knowledge-semantic`) |
| :--- | :--- | :--- | :--- |
| **Scale envelope** | Stalls/bloats past ~30k–100k items | **100k+ items / 500k+ chunks** | **100k+ items / 500k+ chunks** |
| **Scoped query latency (p50 / p95)** | 119 ms / 355 ms (SQLite, 100k); seconds on PG `strpos` | **< 10 ms / < 20 ms** | **< 25 ms / < 50 ms** (incl. local embed or cached query vec) |
| **Empty-scope / fresh-run query** | Full global FTS5 + 3× `didYouMean` (~100–400 ms) | **< 1 ms (O(1) short-circuit)** | **< 1 ms (O(1) short-circuit, 0 embed calls)** |
| **Unscoped empty-query list (`q=""`)** | 13 full scans + unindexed `body` sort | **< 10 ms p95** (indexed `updated_at DESC`, lazy counts) | **< 10 ms p95** |
| **Control event-loop blocking** | 100% synchronous (`DatabaseSync` + `Turns` lock) | **0 ms** (pooled async PG `max >= 8`, NATS-queued indexing) | **0 ms** (background embed worker, 5 s query timeout fallback) |
| **Write-path ingest latency** | Sync full re-chunk + FTS5 rebuild inside event tx | **< 5 ms** (item metadata tx; chunking async < 200 ms) | **< 5 ms** (FTS ready < 200 ms; vectors async in batches of 32) |
| **Storage amplification (text)** | 3.5×–5× (blob + `kb_file_text` + N× `kb_item` + `kb_version`) | **<= 1.6×** (blob once + `kb_chunks` + GIN) | **<= 2.5×** (+ `halfvec(768)` ~1.5 KB/chunk + HNSW) |
| **Search RAM @ 100k chunks** | ~18 MB (FTS5 only) / 3.44 GB peak (`zvec-grep`) | **<= 150 MB** PG working set | **<= 380 MB** PG (`halfvec` HNSW) + optional ~450 MB CPU embedder |
| **Codebase footprint** | 67 files / 11,580 LOC | **<= 1,100 LOC** | **<= 1,700 LOC** total (Core + plugin) |

---

## 6. Reproducible Pre-Build Benchmark Plan

Before writing `v1` production KB code (Goal 1), run a **standalone 1-day benchmark script** against a local `pgvector/pgvector:0.8.x-pg18-trixie` container (and optionally `pg_textsearch` container) to validate all targets with real numbers:

1. **Synthetic + Realistic Corpus Generator (2 scales: 30k chunks & 150k chunks across 20 collections / 200 runs):**
   - Realistic mix mirroring Thermite runs: 35% experiments/attempts/verdicts, 25% agent notes/findings/decisions, 20% fetched web/paper docs (5 KB–200 KB Markdown/HTML), 10% code snippets/diffs/error logs, 10% verbose compaction transcripts (noise distractor class).
   - Plant **60 ground-truth needles** across 4 equal buckets (15 each):
     - **B1 — Code & Exact Identifiers:** `snake_case` kernels, hex addresses, CLI flags, compiler errors (`CUDA_ERROR_...`, `flash_attn_bwd`).
     - **B2 — Factual / Structured Research Needles:** specific metric deltas, verdicts, and claims hidden among 4 near-twin runs.
     - **B3 — Conceptual / Vocabulary-Gap Queries:** zero exact keyword overlap (e.g., query `"KV cache memory pressure"` -> needle `"attention state eviction threshold"`).
     - **B4 — Noise-Resistance Queries:** short high-signal findings/verdicts competing against 50 KB fetched pages and compaction logs containing all query terms.
2. **Systems Compared (same Postgres 18 host: 1 GB container RAM cap, 256 MB `shared_buffers`, 32 MB `work_mem`, 256 MB `maintenance_work_mem`):**
   - `A`: Core PG FTS (`english` + `simple`) + `pg_trgm` + authority prior.
   - `B-local`: `A` + `pgvector` 0.8 `halfvec(768)` HNSW (`m=16, ef_construction=64, iterative_scan='relaxed_order'`) + `EmbeddingGemma 2` Q8_0 (`llama.cpp` CPU) + RRF (`k=60`, `near=0.05`).
   - `C-bm25`: `pg_textsearch` BM25 + `pgvector` HNSW (tests whether true IDF meaningfully beats `ts_rank_cd` when paired with `pgvector` RRF).
3. **Stress & Failure-Mode Probes:**
   - **Scoped narrow filter:** campaign owning 0.5% of chunks (verifies `iterative_scan` recall vs. vanilla HNSW).
   - **Empty / fresh run scope:** 100 concurrent queries against a 0-item `fresh` run (must stay `< 1 ms` p95).
   - **Concurrent write + search:** 16 concurrent search clients while ingesting 100 items/sec + one 5 MB extracted document (verifies `0 ms` event-loop stall and `< 50 ms` p95 query tail).
4. **Go / No-Go Gates:**
   - Core (`A`) passes if B1 Recall@5 >= 95%, B2 Recall@10 >= 85%, scoped p95 `< 20 ms`, empty-scope p95 `< 1 ms`.
   - `knowledge-semantic` (`B-local`) earns default-on status if B3 Recall@10 improves by **>= +25 percentage points** over `A` with **zero regression** on B1/B4 and scoped p95 `< 50 ms`.
   - `knowledge-bm25` (`C-bm25`) stays deferred unless it beats `A`/`B-local` by **>= +8 percentage points** on B2/B4.

---

## 7. Open Owner Calls (4 Crisp Decisions)

1. **Default PG container image for `v1` one-command install:** Pin `pgvector/pgvector:0.8.x-pg18-trixie` from day one (same `pgvector/pgvector` Trixie image family as `fxbot`'s `0.8.7-pg17-trixie`, bumped to PG 18; enables `knowledge-semantic` with zero DB migration later) vs. stock `postgres:18-alpine` (requires image swap if user later enables semantic search)?  
   *Recommendation:* **`pgvector/pgvector:0.8.x-pg18-trixie` from day one** (zero runtime overhead when `vector` extension isn't enabled; aligns `v1` and `fxbot` on the same `pgvector/pgvector` Trixie family at PG 18).
2. **Default local embedder profile on install:** Follow `fxbot` (`embedder: local` with optional `llama.cpp` CPU `EmbeddingGemma 2` ~450 MB RAM, auto-fallback to FTS) vs. `embedder: off` by default until user enables `knowledge-semantic` (keeps base install ultra-light at Control + NATS + Postgres only)?  
   *Recommendation:* **Core ships FTS + `pg_trgm` (`embedder: off` by default on minimal install); one toggle or `--with-semantic` enables `knowledge-semantic` (`local` or `remote` provider).**
3. **Compaction transcripts in Knowledge search:** Index compaction logs with low authority (`authority = 15`), exclude them from default search unless `include_transcripts: true` (or `kinds: ['transcript']`), or keep them strictly in session history outside Knowledge?  
   *Recommendation:* **Exclude compaction transcripts from default search** (keep them readable/browsable by kind, never polluting default `kb_search` results).
4. **Shared non-campaign collections:** Allow first-class shared collections (e.g., `shared/hardware`, `shared/papers`) alongside campaign collections from day one, or defer until post-MVP?  
   *Recommendation:* **Support `kind: 'campaign' | 'shared'` in Core's schema from day one** (adds ~15 LOC, avoids v0.2's awkward cross-campaign grant contortions).
