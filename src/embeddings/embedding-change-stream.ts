/**
 * Change Stream processor for embedding new or changed documents.
 * Watches messages and summaries for inserts/updates where content_embedding is missing.
 * Requires MongoDB replica set for Change Streams.
 */

import type { Db } from "mongodb";
import type { VoyageAtlasEmbeddingService } from "./voyage-atlas.js";

export type EmbeddingChangeStreamOptions = {
  embeddingService: VoyageAtlasEmbeddingService;
  /** Collections to watch: "messages" | "summaries" */
  collections?: ("messages" | "summaries")[];
};

export type EmbeddingChangeStreamHandle = {
  stop(): Promise<void>;
};

/**
 * Start Change Streams on messages and summaries to embed documents that lack content_embedding.
 * Processes changes sequentially to avoid overwhelming the embedding API.
 */
export function startEmbeddingChangeStream(
  db: Db,
  options: EmbeddingChangeStreamOptions,
): EmbeddingChangeStreamHandle {
  const { embeddingService, collections = ["messages", "summaries"] } = options;
  const changeStreams: Array<{ close: () => Promise<void> }> = [];
  let stopped = false;

  async function processChange(
    collectionName: string,
    doc: { _id?: unknown; content?: string; content_embedding?: unknown },
  ): Promise<void> {
    if (stopped) return;
    const content = doc?.content;
    if (!content || typeof content !== "string" || !content.trim()) return;
    if (doc.content_embedding != null) return;

    try {
      const vector = await embeddingService.embedText(content);
      if (vector.length === 0) return;

      const coll = db.collection(collectionName);
      await coll.updateOne(
        { _id: doc._id },
        { $set: { content_embedding: vector } },
      );
    } catch (err) {
      console.warn(
        `[lossless-claw] Change stream: failed to embed ${collectionName} doc:`,
        err,
      );
    }
  }

  for (const name of collections) {
    const coll = db.collection(name);
    const stream = coll.watch(
      [
        { $match: { operationType: { $in: ["insert", "update"] } } },
      ],
      { fullDocument: "updateLookup" },
    );

    stream.on("change", (change) => {
      const doc = change.fullDocument ?? change.documentKey;
      if (!doc) return;
      const fullDoc = "fullDocument" in change ? change.fullDocument : doc;
      if (fullDoc && typeof fullDoc === "object") {
        processChange(name, fullDoc as { _id?: unknown; content?: string; content_embedding?: unknown }).catch(
          (err) => console.warn(`[lossless-claw] Change stream process error:`, err),
        );
      }
    });

    stream.on("error", (err) => {
      if (!stopped) {
        console.warn(`[lossless-claw] Change stream error on ${name}:`, err);
      }
    });

    changeStreams.push({
      close: () =>
        new Promise((resolve) => {
          stream.close(() => resolve());
        }),
    });
  }

  return {
    async stop() {
      stopped = true;
      await Promise.all(changeStreams.map((s) => s.close()));
    },
  };
}
