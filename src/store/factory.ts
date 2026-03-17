import type { DatabaseSync } from "node:sqlite";
import type { Db } from "mongodb";
import type { LcmConfig } from "../db/config.js";
import { ensureAtlasIndexes } from "../db/atlas-indexes.js";
import { getLcmConnection } from "../db/connection.js";
import { getLcmDbFeatures } from "../db/features.js";
import { getMongoDb } from "../db/mongodb-connection.js";
import type { ConversationStore } from "./conversation-store.js";
import { ConversationStore as ConversationStoreSqlite } from "./conversation-store.js";
import type { SummaryStore } from "./summary-store.js";
import { SummaryStore as SummaryStoreSqlite } from "./summary-store.js";
import { ConversationStoreMongoDB } from "./mongodb/conversation-store-mongodb.js";
import { SummaryStoreMongoDB } from "./mongodb/summary-store-mongodb.js";

export type CreateStoresResult = {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  /** For SQLite: the database handle. For MongoDB: undefined. */
  sqliteDb?: DatabaseSync;
  /** For MongoDB: the database. For SQLite: undefined. */
  mongoDb?: Db;
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
    if (config.autoCreateAtlasIndexes) {
      await ensureAtlasIndexes(db, {
        searchIndexMessages: config.searchIndexMessages,
        searchIndexSummaries: config.searchIndexSummaries,
        vectorSearchIndexMessages: config.vectorSearchIndexMessages,
        vectorSearchIndexSummaries: config.vectorSearchIndexSummaries,
      }).catch((err) => {
        console.warn(
          "[lossless-claw] autoCreateAtlasIndexes: failed to ensure indexes:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    return {
      conversationStore: new ConversationStoreMongoDB(db, {
        fts5Available,
        searchIndexMessages: config.searchIndexMessages,
        searchIndexSummaries: config.searchIndexSummaries,
        vectorSearchIndexMessages: config.vectorSearchIndexMessages,
        vectorSearchIndexSummaries: config.vectorSearchIndexSummaries,
      }),
      summaryStore: new SummaryStoreMongoDB(db, {
        fts5Available,
        searchIndexMessages: config.searchIndexMessages,
        searchIndexSummaries: config.searchIndexSummaries,
        vectorSearchIndexMessages: config.vectorSearchIndexMessages,
        vectorSearchIndexSummaries: config.vectorSearchIndexSummaries,
      }),
      mongoDb: db,
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
