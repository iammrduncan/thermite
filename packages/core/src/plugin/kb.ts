type Strs = readonly string[];
type Filters = { kinds?: Strs; outcomes?: Strs; slots?: Strs };
type Q1 = { raw: string; terms: Strs; phrases: Strs; excluded: Strs };
export type KbCompiledQuery = Q1 & { filters: Filters };
type Sc1 = { collectionIds: Strs; runId?: string };
export type KbScopeFilter = Sc1 & { ownRunOnly?: boolean; includeTranscripts?: boolean };
type C1 = { itemId: number; chunkId?: number; score: number };
export type KbCandidate = C1 & { snippet?: string; headingPath?: string };
type L1 = { maxChars: number; maxBytes?: number };
export type KbExtractLimits = L1 & { maxPages?: number; timeoutMs?: number };
export type KbItemIndexedEvent = { itemId: number; collectionId: string; version: number };

type Out = { text: string; pages?: number; note?: string };
export interface KbSearchLane {
  name: string;
  weight?: number;
  search(q: KbCompiledQuery, s: KbScopeFilter, n: number, sig: AbortSignal): Promise<KbCandidate[]>;
}
export interface KbExtractor {
  mimeTypes: Strs;
  extract(path: string, limits: KbExtractLimits, sig: AbortSignal): Promise<Out>;
}
export interface KbPluginHooks {
  registerSearchLane(lane: KbSearchLane): void;
  registerExtractor(extractor: KbExtractor): void;
  onItemIndexed(handler: (ev: KbItemIndexedEvent) => Promise<void>): void;
}
