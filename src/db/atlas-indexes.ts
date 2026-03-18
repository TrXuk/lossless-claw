import type { Collection, Db } from "mongodb";

/** LCM collection names used by the MongoDB stores */
const LCM_COLLECTIONS = [
  "conversations",
  "messages",
  "message_parts",
  "counters",
  "summary_messages",
  "summaries",
  "summary_parents",
  "context_items",
  "large_files",
  "audit_events",
] as const;

/**
 * Ensure the database and all LCM collections exist.
 * Creates collections if they do not exist (MongoDB creates the database implicitly).
 */
export async function ensureLcmDatabase(db: Db): Promise<void> {
  const existing = await db.listCollections().toArray();
  const existingNames = new Set(existing.map((c) => c.name));
  for (const name of LCM_COLLECTIONS) {
    if (existingNames.has(name)) continue;
    try {
      await db.createCollection(name);
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code !== 48) throw err; // 48 = NamespaceExists (race with another process)
    }
  }
}

export type AtlasIndexConfig = {
  searchIndexMessages: string;
  searchIndexSummaries: string;
  vectorSearchIndexMessages: string;
  vectorSearchIndexSummaries: string;
  /** When true, skip creating the messages vector index (summaries only) */
  vectorSearchSummariesOnly?: boolean;
};

/** Atlas Search (full-text) index definition for messages/summaries content */
function atlasSearchDefinition() {
  return {
    mappings: {
      dynamic: false,
      fields: {
        content: { type: "string" },
        conversationId: { type: "number" },
        createdAt: { type: "date" },
      },
    },
  };
}

/** Vector Search index with auto-embedding on content (Voyage AI) */
function vectorSearchDefinition() {
  return {
    fields: [
      { type: "text" as const, path: "content", model: "voyage-3.5" },
      { type: "filter" as const, path: "conversationId" },
      { type: "filter" as const, path: "createdAt" },
    ],
  };
}

/** Vector Search index for manual embeddings (content_embedding field) */
function vectorSearchDefinitionManual(numDimensions: number) {
  return {
    fields: [
      {
        type: "vector" as const,
        path: "content_embedding",
        numDimensions,
        similarity: "cosine" as const,
      },
      { type: "filter" as const, path: "conversationId" },
      { type: "filter" as const, path: "createdAt" },
    ],
  };
}

async function indexExists(collection: Collection, name: string): Promise<boolean> {
  const cursor = collection.listSearchIndexes();
  const indexes = await cursor.toArray();
  return indexes.some((idx: { name?: string }) => idx.name === name);
}

async function ensureSearchIndex(
  collection: Collection,
  name: string,
  definition: Record<string, unknown>,
): Promise<void> {
  if (await indexExists(collection, name)) return;
  await collection.createSearchIndex({ name, definition });
}

async function ensureVectorSearchIndex(
  collection: Collection,
  name: string,
  definition: Record<string, unknown>,
): Promise<void> {
  if (await indexExists(collection, name)) return;
  await collection.createSearchIndex({
    name,
    type: "vectorSearch",
    definition,
  });
}

/**
 * Ensure Atlas Search (full-text) and Vector Search (auto-embedding) indexes exist
 * on messages and summaries collections. Creates the database and collections if
 * they do not exist, then creates only indexes that are not present.
 */
export async function ensureAtlasIndexes(
  db: Db,
  config: AtlasIndexConfig,
): Promise<void> {
  await ensureLcmDatabase(db);
  const messages = db.collection("messages");
  const summaries = db.collection("summaries");

  const searchDef = atlasSearchDefinition();
  const vectorDef = vectorSearchDefinition();

  const indexPromises: Promise<void>[] = [
    ensureSearchIndex(messages, config.searchIndexMessages, searchDef),
    ensureSearchIndex(summaries, config.searchIndexSummaries, searchDef),
    ensureVectorSearchIndex(summaries, config.vectorSearchIndexSummaries, vectorDef),
  ];
  if (!config.vectorSearchSummariesOnly) {
    indexPromises.push(
      ensureVectorSearchIndex(messages, config.vectorSearchIndexMessages, vectorDef),
    );
  }
  await Promise.all(indexPromises);
}

/**
 * Ensure manual Vector Search indexes (content_embedding) and Atlas Search (full-text) indexes
 * exist on messages and summaries. Used when auto-embedding is not supported and voyageApiKey is set.
 */
export async function ensureManualVectorIndexes(
  db: Db,
  config: AtlasIndexConfig,
  numDimensions: number,
): Promise<void> {
  await ensureLcmDatabase(db);
  const messages = db.collection("messages");
  const summaries = db.collection("summaries");
  const searchDef = atlasSearchDefinition();
  const vectorDef = vectorSearchDefinitionManual(numDimensions);
  const indexPromises: Promise<void>[] = [
    ensureSearchIndex(messages, config.searchIndexMessages, searchDef),
    ensureSearchIndex(summaries, config.searchIndexSummaries, searchDef),
    ensureVectorSearchIndex(summaries, config.vectorSearchIndexSummaries, vectorDef),
  ];
  if (!config.vectorSearchSummariesOnly) {
    indexPromises.push(
      ensureVectorSearchIndex(messages, config.vectorSearchIndexMessages, vectorDef),
    );
  }
  await Promise.all(indexPromises);
}
