import { homedir } from "os";
import { join } from "path";

export type StorageBackend = "sqlite" | "mongodb";

export type LcmConfig = {
  enabled: boolean;
  /** Storage backend: sqlite (default) or mongodb */
  storageBackend: StorageBackend;
  databasePath: string;
  /** MongoDB connection URI (used when storageBackend is mongodb) */
  mongodbUri: string;
  /** MongoDB database name (used when storageBackend is mongodb) */
  mongodbDatabase: string;
  /** Atlas Search (full-text) index name for messages (used when storageBackend is mongodb and mode is full_text/hybrid) */
  searchIndexMessages: string;
  /** Atlas Search (full-text) index name for summaries (used when storageBackend is mongodb and mode is full_text/hybrid) */
  searchIndexSummaries: string;
  /** Atlas Vector Search index name for messages (used when storageBackend is mongodb and mode is hybrid/semantic) */
  vectorSearchIndexMessages: string;
  /** Atlas Vector Search index name for summaries (used when storageBackend is mongodb and mode is hybrid/semantic) */
  vectorSearchIndexSummaries: string;
  /** When true, create Atlas Search and Vector Search indexes if not already present (MongoDB only) */
  autoCreateAtlasIndexes: boolean;
  /** When true, only create and use vector indexes for summaries (no messages vector index or embedding) */
  vectorSearchSummariesOnly: boolean;
  /** Atlas Model API key for manual embeddings when auto-embedding is not supported. See https://www.mongodb.com/docs/voyageai/management/api-keys/ */
  voyageApiKey: string;
  /** Voyage embedding model for manual embeddings (default: voyage-3-large) */
  voyageEmbeddingModel: string;
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  /** Provider override for large-file text summarization. */
  largeFileSummaryProvider: string;
  /** Model override for large-file text summarization. */
  largeFileSummaryModel: string;
  autocompactDisabled: boolean;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
};

