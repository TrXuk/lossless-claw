import type { DatabaseSync } from "node:sqlite";
import type { Db } from "mongodb";
import type { AtlasIndexConfig } from "../db/atlas-indexes.js";
import { ensureAtlasIndexes, ensureManualVectorIndexes } from "../db/atlas-indexes.js";
import type { LcmConfig } from "../db/config.js";
import { getLcmConnection } from "../db/connection.js";
import { getLcmDbFeatures } from "../db/features.js";
import { getMongoDb } from "../db/mongodb-connection.js";
import { createVoyageAtlasEmbeddingService } from "../embeddings/voyage-atlas.js";
import { startEmbeddingChangeStream } from "../embeddings/embedding-change-stream.js";
import type { EmbeddingChangeStreamHandle } from "../embeddings/embedding-change-stream.js";
import type { ConversationStore } from "./conversation-store.js";
import { ConversationStore as ConversationStoreSqlite } from "./conversation-store.js";
import type { SummaryStore } from "./summary-store.js";
import { SummaryStore as SummaryStoreSqlite } from "./summary-store.js";
import { ConversationStoreMongoDB } from "./mongodb/conversation-store-mongodb.js";
import { SummaryStoreMongoDB } from "./mongodb/summary-store-mongodb.js";

function isAutoEmbedUnsupportedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("AutoEmbedding") ||
    msg.includes("autoEmbed") ||
    msg.includes("not supported")
  );
}

export type CreateStoresResult = {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  /** For SQLite: the database handle. For MongoDB: undefined. */
  sqliteDb?: DatabaseSync;
  /** For MongoDB: the database. For SQLite: undefined. */
  mongoDb?: Db;
  /** When manual embedding is used: handle to stop the Change Stream. */
  embeddingChangeStream?: EmbeddingChangeStreamHandle;
};

/**
 * Create conversation and summary stores based on config.
 * For SQLite: synchronous creation.
 * For MongoDB: requires async connection.
 */
export async function createStores(
  config: LcmConfig,
  options?: { fts5Available?: boolean },
): Promise<CreateStoresResult> {
  const fts5Available = options?.fts5Available ?? true;

  if (config.storageBackend === "mongodb") {
    if (!config.mongodbUri?.trim()) {
      throw new Error(
        "LCM_STORAGE_BACKEND=mongodb requires LCM_MONGODB_URI to be set.",
      );
    }
    const { db } = await getMongoDb(config.mongodbUri, config.mongodbDatabase);
    const indexConfig: AtlasIndexConfig = {
      searchIndexMessages: config.searchIndexMessages,
      searchIndexSummaries: config.searchIndexSummaries,
      vectorSearchIndexMessages: config.vectorSearchIndexMessages,
      vectorSearchIndexSummaries: config.vectorSearchIndexSummaries,
    };

    let embeddingService: ReturnType<typeof createVoyageAtlasEmbeddingService> | undefined;
    let embeddingMode: "auto" | "manual" = "auto";
    let embeddingChangeStream: EmbeddingChangeStreamHandle | undefined;

    if (config.autoCreateAtlasIndexes) {
      try {
        await ensureAtlasIndexes(db, indexConfig);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[lossless-claw] autoCreateAtlasIndexes: failed to ensure indexes:", msg);
        if (isAutoEmbedUnsupportedError(err) && config.voyageApiKey?.trim()) {
          embeddingMode = "manual";
          embeddingService = createVoyageAtlasEmbeddingService({
            apiKey: config.voyageApiKey,
            model: config.voyageEmbeddingModel,
          });
          const numDimensions = embeddingService.getModelDimensions();
          await ensureManualVectorIndexes(db, indexConfig, numDimensions);
          try {
            embeddingChangeStream = startEmbeddingChangeStream(db, {
              embeddingService,
              collections: ["messages", "summaries"],
            });
          } catch (streamErr) {
            console.warn(
              "[lossless-claw] Change stream not started (replica set required):",
              streamErr instanceof Error ? streamErr.message : String(streamErr),
            );
          }
        } else if (isAutoEmbedUnsupportedError(err) && !config.voyageApiKey?.trim()) {
          console.warn(
            "[lossless-claw] Auto-embedding not supported. Set voyageApiKey for manual embedding fallback.",
          );
        }
      }
    }

    const storeOptions = {
      fts5Available,
      searchIndexMessages: config.searchIndexMessages,
      searchIndexSummaries: config.searchIndexSummaries,
      vectorSearchIndexMessages: config.vectorSearchIndexMessages,
      vectorSearchIndexSummaries: config.vectorSearchIndexSummaries,
      embeddingService,
      embeddingMode,
    };

    return {
      conversationStore: new ConversationStoreMongoDB(db, storeOptions),
      summaryStore: new SummaryStoreMongoDB(db, storeOptions),
      mongoDb: db,
      embeddingChangeStream,
    };
  }

  const db = getLcmConnection(config.databasePath);
  const effectiveFts5 = options?.fts5Available ?? getLcmDbFeatures(db).fts5Available;
  return {
    conversationStore: new ConversationStoreSqlite(db, { fts5Available: effectiveFts5 }),
    summaryStore: new SummaryStoreSqlite(db, { fts5Available: effectiveFts5 }),
    sqliteDb: db,
  };
}