/** Safely coerce an unknown value to a finite number, or return undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Safely coerce an unknown value to a boolean, or return undefined. */
function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Safely coerce an unknown value to a trimmed non-empty string, or return undefined. */
function toStr(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Resolve LCM configuration with three-tier precedence:
 *   1. Environment variables (highest — backward compat)
 *   2. Plugin config object (from plugins.entries.lossless-claw.config)
 *   3. Hardcoded defaults (lowest)
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  const pc = pluginConfig ?? {};

  const storageBackendRaw =
    env.LCM_STORAGE_BACKEND ?? toStr(pc.storageBackend) ?? toStr(pc.storage_backend) ?? "sqlite";
  const storageBackend: StorageBackend =
    storageBackendRaw === "mongodb" ? "mongodb" : "sqlite";

  return {
    enabled:
      env.LCM_ENABLED !== undefined
        ? env.LCM_ENABLED !== "false"
        : toBool(pc.enabled) ?? true,
    storageBackend,
    databasePath:
      env.LCM_DATABASE_PATH
      ?? toStr(pc.dbPath)
      ?? toStr(pc.databasePath)
      ?? join(homedir(), ".openclaw", "lcm.db"),
    mongodbUri:
      env.LCM_MONGODB_URI ?? toStr(pc.mongodbUri) ?? toStr(pc.mongodb_uri) ?? "",
    mongodbDatabase:
      env.LCM_MONGODB_DATABASE ?? toStr(pc.mongodbDatabase) ?? toStr(pc.mongodb_database) ?? "lcm",
    searchIndexMessages:
      env.LCM_SEARCH_INDEX_MESSAGES
      ?? toStr(pc.searchIndexMessages)
      ?? toStr(pc.search_index_messages)
      ?? "lcm_messages_search",
    searchIndexSummaries:
      env.LCM_SEARCH_INDEX_SUMMARIES
      ?? toStr(pc.searchIndexSummaries)
      ?? toStr(pc.search_index_summaries)
      ?? "lcm_summaries_search",
    vectorSearchIndexMessages:
      env.LCM_VECTOR_SEARCH_INDEX_MESSAGES
      ?? toStr(pc.vectorSearchIndexMessages)
      ?? toStr(pc.vector_search_index_messages)
      ?? "lcm_messages_vector",
    vectorSearchIndexSummaries:
      env.LCM_VECTOR_SEARCH_INDEX_SUMMARIES
      ?? toStr(pc.vectorSearchIndexSummaries)
      ?? toStr(pc.vector_search_index_summaries)
      ?? "lcm_summaries_vector",
    autoCreateAtlasIndexes:
      env.LCM_AUTO_CREATE_ATLAS_INDEXES !== undefined
        ? env.LCM_AUTO_CREATE_ATLAS_INDEXES === "true"
        : toBool(pc.autoCreateAtlasIndexes) ?? false,
    vectorSearchSummariesOnly:
      env.LCM_VECTOR_SEARCH_SUMMARIES_ONLY !== undefined
        ? env.LCM_VECTOR_SEARCH_SUMMARIES_ONLY === "true"
        : toBool(pc.vectorSearchSummariesOnly) ?? false,
    voyageApiKey:
      env.LCM_VOYAGE_API_KEY?.trim() ?? toStr(pc.voyageApiKey) ?? toStr(pc.voyage_api_key) ?? "",
    voyageEmbeddingModel:
      env.LCM_VOYAGE_EMBEDDING_MODEL?.trim()
      ?? toStr(pc.voyageEmbeddingModel)
      ?? toStr(pc.voyage_embedding_model)
      ?? "voyage-3-large",
    contextThreshold:
      (env.LCM_CONTEXT_THRESHOLD !== undefined ? parseFloat(env.LCM_CONTEXT_THRESHOLD) : undefined)
        ?? toNumber(pc.contextThreshold) ?? 0.75,
    freshTailCount:
      (env.LCM_FRESH_TAIL_COUNT !== undefined ? parseInt(env.LCM_FRESH_TAIL_COUNT, 10) : undefined)
        ?? toNumber(pc.freshTailCount) ?? 32,
    leafMinFanout:
      (env.LCM_LEAF_MIN_FANOUT !== undefined ? parseInt(env.LCM_LEAF_MIN_FANOUT, 10) : undefined)
        ?? toNumber(pc.leafMinFanout) ?? 8,
    condensedMinFanout:
      (env.LCM_CONDENSED_MIN_FANOUT !== undefined ? parseInt(env.LCM_CONDENSED_MIN_FANOUT, 10) : undefined)
        ?? toNumber(pc.condensedMinFanout) ?? 4,
    condensedMinFanoutHard:
      (env.LCM_CONDENSED_MIN_FANOUT_HARD !== undefined ? parseInt(env.LCM_CONDENSED_MIN_FANOUT_HARD, 10) : undefined)
        ?? toNumber(pc.condensedMinFanoutHard) ?? 2,
    incrementalMaxDepth:
      (env.LCM_INCREMENTAL_MAX_DEPTH !== undefined ? parseInt(env.LCM_INCREMENTAL_MAX_DEPTH, 10) : undefined)
        ?? toNumber(pc.incrementalMaxDepth) ?? 0,
    leafChunkTokens:
      (env.LCM_LEAF_CHUNK_TOKENS !== undefined ? parseInt(env.LCM_LEAF_CHUNK_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafChunkTokens) ?? 20000,
    leafTargetTokens:
      (env.LCM_LEAF_TARGET_TOKENS !== undefined ? parseInt(env.LCM_LEAF_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafTargetTokens) ?? 1200,
    condensedTargetTokens:
      (env.LCM_CONDENSED_TARGET_TOKENS !== undefined ? parseInt(env.LCM_CONDENSED_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.condensedTargetTokens) ?? 2000,
    maxExpandTokens:
      (env.LCM_MAX_EXPAND_TOKENS !== undefined ? parseInt(env.LCM_MAX_EXPAND_TOKENS, 10) : undefined)
        ?? toNumber(pc.maxExpandTokens) ?? 4000,
    largeFileTokenThreshold:
      (env.LCM_LARGE_FILE_TOKEN_THRESHOLD !== undefined ? parseInt(env.LCM_LARGE_FILE_TOKEN_THRESHOLD, 10) : undefined)
        ?? toNumber(pc.largeFileThresholdTokens)
        ?? toNumber(pc.largeFileTokenThreshold)
        ?? 25000,
    largeFileSummaryProvider:
      env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? toStr(pc.largeFileSummaryProvider) ?? "",
    largeFileSummaryModel:
      env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? toStr(pc.largeFileSummaryModel) ?? "",
    autocompactDisabled:
      env.LCM_AUTOCOMPACT_DISABLED !== undefined
        ? env.LCM_AUTOCOMPACT_DISABLED === "true"
        : toBool(pc.autocompactDisabled) ?? false,
    timezone: env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk:
      env.LCM_PRUNE_HEARTBEAT_OK !== undefined
        ? env.LCM_PRUNE_HEARTBEAT_OK === "true"
        : toBool(pc.pruneHeartbeatOk) ?? false,
  };
}
